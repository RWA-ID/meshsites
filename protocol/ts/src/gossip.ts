/**
 * Gossip policy (M3): what a node does with one public MeshSites packet
 * (bitchat outer type 0x4D). Pure and clock-injected: no timers, no radio.
 * MeshSitesCore's Gossip.swift implements the same rules, and both must pass
 * protocol/vectors/gossip.json.
 *
 * For each packet the policy returns a verdict: relay it or not, whether it
 * counts against the sender, and what to send back. The caller (simulator
 * node, iOS service) owns transport, timers and the fetch state machine.
 *
 * Rules (decisions D4, SPEC §5):
 *  - Unknown version/sub-type: relay untouched, as an unpatched bitchat node would.
 *  - Malformed, a direct-only sub-type, or TTL above the sub-type's cap: drop, spam.
 *  - ANNOUNCE: at most one per sender per half announce interval.
 *  - WANT: deduped by reqId; per-sender token bucket. Packets whose bitchat
 *    signature could not be checked share one bucket, so rotating the claimed
 *    sender ID buys nothing.
 *  - NAME_RECORD: deduped by (name, seq); per-name token bucket; verified
 *    before relay; stale seq is dropped without blame (normal on a mesh).
 *  - HAVE: only consumed by its recipient; relayed otherwise.
 */
import { CID } from 'multiformats/cid';
import { bytesToHex } from '@noble/hashes/utils.js';
import { LIMITS } from './limits.ts';
import { verifyRecord, type RecordStatus } from './record.ts';
import { decodeMessage, MAX_ANNOUNCE_ENTRIES, type MeshMessage, TTL, WireError } from './wire.ts';

export interface Bucket {
  /** Tokens available at once. */
  burst: number;
  /** Milliseconds to earn one token back. */
  refillMs: number;
}

export interface GossipConfig {
  /** Answer WANTs and announce stored sites. */
  seeding: boolean;
  /** Has a peer-to-peer Wi-Fi radio (advertised in HAVE). */
  bulkCapable: boolean;
  announceIntervalMs: number;
  /** Don't re-broadcast the same name's record more often than this. */
  nameRebroadcastMs: number;
  want: Bucket;
  nameRecord: Bucket;
  /** reqId dedupe window. */
  seenReqMs: number;
  /** Forget ANNOUNCE sightings older than this. */
  heardMs: number;
}

export const DEFAULT_GOSSIP_CONFIG: GossipConfig = {
  seeding: true,
  bulkCapable: true,
  announceIntervalMs: 60_000,
  nameRebroadcastMs: 5_000,
  want: { burst: 8, refillMs: 2_000 },
  nameRecord: { burst: 4, refillMs: 5_000 },
  seenReqMs: 300_000,
  heardMs: 180_000,
};

/** Sub-type → highest TTL a packet may arrive with (the originator's TTL). */
export const TTL_CAP: Record<string, number> = { announce: TTL.announce, 'name-record': TTL.nameRecord, want: TTL.want, have: TTL.have };

export interface GossipPacket {
  /** 16 hex chars, the bitchat sender ID from the packet header. */
  sender: string;
  recipient?: string;
  ttl: number;
  payload: Uint8Array;
  /** The bitchat Ed25519 packet signature was checked against the sender's announced key. */
  authenticated: boolean;
}

export interface Outgoing {
  msg: MeshMessage;
  ttl: number;
  recipient?: string;
}

export type HaveMessage = Extract<MeshMessage, { t: 'have' }>;

export interface Verdict {
  relay: boolean;
  /** Stable reason code when the packet is dropped (see the vectors). */
  drop?: string;
  /** Counts against the sender. */
  spam: boolean;
  send: Outgoing[];
  /** A HAVE addressed to us. */
  have?: HaveMessage & { from: string };
  /** A NAME_RECORD was accepted. */
  name?: { name: string; root: string; status: RecordStatus };
}

export interface SiteSummary {
  root: CID;
  sizeBytes: number;
  blockCount: number;
  complete: boolean;
}

