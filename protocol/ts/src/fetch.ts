/**
 * Block transfer policy (M4). Pure and clock-injected, like gossip.ts:
 *
 *  - `Fetcher` pulls one site from the holders found by WANT/HAVE: batches of
 *    ≤ 32 BLOCK_REQ CIDs from the DAG frontier, every block hash-checked on
 *    arrival, the next holder on a corrupt block (blamed), BLOCK_NONE or a
 *    timeout (not blamed).
 *  - `Server` answers BLOCK_REQ inside a direct (Noise / bulk) session, only
 *    from the requested site, rate-limited per peer.
 *
 * MeshSitesCore's Fetch.swift implements the same rules; both must pass
 * protocol/vectors/fetch.json.
 */
import { CID } from 'multiformats/cid';
import { checkBlock, verifyDag, type BlockSource } from './car.ts';
import type { Bucket } from './gossip.ts';
import { LIMITS } from './limits.ts';
import { decodeMessage, MAX_BLOCK_REQ, type MeshMessage, WireError } from './wire.ts';

export type Via = 'ble' | 'bulk';

export interface Holder {
  peer: string;
  via: Via;
  hops: number;
  sizeBytes: number;
  blockCount: number;
}

export type FetchAction =
  | { a: 'request'; peer: string; via: Via; root: CID; cids: CID[]; deadline: number }
  | { a: 'stored'; cid: CID; bytes: Uint8Array }
  | { a: 'blame'; peer: string; reason: string }
  | { a: 'next'; from: string; reason: string }
  | { a: 'done'; totalBytes: number; blockCount: number }
  | { a: 'failed'; reason: string; detail?: string };

/** Extra time for the first batch to a holder: the direct session (Noise handshake) may not exist yet. */
export const SESSION_SETUP_MS = 10_000;

/**
 * Per-batch time budget: BLE ~12 KB/s per hop (half duplex), bulk ~1 MB/s,
 * plus 4 s slack, plus SESSION_SETUP_MS for the first batch to a holder.
 */
export function batchDeadline(now: number, h: Pick<Holder, 'via' | 'hops'>, n: number, firstToHolder = false): number {
  const est = h.via === 'bulk' ? (n * 16384) / 1000 : (n * 16384 * Math.max(1, h.hops)) / 12;
  return now + 4000 + Math.round(est) + (firstToHolder ? SESSION_SETUP_MS : 0);
}

/** Usable holders, best first: an adjacent bulk link, then fewest hops; one entry per peer. */
export function rankHolders(holders: Holder[]): Holder[] {
  const score = (h: Holder) => (h.via === 'bulk' && h.hops === 1 ? 0 : 100) + h.hops;
  return holders
    .filter((h) => h.sizeBytes <= LIMITS.maxSiteBytes && h.hops >= 1)
    .map((h, i) => ({ h, i }))
    .sort((x, y) => score(x.h) - score(y.h) || x.i - y.i)
    .map((x) => x.h)
    .filter((h, i, all) => all.findIndex((o) => o.peer === h.peer) === i);
}

export class Fetcher implements BlockSource {
  readonly root: CID;
  readonly holders: Holder[];
  state: 'idle' | 'running' | 'done' | 'failed' = 'idle';
  /** Blocks received and verified in this fetch. */
  readonly received = new Map<string, Uint8Array>();
  readonly stats = { blocks: 0, bytes: 0, corrupt: 0, switches: 0 };

  private local: BlockSource;
  private idx = 0;
  private batch: string[] = [];
  private answered = new Set<string>();
  private deadline = 0;
  /** Index of the holder that has already been sent a batch. */
  private asked = -1;

  constructor(root: CID, holders: Holder[], local: BlockSource = { get: () => undefined }) {
    this.root = root;
    this.holders = rankHolders(holders);
    this.local = local;
  }

  get(cid: CID): Uint8Array | undefined {
    return this.received.get(cid.toString()) ?? this.local.get(cid);
  }

  get current(): Holder | undefined {
    return this.holders[this.idx];
  }

  start(now: number): FetchAction[] {
    if (this.state !== 'idle') return [];
    this.state = 'running';
    return this.advance(now);
  }

  onBlock(peer: string, cid: CID, bytes: Uint8Array, now: number): FetchAction[] {
    const k = cid.toString();
    if (!this.expects(peer, k)) return []; // unsolicited or late: ignore
    const err = checkBlock(cid, bytes);
    if (err) {
      this.stats.corrupt++;
      return [{ a: 'blame', peer, reason: 'corrupt-block' }, ...this.failover(now, 'corrupt-block')];
    }
    this.answered.add(k);
    this.received.set(k, bytes);
    this.stats.blocks++;
    this.stats.bytes += bytes.length;
    const out: FetchAction[] = [{ a: 'stored', cid, bytes }];
    if (this.answered.size === this.batch.length) out.push(...this.advance(now));
    return out;
  }

