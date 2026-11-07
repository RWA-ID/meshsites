/**
 * MeshSitesNode: the content layer that sits on a bitchat radio. Platform
 * neutral; the iOS app implements the same behaviour in Swift.
 *
 * Flows (HANDOFF §5): open by name → NAME_RECORD (cached, or WANT{name});
 * fetch by root → WANT{root}, collect HAVE for haveWindowMs, pick the closest
 * holder (bulk-capable neighbour first), pull blocks in batches of ≤ 32,
 * verify each block, fall back to the next holder on a bad/missing block.
 */
import { CID } from 'multiformats/cid';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkBlock, readCar, verifyDag, type BlockSource } from '../car.ts';
import { LIMITS } from '../limits.ts';
import { verifyRecord, type NameRecord, type RecordStatus, type SignedNameRecord } from '../record.ts';
import {
  decodeMessage,
  encodeMessage,
  MAX_ANNOUNCE_ENTRIES,
  MAX_BLOCK_REQ,
  type MeshMessage,
  SUB,
  subtypeOf,
  TTL,
  WireError,
} from '../wire.ts';
import { BITCHAT, type BitchatRadio, type LinkKind, messageId, type RadioApp, type SimPacket } from './radio.ts';
import type { Scheduler } from './scheduler.ts';

export interface NodeOptions {
  /** Serve and announce sites (opt-in on real devices; battery threshold at M6). */
  seeding: boolean;
  /** Has a peer-to-peer Wi-Fi radio. */
  bulkCapable: boolean;
  haveWindowMs: number;
  nameWaitMs: number;
  announceIntervalMs: number;
  /** Debug: corrupt one byte of every block served (a hostile peer). */
  corruptBlocks: boolean;
}

export const DEFAULT_NODE_OPTIONS: NodeOptions = {
  seeding: true,
  bulkCapable: true,
  haveWindowMs: 3000,
  nameWaitMs: 6000,
  announceIntervalMs: 60_000,
  corruptBlocks: false,
};

export interface SiteState {
  root: CID;
  sizeBytes: number;
  blockCount: number;
  complete: boolean;
}

export interface FetchStats {
  root: string;
  local: boolean;
  ms: number;
  blocks: number;
  bytes: number;
  /** Peers blocks came from, in order, with the link used. */
  sources: { peer: string; via: LinkKind; hops: number; blocks: number }[];
  corruptRejected: number;
  rewants: number;
  firstHaveMs?: number;
}

export interface OpenResult {
  root: string;
  name?: string;
  status: RecordStatus | 'raw-cid';
  record?: NameRecord;
  stats: FetchStats;
}

export type NodeEvent =
  | { kind: 'log'; node: string; msg: string }
  | { kind: 'progress'; node: string; root: string; blocks: number; bytes: number; expectedBlocks?: number }
  | { kind: 'site'; node: string; root: string; complete: boolean }
  | { kind: 'name'; node: string; name: string; root: string; status: RecordStatus };

const hex = (b: Uint8Array) => bytesToHex(b);

export class MeshSitesNode implements RadioApp, BlockSource {
  readonly opts: NodeOptions;
  readonly blocks = new Map<string, Uint8Array>();
  readonly sites = new Map<string, SiteState>();
  readonly names = new Map<string, { signed: SignedNameRecord; status: RecordStatus }>();
  /** name → trusted signer (learned online). */
  readonly signers = new Map<string, string>();
  /** root → peer → hops, from ANNOUNCEs. */
  readonly heard = new Map<string, Map<string, { hops: number; at: number }>>();
  readonly spam = new Map<string, number>();
  listeners: ((e: NodeEvent) => void)[] = [];

  private seenReq = new Map<string, number>();
  private lastAnnounceFrom = new Map<string, number>();
  private lastNameBroadcast = new Map<string, number>();
  private noRelay = new Set<string>();
  private pendingHave = new Map<string, (h: Extract<MeshMessage, { t: 'have' }> & { from: string }) => void>();
  private nameWaiters = new Map<string, (() => void)[]>();
  private inflight = new Map<string, Map<string, (b: Uint8Array | null) => void>>();
  private announceTimer?: number;

  readonly radio: BitchatRadio;
  private sched: Scheduler;
  private rand: () => number;
  constructor(radio: BitchatRadio, sched: Scheduler, rand: () => number, opts: Partial<NodeOptions> = {}) {
    this.radio = radio;
    this.sched = sched;
    this.rand = rand;
    this.opts = { ...DEFAULT_NODE_OPTIONS, ...opts };
    radio.app = this;
  }

