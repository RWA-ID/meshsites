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
import { readCar, verifyDag, type BlockSource } from '../car.ts';
import { Fetcher, type FetchAction, type Holder, rankHolders, Server } from '../fetch.ts';
import { GossipPolicy, type Outgoing, type StoredName } from '../gossip.ts';
import { type NameRecord, type RecordStatus, type SignedNameRecord } from '../record.ts';
import { encodeMessage, type MeshMessage, SUB, subtypeOf, TTL } from '../wire.ts';
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
  /** Gossip rules shared with the iOS app (protocol/vectors/gossip.json). */
  readonly gossip: GossipPolicy;
  listeners: ((e: NodeEvent) => void)[] = [];

  private noRelay = new Set<string>();
  private pendingHave = new Map<string, (h: Extract<MeshMessage, { t: 'have' }> & { from: string }) => void>();
  private nameWaiters = new Map<string, (() => void)[]>();
  private server: Server;
  private drivers = new Set<(peer: string, cid: CID, bytes: Uint8Array | null) => void>();
  private announceTimer?: number;

  readonly radio: BitchatRadio;
  private sched: Scheduler;
  private rand: () => number;
  constructor(radio: BitchatRadio, sched: Scheduler, rand: () => number, opts: Partial<NodeOptions> = {}) {
    this.radio = radio;
    this.sched = sched;
    this.rand = rand;
    this.opts = { ...DEFAULT_NODE_OPTIONS, ...opts };
    this.gossip = new GossipPolicy(radio.peerId, {
      seeding: this.opts.seeding,
      bulkCapable: this.opts.bulkCapable,
      announceIntervalMs: this.opts.announceIntervalMs,
    });
    this.server = new Server({ seeding: this.opts.seeding });
    radio.app = this;
  }

  get sites(): Map<string, SiteState> {
    return this.gossip.sites;
  }
  get names(): Map<string, StoredName> {
    return this.gossip.names;
  }
  get signers(): Map<string, string> {
    return this.gossip.signers;
  }
  get heard() {
    return this.gossip.heard;
  }
  get spam() {
    return this.gossip.spam;
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
    this.gossip.spam.set(peer, (this.gossip.spam.get(peer) ?? 0) + 1);
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
    this.gossip.trust(name, signer);
  }

  /** Add a signed record (gateway: from the meshsites.record text record). */
  addRecord(signed: SignedNameRecord | string): RecordStatus {
    const text = typeof signed === 'string' ? signed : JSON.stringify(signed);
    const status = this.gossip.addRecord(text, Math.floor(Date.now() / 1000));
    const n = [...this.gossip.names.entries()].find(([, v]) => v.signed === text);
    if (n) this.emit({ kind: 'name', node: this.radio.name, name: n[0], root: n[1].root, status });
    return status;
  }

  // ---------------- gossip out ----------------

  private sendOut(o: Outgoing) {
    this.sendPublic(o.msg, o.ttl, o.recipient);
  }

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
    const o = this.gossip.announce();
    if (o) this.sendOut(o);
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

  onPacket(p: SimPacket, _from: string) {
    // The simulator has no packet signatures; every sender counts as authenticated.
    const v = this.gossip.receive({ sender: p.sender, recipient: p.recipient, ttl: p.ttl, payload: p.payload, authenticated: true }, this.sched.now(), Math.floor(Date.now() / 1000));
    if (!v.relay) {
      const id = messageId(p);
      this.noRelay.add(id);
      if (this.noRelay.size > 2000) this.noRelay.delete(this.noRelay.values().next().value!);
    }
    if (v.drop && v.drop !== 'duplicate') this.log(`drop ${this.label(p)} from ${p.sender.slice(0, 4)}: ${v.drop}`);
    for (const o of v.send) this.sendOut(o);
    if (v.have) this.pendingHave.get(hex(v.have.reqId))?.(v.have);
    if (v.name) {
      this.emit({ kind: 'name', node: this.radio.name, name: v.name.name, root: v.name.root, status: v.name.status });
      for (const w of this.nameWaiters.get(v.name.name) ?? []) w();
      this.nameWaiters.delete(v.name.name);
    }
  }

  // ---------------- direct sessions ----------------

  onDirect(peer: string, bytes: Uint8Array, via: LinkKind) {
    const lookup = (root: CID, cid: CID) => {
      if (!this.sites.get(root.toString())?.complete) return undefined;
      let b = this.blocks.get(cid.toString());
      if (b && this.opts.corruptBlocks) {
        b = b.slice();
        b[b.length >> 1] ^= 0xff;
      }
      return b;
    };
    const v = this.server.handle(peer, bytes, this.sched.now(), lookup);
    switch (v.kind) {
      case 'reply':
        for (const m of v.messages) this.radio.sendDirect(peer, encodeMessage(m), via);
        return;
      case 'block':
      case 'block-none':
        for (const d of this.drivers) d(peer, v.cid, v.kind === 'block' ? v.bytes : null);
        return;
      case 'drop':
        if (v.spam) {
          this.flag(peer);
          this.log(`bad direct message from ${peer.slice(0, 4)}: ${v.reason}`);
        }
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
    return { record: (JSON.parse(n.signed) as SignedNameRecord).record, status: n.status };
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

      const holders: Holder[] = haves
        .filter((h) => h.root.equals(root) && !bad.has(h.from))
        .map((h) => ({
          peer: h.from,
          via: h.hops === 1 && h.bulk.p2pWifi && this.opts.bulkCapable && this.radio.hasBulk(h.from) ? 'bulk' : 'ble',
          hops: h.hops,
          sizeBytes: h.sizeBytes,
          blockCount: h.blockCount,
        }));
      const ranked = rankHolders(holders);
      this.log(`${haves.length} HAVE(s): ${ranked.map((c) => `${c.peer.slice(0, 4)} ${c.hops}h ${c.via}`).join(', ') || 'none usable'}`);

      if (ranked.length && (await this.pull(root, ranked, stats, bad))) {
        const s = this.sites.get(k)!;
        s.complete = true;
        stats.ms = this.sched.now() - t0;
        this.emit({ kind: 'site', node: this.radio.name, root: k, complete: true });
        this.log(`site ${k.slice(0, 12)}… complete: ${stats.blocks} blocks, ${stats.bytes} B in ${Math.round(stats.ms)} ms`);
        this.scheduleAnnounce(100 + this.rand() * 400);
        return stats;
      }
      stats.rewants++;
    }
    throw new Error(`could not fetch ${k}: no holder delivered a valid DAG`);
  }

  /** Drive one shared-policy Fetcher (fetch.ts) over the radio. Resolves true when the DAG is complete. */
  private pull(root: CID, holders: Holder[], stats: FetchStats, bad: Set<string>): Promise<boolean> {
    const k = root.toString();
    return new Promise((resolve) => {
      const f = new Fetcher(root, holders, this);
      let timer: number | undefined;
      let src: FetchStats['sources'][number] | undefined;
      const finish = (ok: boolean) => {
        if (timer !== undefined) this.sched.clearTimeout(timer);
        this.drivers.delete(driver);
        resolve(ok);
      };
      const run = (actions: FetchAction[]) => {
        for (const x of actions) {
          switch (x.a) {
            case 'request': {
              if (src?.peer !== x.peer) {
                src = { peer: x.peer, via: x.via, hops: f.current!.hops, blocks: 0 };
                stats.sources.push(src);
              }
              this.radio.sendDirect(x.peer, encodeMessage({ t: 'block-req', root: x.root, cids: x.cids }), x.via);
              if (timer !== undefined) this.sched.clearTimeout(timer);
              timer = this.sched.setTimeout(() => run(f.tick(this.sched.now())), Math.max(0, x.deadline - this.sched.now()));
              break;
            }
            case 'stored': {
              this.blocks.set(x.cid.toString(), x.bytes);
              if (!this.sites.has(k)) this.sites.set(k, { root, sizeBytes: 0, blockCount: 0, complete: false });
              const site = this.sites.get(k)!;
              site.sizeBytes += x.bytes.length;
              site.blockCount++;
              stats.blocks++;
              stats.bytes += x.bytes.length;
              if (src) src.blocks++;
              this.emit({ kind: 'progress', node: this.radio.name, root: k, blocks: stats.blocks, bytes: stats.bytes, expectedBlocks: f.current?.blockCount });
              break;
            }
            case 'blame':
              stats.corruptRejected++;
              this.flag(x.peer);
              this.log(`REJECTED block from ${x.peer.slice(0, 4)}: ${x.reason}; trying another peer`);
              break;
            case 'next':
              bad.add(x.from);
              this.log(`${x.from.slice(0, 4)}: ${x.reason}`);
              break;
            case 'done': {
              const site = this.sites.get(k);
              if (site) {
                site.sizeBytes = x.totalBytes;
                site.blockCount = x.blockCount;
              } else this.sites.set(k, { root, sizeBytes: x.totalBytes, blockCount: x.blockCount, complete: false });
              finish(true);
              return;
            }
            case 'failed':
              this.log(`fetch failed: ${x.reason}`);
              finish(false);
              return;
          }
        }
      };
      const driver = (peer: string, cid: CID, bytes: Uint8Array | null) =>
        run(bytes ? f.onBlock(peer, cid, bytes, this.sched.now()) : f.onBlockNone(peer, cid, this.sched.now()));
      this.drivers.add(driver);
      run(f.start(this.sched.now()));
    });
  }
}