  onBlockNone(peer: string, cid: CID, now: number): FetchAction[] {
    if (!this.expects(peer, cid.toString())) return [];
    return this.failover(now, 'block-none');
  }

  /** Call when the clock passes the last request's deadline (or periodically). */
  tick(now: number): FetchAction[] {
    if (this.state !== 'running' || this.batch.length === 0 || now < this.deadline) return [];
    return this.failover(now, 'timeout');
  }

  private expects(peer: string, k: string): boolean {
    return this.state === 'running' && this.current?.peer === peer && this.batch.includes(k) && !this.answered.has(k);
  }

  /** Request the next frontier from the current holder, or finish. */
  private advance(now: number): FetchAction[] {
    const dag = verifyDag(this.root, this);
    if (dag.errors.length) return this.fail('invalid-dag', dag.errors[0]);
    if (dag.reached.size > 0xffff) return this.fail('too-many-blocks');
    if (dag.ok) {
      this.state = 'done';
      this.batch = [];
      return [{ a: 'done', totalBytes: dag.totalBytes, blockCount: dag.reached.size }];
    }
    const h = this.current;
    if (!h) return this.fail('no-holder');
    const cids = dag.missing.slice(0, MAX_BLOCK_REQ);
    this.batch = cids.map((c) => c.toString());
    this.answered = new Set();
    this.deadline = batchDeadline(now, h, cids.length, this.asked !== this.idx);
    this.asked = this.idx;
    return [{ a: 'request', peer: h.peer, via: h.via, root: this.root, cids, deadline: this.deadline }];
  }

  private failover(now: number, reason: string): FetchAction[] {
    const from = this.current!.peer;
    this.idx++;
    this.stats.switches++;
    this.batch = [];
    return [{ a: 'next', from, reason }, ...this.advance(now)];
  }

  private fail(reason: string, detail?: string): FetchAction[] {
    this.state = 'failed';
    this.batch = [];
    return [detail ? { a: 'failed', reason, detail } : { a: 'failed', reason }];
  }
}

// ---------------- serving ----------------

export interface ServerConfig {
  seeding: boolean;
  /** BLOCK_REQ messages per peer. */
  requests: Bucket;
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  seeding: true,
  requests: { burst: 8, refillMs: 500 },
};

export type DirectVerdict =
  | { kind: 'reply'; messages: MeshMessage[] }
  | { kind: 'block'; cid: CID; bytes: Uint8Array }
  | { kind: 'block-none'; cid: CID }
  | { kind: 'drop'; reason: string; spam: boolean };

/** Looks a block up in one stored, complete site (never across sites). */
export type SiteLookup = (root: CID, cid: CID) => Uint8Array | undefined;

export class Server {
  readonly cfg: ServerConfig;
  readonly spam = new Map<string, number>();
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(cfg: Partial<ServerConfig> = {}) {
    this.cfg = { ...DEFAULT_SERVER_CONFIG, ...cfg };
  }

  /** One decrypted direct message (Noise payload type 0x4D, or a bulk frame) from `peer`. */
  handle(peer: string, payload: Uint8Array, now: number, lookup: SiteLookup): DirectVerdict {
    const drop = (reason: string, spam: boolean): DirectVerdict => {
      if (spam) this.spam.set(peer, (this.spam.get(peer) ?? 0) + 1);
      return { kind: 'drop', reason, spam };
    };
    let m: MeshMessage | null;
    try {
      m = decodeMessage(payload);
    } catch (e) {
      if (!(e instanceof WireError)) throw e;
      return drop('malformed', true);
    }
    if (!m) return drop('unknown', false);
    switch (m.t) {
      case 'block':
        return { kind: 'block', cid: m.cid, bytes: m.bytes };
      case 'block-none':
        return { kind: 'block-none', cid: m.cid };
      case 'block-req': {
        if (!this.cfg.seeding) return drop('not-seeding', false);
        if (!this.take(peer, now)) return drop('rate-limited', true);
        return {
          kind: 'reply',
          messages: m.cids.map((cid) => {
            const bytes = lookup(m.root, cid);
            return bytes ? { t: 'block', cid, bytes } : { t: 'block-none', cid };
          }),
        };
      }
      default:
        return drop('not-direct', true);
    }
  }

  private take(peer: string, now: number): boolean {
    const b = this.cfg.requests;
    const s = this.buckets.get(peer) ?? { tokens: b.burst, at: now };
    const tokens = Math.min(b.burst, s.tokens + (now - s.at) / b.refillMs);
    if (tokens < 1) {
      this.buckets.set(peer, { tokens, at: now });
      return false;
    }
    this.buckets.set(peer, { tokens: tokens - 1, at: now });
    if (this.buckets.size > 4096) this.buckets.clear();
    return true;
  }
}