  get id() {
    return this.radio.peerId;
  }

  private emit(e: NodeEvent) {
    for (const l of this.listeners) l(e);
  }
  private log(msg: string) {
    this.emit({ kind: 'log', node: this.radio.name, msg });
  }
  private flag(peer: string) {
    this.spam.set(peer, (this.spam.get(peer) ?? 0) + 1);
  }

  get(cid: CID) {
    return this.blocks.get(cid.toString());
  }

  // ---------------- local content ----------------

  /** Import a CAR (Files app / AirDrop / gateway). Verified before anything is stored. */
  async importCar(car: Uint8Array): Promise<SiteState> {
    const { root, blocks, errors } = await readCar(car);
    if (errors.length) throw new Error(errors.join('; '));
    const dag = verifyDag(root, { get: (c) => blocks.get(c.toString())?.bytes });
    if (!dag.ok) throw new Error([...dag.errors, ...dag.missing.map((m) => `${m}: missing block`)].join('; '));
    for (const k of blocks.keys()) if (!dag.reached.has(k)) throw new Error(`${k}: block not reachable from root`);
    for (const [k, b] of blocks) this.blocks.set(k, b.bytes);
    const site = { root, sizeBytes: dag.totalBytes, blockCount: blocks.size, complete: true };
    this.sites.set(root.toString(), site);
    this.emit({ kind: 'site', node: this.radio.name, root: root.toString(), complete: true });
    this.log(`imported ${root.toString().slice(0, 12)}… (${blocks.size} blocks, ${dag.totalBytes} B)`);
    this.scheduleAnnounce(50 + this.rand() * 200);
    return site;
  }

  /** Learn a trusted signer for a name (done while online: text record / owner). */
  trust(name: string, signer: string) {
    this.signers.set(name, signer.toLowerCase());
  }