export interface StoredName {
  /** The exact signed JSON text, as received or published. Never re-serialised. */
  signed: string;
  seq: number;
  root: string;
  status: RecordStatus;
}

export class GossipPolicy {
  readonly cfg: GossipConfig;
  readonly self: string;
  readonly sites = new Map<string, SiteSummary>();
  readonly names = new Map<string, StoredName>();
  /** name → trusted signer (lowercase), learned online. */
  readonly signers = new Map<string, string>();
  /** root → peer → { hops, at }, from ANNOUNCEs. */
  readonly heard = new Map<string, Map<string, { hops: number; at: number }>>();
  /** peer → number of spam strikes. */
  readonly spam = new Map<string, number>();

  private seenReq = new Map<string, number>();
  private lastAnnounceFrom = new Map<string, number>();
  private lastNameBroadcast = new Map<string, number>();
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(self: string, cfg: Partial<GossipConfig> = {}) {
    this.self = self;
    this.cfg = { ...DEFAULT_GOSSIP_CONFIG, ...cfg };
  }

  trust(name: string, signer: string) {
    this.signers.set(name, signer.toLowerCase());
  }

  /** Add a record from a trusted source (publisher, gateway). Throws if it doesn't verify. */
  addRecord(signedText: string, nowSec: number): RecordStatus {
    const res = this.verify(signedText, nowSec);
    if (!res.ok) throw new Error(res.reason);
    return res.status;
  }

  /** The ANNOUNCE to broadcast now, if any (caller runs the timer). */
  announce(): Outgoing | undefined {
    if (!this.cfg.seeding) return undefined;
    const sites = [...this.sites.values()].filter((s) => s.complete).slice(-MAX_ANNOUNCE_ENTRIES);
    if (!sites.length) return undefined;
    return { msg: { t: 'announce', sites: sites.map((s) => ({ root: s.root, sizeBytes: s.sizeBytes, blockCount: s.blockCount })) }, ttl: TTL.announce };
  }

  receive(p: GossipPacket, now: number, nowSec: number): Verdict {
    const v: Verdict = { relay: true, spam: false, send: [] };
    const drop = (why: string, spam: boolean): Verdict => {
      v.relay = false;
      v.drop = why;
      v.spam = spam;
      if (spam) this.spam.set(p.sender, (this.spam.get(p.sender) ?? 0) + 1);
      return v;
    };

    let m: MeshMessage | null;
    try {
      m = decodeMessage(p.payload);
    } catch (e) {
      if (!(e instanceof WireError)) throw e;
      return drop('malformed', true);
    }
    if (!m) return v; // unknown version / sub-type: relay as bitchat would
    const cap = TTL_CAP[m.t];
    if (cap === undefined) return drop('not-public', true);
    if (p.ttl > cap) return drop('ttl-over-cap', true);
    this.prune(now);

    switch (m.t) {
      case 'announce': {
        const last = this.lastAnnounceFrom.get(p.sender);
        // Half the interval: tolerates delivery jitter and throttled timers, still stops a flood.
        if (last !== undefined && now - last < this.cfg.announceIntervalMs * 0.5) return drop('rate-limited', true);
        this.lastAnnounceFrom.set(p.sender, now);
        const hops = TTL.announce - p.ttl + 1;
        for (const s of m.sites) {
          const k = s.root.toString();
          const map = this.heard.get(k) ?? new Map();
          map.set(p.sender, { hops, at: now });
          this.heard.set(k, map);
        }
        return v;
      }

      case 'want': {
        const rk = bytesToHex(m.reqId);
        if (this.seenReq.has(rk)) return drop('duplicate', false);
        if (!this.take(`want:${p.authenticated ? p.sender : '*'}`, this.cfg.want, now)) return drop('rate-limited', true);
        this.seenReq.set(rk, now);
        // origTtl comes from the peer: clamp so a bogus value can't produce a nonsense hop count.
        const hops = Math.min(255, Math.max(1, m.origTtl - p.ttl + 1));
        if (m.root && this.cfg.seeding) {
          const s = this.sites.get(m.root.toString());
          if (s?.complete && s.sizeBytes <= LIMITS.maxSiteBytes) {
            v.send.push({
              msg: { t: 'have', reqId: m.reqId, root: s.root, hops, bulk: { p2pWifi: this.cfg.bulkCapable, ble: true }, sizeBytes: s.sizeBytes, blockCount: s.blockCount },
              // One hop of slack: the answer may take a different path back.
              ttl: Math.min(TTL.have, hops + 1),
              recipient: p.sender,
            });
          }
        } else if (m.name) {
          const n = this.names.get(m.name);
          const last = this.lastNameBroadcast.get(m.name);
          if (n && (last === undefined || now - last >= this.cfg.nameRebroadcastMs)) {
            this.lastNameBroadcast.set(m.name, now);
            v.send.push({ msg: { t: 'name-record', signed: n.signed }, ttl: TTL.nameRecord });
          }
        }
        return v;
      }

      case 'have': {
        if (p.recipient !== this.self) return v; // someone else's answer: relay
        v.relay = false;
        v.have = { ...m, from: p.sender };
        return v;
      }

      case 'name-record': {
        const head = peek(m.signed);
        if (!head) return drop('record:malformed', true);
        const cached = this.names.get(head.name);
        if (cached && cached.seq === head.seq && cached.signed === m.signed) return drop('duplicate', false);
        if (!this.take(`name:${head.name}`, this.cfg.nameRecord, now)) return drop('rate-limited', false);
        const res = this.verify(m.signed, nowSec);
        if (!res.ok) return drop(`record:${res.reason}`, res.reason !== 'stale-seq');
        v.name = { name: head.name, root: res.root, status: res.status };
        return v;
      }

      default:
        return drop('not-public', true);
    }
  }