  /** Add a signed record (gateway: from the meshsites.record text record). */
  addRecord(signed: SignedNameRecord): RecordStatus {
    const res = verifyRecord(signed, {
      expectedSigner: this.signers.get(signed.record.name),
      cachedSeq: this.names.get(signed.record.name)?.signed.record.seq,
      now: Math.floor(Date.now() / 1000),
    });
    if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);
    this.names.set(res.record.name, { signed, status: res.status });
    this.emit({ kind: 'name', node: this.radio.name, name: res.record.name, root: res.record.cid, status: res.status });
    return res.status;
  }

  // ---------------- gossip out ----------------

  private sendPublic(m: MeshMessage, ttl: number, recipient?: string) {
    const p: SimPacket = { type: BITCHAT.type.meshSites, sender: this.id, recipient, ttl, ts: this.radio.nextTs(), payload: encodeMessage(m) };
    this.radio.send(p);
  }

  private scheduleAnnounce(delayMs: number) {
    if (this.announceTimer !== undefined) return;
    this.announceTimer = this.sched.setTimeout(() => {
      this.announceTimer = undefined;
      this.announce();
      this.scheduleAnnounce(this.opts.announceIntervalMs);
    }, delayMs);
  }

  announce() {
    if (!this.opts.seeding) return;
    const sites = [...this.sites.values()].filter((s) => s.complete).slice(-MAX_ANNOUNCE_ENTRIES);
    if (!sites.length) return;
    this.sendPublic({ t: 'announce', sites: sites.map((s) => ({ root: s.root, sizeBytes: s.sizeBytes, blockCount: s.blockCount })) }, TTL.announce);
  }

  stop() {
    if (this.announceTimer !== undefined) this.sched.clearTimeout(this.announceTimer);
    this.announceTimer = undefined;
  }

  // ---------------- gossip in ----------------

  label(p: SimPacket): string {
    let payload = p.payload;
    if (p.type === BITCHAT.type.noiseEncrypted) {
      if (payload[0] !== BITCHAT.type.meshSites) return 'noise';
      payload = payload.subarray(1);
    } else if (p.type !== BITCHAT.type.meshSites) return `type 0x${p.type.toString(16)}`;
    return this.labelDirect(payload);
  }

  labelDirect(payload: Uint8Array): string {
    const sub = subtypeOf(payload);
    const names: Record<number, string> = {
      [SUB.announce]: 'ANNOUNCE',
      [SUB.nameRecord]: 'NAME_RECORD',
      [SUB.want]: 'WANT',
      [SUB.have]: 'HAVE',
      [SUB.blockReq]: 'BLOCK_REQ',
      [SUB.block]: 'BLOCK',
      [SUB.blockNone]: 'BLOCK_NONE',
    };
    return sub !== undefined ? (names[sub] ?? `sub 0x${sub.toString(16)}`) : '?';
  }

  shouldRelay(p: SimPacket): boolean {
    return !this.noRelay.has(messageId(p));
  }

  onPacket(p: SimPacket, from: string) {
    const id = messageId(p);
    const stop = (why?: string, spam = false) => {
      this.noRelay.add(id);
      if (this.noRelay.size > 2000) this.noRelay.delete(this.noRelay.values().next().value!);
      if (spam) this.flag(p.sender);
      if (why) this.log(`drop ${this.label(p)} from ${p.sender.slice(0, 4)}: ${why}`);
    };
    let m: MeshMessage | null;
    try {
      m = decodeMessage(p.payload);
    } catch (e) {
      return stop((e as WireError).message, true);
    }
    if (!m) return; // unknown version/sub-type: relay as bitchat would
    const cap = ({ announce: TTL.announce, 'name-record': TTL.nameRecord, want: TTL.want, have: TTL.have } as Record<string, number>)[m.t];
    if (cap === undefined) return stop(`${m.t} is not allowed on public gossip`, true);
    if (p.ttl > cap) return stop(`TTL ${p.ttl} above cap ${cap}`, true);
    const now = this.sched.now();

    switch (m.t) {
      case 'announce': {
        const last = this.lastAnnounceFrom.get(p.sender);
        // Half the interval: tolerates delivery jitter and throttled timers, still stops a flood.
        if (last !== undefined && now - last < this.opts.announceIntervalMs * 0.5) return stop('announce rate limit', true);
        this.lastAnnounceFrom.set(p.sender, now);
        const hops = TTL.announce - p.ttl + 1;
        for (const s of m.sites) {
          const k = s.root.toString();
          const map = this.heard.get(k) ?? new Map();
          map.set(p.sender, { hops, at: now });
          this.heard.set(k, map);
        }
        return;
      }
      case 'name-record': {
        let signed: SignedNameRecord;
        try {
          signed = JSON.parse(m.signed);
        } catch {
          return stop('record is not JSON', true);
        }
        const name = (signed as { record?: { name?: unknown } })?.record?.name;
        const cached = typeof name === 'string' ? this.names.get(name) : undefined;
        const res = verifyRecord(signed, {
          expectedSigner: typeof name === 'string' ? this.signers.get(name) : undefined,
          cachedSeq: cached?.signed.record.seq,
          now: Math.floor(Date.now() / 1000),
        });
        if (!res.ok) return stop(res.reason, res.reason !== 'stale-seq');
        this.names.set(res.record.name, { signed, status: res.status });
        this.emit({ kind: 'name', node: this.radio.name, name: res.record.name, root: res.record.cid, status: res.status });
        for (const w of this.nameWaiters.get(res.record.name) ?? []) w();
        this.nameWaiters.delete(res.record.name);
        return;
      }
      case 'want': {
        const rk = hex(m.reqId);
        if (this.seenReq.has(rk)) return stop();
        this.seenReq.set(rk, now);
        if (this.seenReq.size > 1000) this.seenReq.delete(this.seenReq.keys().next().value!);
        const hops = m.origTtl - p.ttl + 1;
        if (m.root && this.opts.seeding) {
          const s = this.sites.get(m.root.toString());
          if (s?.complete) {
            this.sendPublic(
              { t: 'have', reqId: m.reqId, root: s.root, hops, bulk: { p2pWifi: this.opts.bulkCapable, ble: true }, sizeBytes: s.sizeBytes, blockCount: s.blockCount },
              Math.min(TTL.have, hops + 1),
              p.sender,
            );
          }
        } else if (m.name) {
          const n = this.names.get(m.name);
          const last = this.lastNameBroadcast.get(m.name) ?? -Infinity;
          if (n && now - last > 5000) {
            this.lastNameBroadcast.set(m.name, now);
            this.sendPublic({ t: 'name-record', signed: JSON.stringify(n.signed) }, TTL.nameRecord);
          }
        }
        return;
      }
      case 'have': {
        if (p.recipient !== this.id) return;
        this.pendingHave.get(hex(m.reqId))?.({ ...m, from: p.sender });
        return;
      }
    }
  }

  // ---------------- direct sessions ----------------

  onDirect(peer: string, bytes: Uint8Array, via: LinkKind) {
    let m: MeshMessage | null;
    try {
      m = decodeMessage(bytes);
    } catch (e) {
      this.flag(peer);
      this.log(`bad direct message from ${peer.slice(0, 4)}: ${(e as Error).message}`);
      return;
    }
    if (!m) return;
    switch (m.t) {
      case 'block-req': {
        if (!this.opts.seeding) return;
        for (const c of m.cids) {
          let b = this.blocks.get(c.toString());
          if (b && this.opts.corruptBlocks) {
            b = b.slice();
            b[b.length >> 1] ^= 0xff;
          }
          this.radio.sendDirect(peer, encodeMessage(b ? { t: 'block', cid: c, bytes: b } : { t: 'block-none', cid: c }), via);
        }
        return;
      }
      case 'block':
      case 'block-none': {
        const waiting = this.inflight.get(peer);
        const k = m.cid.toString();
        const resolve = waiting?.get(k);
        if (!resolve) return; // unsolicited: ignore
        waiting!.delete(k);
        resolve(m.t === 'block' ? m.bytes : null);
        return;
      }
      default:
        this.flag(peer);
        this.log(`${m.t} is not allowed in a direct session`);
    }
  }

  // ---------------- fetching ----------------

  private reqId(): Uint8Array {
    const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) b[i] = Math.floor(this.rand() * 256);
    return b;
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => this.sched.setTimeout(r, ms));
  }

  /** Resolve a name to a verified (or unverified) record over the mesh. */
  async resolveName(name: string): Promise<{ record: NameRecord; status: RecordStatus }> {
    let n = this.names.get(name);
    if (!n) {
      const arrived = new Promise<void>((r) => this.nameWaiters.set(name, [...(this.nameWaiters.get(name) ?? []), r]));
      this.log(`WANT name ${name}`);
      this.sendPublic({ t: 'want', reqId: this.reqId(), origTtl: TTL.want, name }, TTL.want);
      await Promise.race([arrived, this.sleep(this.opts.nameWaitMs)]);
      n = this.names.get(name);
      if (!n) throw new Error(`no NAME_RECORD for ${name} within ${this.opts.nameWaitMs} ms`);
    }
    return { record: n.signed.record, status: n.status };
  }

  /** Open a name or a raw CID. */
  async open(target: string): Promise<OpenResult> {
    let root: string;
    let name: string | undefined;
    let status: OpenResult['status'] = 'raw-cid';
    let record: NameRecord | undefined;
    const t0 = this.sched.now();
    if (/^(bafy|bafk|Qm)/.test(target)) root = target;
    else {
      name = target;
      const r = await this.resolveName(target);
      root = r.record.cid;
      status = r.status;
      record = r.record;
    }
    const stats = await this.fetch(CID.parse(root));
    stats.ms = this.sched.now() - t0;
    return { root, name, status, record, stats };
  }

  async fetch(root: CID): Promise<FetchStats> {
    const t0 = this.sched.now();
    const k = root.toString();
    const stats: FetchStats = { root: k, local: false, ms: 0, blocks: 0, bytes: 0, sources: [], corruptRejected: 0, rewants: 0 };
    if (this.sites.get(k)?.complete) return { ...stats, local: true };
    const bad = new Set<string>();

    for (let attempt = 0; attempt < 2; attempt++) {
      const haves: (Extract<MeshMessage, { t: 'have' }> & { from: string })[] = [];
      const reqId = this.reqId();
      this.pendingHave.set(hex(reqId), (h) => {
        if (stats.firstHaveMs === undefined) stats.firstHaveMs = this.sched.now() - t0;
        haves.push(h);
      });
      this.log(`WANT ${k.slice(0, 12)}…${attempt ? ' (retry)' : ''}`);
      this.sendPublic({ t: 'want', reqId, origTtl: TTL.want, root }, TTL.want);
      await this.sleep(this.opts.haveWindowMs);
      this.pendingHave.delete(hex(reqId));

      const candidates = haves
        .filter((h) => h.root.equals(root) && h.sizeBytes <= LIMITS.maxSiteBytes && !bad.has(h.from))
        .map((h) => {
          const bulk = h.hops === 1 && h.bulk.p2pWifi && this.opts.bulkCapable && this.radio.hasBulk(h.from);
          return { ...h, via: (bulk ? 'bulk' : 'ble') as LinkKind, score: (bulk ? 0 : 100) + h.hops };
        })
        .sort((a, b) => a.score - b.score)
        .filter((h, i, all) => all.findIndex((x) => x.from === h.from) === i);
      this.log(`${haves.length} HAVE(s): ${candidates.map((c) => `${c.from.slice(0, 4)} ${c.hops}h ${c.via}`).join(', ') || 'none usable'}`);

      for (const c of candidates) {
        const src = { peer: c.from, via: c.via, hops: c.hops, blocks: 0 };
        stats.sources.push(src);
        const ok = await this.pullFrom(root, c.from, c.via, c.hops, c.blockCount, stats, src);
        if (ok) {
          const s = this.sites.get(k)!;
          s.complete = true;
          stats.ms = this.sched.now() - t0;
          this.emit({ kind: 'site', node: this.radio.name, root: k, complete: true });
          this.log(`site ${k.slice(0, 12)}… complete: ${stats.blocks} blocks, ${stats.bytes} B in ${Math.round(stats.ms)} ms`);
          this.scheduleAnnounce(100 + this.rand() * 400);
          return stats;
        }
        bad.add(c.from);
      }
      stats.rewants++;
    }
    throw new Error(`could not fetch ${k}: no holder delivered a valid DAG`);
  }

  /** Pull the whole DAG from one peer. Returns false if the peer failed (caller tries the next). */
  private async pullFrom(
    root: CID,
    peer: string,
    via: LinkKind,
    hops: number,
    expectedBlocks: number,
    stats: FetchStats,
    src: { blocks: number },
  ): Promise<boolean> {
    const k = root.toString();
    for (;;) {
      const dag = verifyDag(root, this);
      if (dag.errors.length) {
        this.log(`DAG rejected: ${dag.errors[0]}`);
        throw new Error(dag.errors.join('; '));
      }
      if (!this.sites.has(k)) this.sites.set(k, { root, sizeBytes: 0, blockCount: 0, complete: false });
      const site = this.sites.get(k)!;
      site.sizeBytes = dag.totalBytes;
      site.blockCount = dag.reached.size - dag.missing.length;
      if (dag.ok) return true;
      if (dag.reached.size > 0xffff) throw new Error('too many blocks');

      const batch = dag.missing.slice(0, MAX_BLOCK_REQ);
      const waiting = this.inflight.get(peer) ?? new Map();
      this.inflight.set(peer, waiting);
      const results = batch.map((c) => new Promise<Uint8Array | null>((r) => waiting.set(c.toString(), r)));
      this.radio.sendDirect(peer, encodeMessage({ t: 'block-req', root, cids: batch }), via);

      // Generous timeout: BLE ~18 KB/s per hop, bulk ~2 MB/s.
      const est = via === 'bulk' ? (batch.length * 16384) / 1000 : (batch.length * 16384 * hops) / 12;
      const timeout = 4000 + est;
      let timedOut = false;
      const timer = this.sched.setTimeout(() => {
        timedOut = true;
        for (const c of batch) waiting.get(c.toString())?.(null);
      }, timeout);

      let failed = false;
      for (let i = 0; i < batch.length; i++) {
        const bytes = await results[i];
        const cid = batch[i];
        if (failed) continue;
        if (!bytes) {
          this.log(`${peer.slice(0, 4)}: ${timedOut ? 'timeout' : 'BLOCK_NONE'} for ${cid.toString().slice(0, 12)}…`);
          failed = true;
          continue;
        }
        const err = checkBlock(cid, bytes);
        if (err) {
          stats.corruptRejected++;
          this.flag(peer);
          this.log(`REJECTED block from ${peer.slice(0, 4)}: ${err.replace(/^\S+: /, '')}; trying another peer`);
          failed = true;
          continue;
        }
        this.blocks.set(cid.toString(), bytes);
        stats.blocks++;
        stats.bytes += bytes.length;
        src.blocks++;
        this.emit({ kind: 'progress', node: this.radio.name, root: k, blocks: stats.blocks, bytes: stats.bytes, expectedBlocks });
      }
      this.sched.clearTimeout(timer);
      for (const c of batch) waiting.delete(c.toString());
      if (failed) return false;
    }
  }
}