  // ---------------- internals ----------------

  private verify(signedText: string, nowSec: number): { ok: true; status: RecordStatus; root: string } | { ok: false; reason: string } {
    let signed: unknown;
    try {
      signed = JSON.parse(signedText);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const head = peek(signedText);
    const res = verifyRecord(signed, {
      expectedSigner: head ? this.signers.get(head.name) : undefined,
      cachedSeq: head ? this.names.get(head.name)?.seq : undefined,
      now: nowSec,
    });
    if (!res.ok) return { ok: false, reason: res.reason };
    this.names.set(res.record.name, { signed: signedText, seq: res.record.seq, root: res.record.cid, status: res.status });
    return { ok: true, status: res.status, root: res.record.cid };
  }

  private take(key: string, b: Bucket, now: number): boolean {
    const s = this.buckets.get(key) ?? { tokens: b.burst, at: now };
    const tokens = Math.min(b.burst, s.tokens + (now - s.at) / b.refillMs);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    return true;
  }

  private prune(now: number) {
    for (const [k, at] of this.seenReq) {
      if (now - at < this.cfg.seenReqMs && this.seenReq.size <= 1000) break; // insertion order = age order
      this.seenReq.delete(k);
    }
    for (const [root, peers] of this.heard) {
      for (const [peer, h] of peers) if (now - h.at > this.cfg.heardMs) peers.delete(peer);
      if (!peers.size) this.heard.delete(root);
    }
    if (this.buckets.size > 4096) this.buckets.clear(); // memory bound; worst case grants a fresh burst
  }
}

/** name + seq from a signed record's text, without verifying it (cheap dedupe / bucket key). */
function peek(signedText: string): { name: string; seq: number } | undefined {
  try {
    const r = (JSON.parse(signedText) as { record?: { name?: unknown; seq?: unknown } })?.record;
    if (typeof r?.name !== 'string' || typeof r.seq !== 'number' || !r.name.length || r.name.length > 255) return undefined;
    return { name: r.name, seq: r.seq };
  } catch {
    return undefined;
  }
}
