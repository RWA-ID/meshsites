/**
 * A model of the bitchat BLE mesh, close enough to test MeshSites against.
 * Mirrors bitchat @04995f68 (docs/bitchat-notes.md §2-4):
 *   - dedupe by sender/timestamp/type/payload digest (LRU 1000, 5 min)
 *   - relay while ttl > 1, TTL clamped to 7, degree-based clamps and jitter
 *   - broadcast fanout to a seeded subset of ~log2(degree) links, except
 *     announce/fragment types; directed packets go straight to an adjacent
 *     recipient
 *   - unknown types are relayed by unpatched nodes (patched = false)
 *   - fragmentation: 469-byte chunks, one per 25 ms (directed) / 30 ms
 * Not modelled: Ed25519 packet signatures, Noise encryption (directed
 * session payloads travel in clear), source routing, gossip sync.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Scheduler } from './scheduler.ts';

export const BITCHAT = {
  ttlDefault: 7,
  fragmentChunk: 469,
  fragmentSpacingMs: 30,
  fragmentSpacingDirectedMs: 25,
  dedupMax: 1000,
  dedupMaxAgeMs: 300_000,
  highDegree: 6,
  /** Outer header: v1 header 14 + sender 8 (+ recipient 8). */
  headerBytes: 22,
  type: { announce: 0x01, noiseEncrypted: 0x11, fragment: 0x20, meshSites: 0x4d },
} as const;

export interface SimPacket {
  type: number;
  sender: string; // 16 hex chars (8-byte bitchat peer ID)
  recipient?: string;
  ttl: number;
  ts: number;
  payload: Uint8Array;
}

export type LinkKind = 'ble' | 'bulk';

export interface LinkProfile {
  kind: LinkKind;
  /** BLE: ms per fragment. */
  perFragmentMs?: number;
  /** Bulk: bytes per second. */
  bandwidthBps?: number;
  latencyMs: number;
  jitterMs: number;
  /** Probability a BLE fragment is lost (a lost fragment loses the packet). */
  loss: number;
}

export const BLE_PROFILE: LinkProfile = { kind: 'ble', latencyMs: 8, jitterMs: 12, loss: 0 };
export const BULK_PROFILE: LinkProfile = { kind: 'bulk', bandwidthBps: 2_000_000, latencyMs: 3, jitterMs: 2, loss: 0 };

export function packetWireBytes(p: SimPacket): number {
  return BITCHAT.headerBytes + (p.recipient ? 8 : 0) + p.payload.length;
}

export function fragmentCount(bytes: number): number {
  return bytes <= 512 ? 1 : Math.ceil(bytes / BITCHAT.fragmentChunk);
}

export function messageId(p: SimPacket): string {
  return `${p.sender}-${p.ts}-${p.type}-${bytesToHex(sha256(p.payload).subarray(0, 4))}`;
}

/** Events for the UI / logs. */
export type RadioEvent =
  | { kind: 'tx'; from: string; to: string; link: LinkKind; packet?: SimPacket; bytes: number; airtimeMs: number; lost: boolean; label: string }
  | { kind: 'rx'; at: string; from: string; link: LinkKind; label: string }
  | { kind: 'relay'; at: string; label: string; ttl: number }
  | { kind: 'drop'; at: string; label: string; reason: string };

export interface RadioApp {
  /** A packet this node should process (not yet decided whether to relay). */
  onPacket(p: SimPacket, from: string): void;
  /** Return false to stop a packet from being relayed by this node. */
  shouldRelay?(p: SimPacket): boolean;
  /** Bytes from a direct session (BLE-directed or bulk). */
  onDirect(peer: string, bytes: Uint8Array, via: LinkKind): void;
  /** Short human label for logs. */
  label?(p: SimPacket): string;
  labelDirect?(payload: Uint8Array): string;
}

/** One direction of a link: airtime queue + loss, then hands bytes to `deliver`. */
export class ShapedLink {
  private busyUntil = 0;
  readonly from: string;
  readonly to: string;
  readonly profile: LinkProfile;
  private sched: Scheduler;
  private rand: () => number;
  /** Called when the frame arrives (memory) or departs (real network). */
  private deliver: (frame: unknown) => void;
  constructor(from: string, to: string, profile: LinkProfile, sched: Scheduler, rand: () => number, deliver: (frame: unknown) => void) {
    this.from = from;
    this.to = to;
    this.profile = profile;
    this.sched = sched;
    this.rand = rand;
    this.deliver = deliver;
  }

  /** Returns { airtimeMs, lost }. */
  send(frame: unknown, bytes: number, directed: boolean): { airtimeMs: number; lost: boolean; arriveAt: number } {
    const p = this.profile;
    let airtime: number;
    let lost = false;
    if (p.kind === 'ble') {
      const frags = fragmentCount(bytes);
      const per = p.perFragmentMs ?? (directed ? BITCHAT.fragmentSpacingDirectedMs : BITCHAT.fragmentSpacingMs);
      airtime = frags === 1 ? Math.max(4, (bytes / BITCHAT.fragmentChunk) * per) : frags * per;
      for (let i = 0; i < frags && !lost; i++) if (this.rand() < p.loss) lost = true;
    } else {
      airtime = (bytes / (p.bandwidthBps ?? 1e6)) * 1000;
    }
    const now = this.sched.now();
    const depart = Math.max(now, this.busyUntil);
    this.busyUntil = depart + airtime;
    const arriveAt = this.busyUntil + p.latencyMs + this.rand() * p.jitterMs;
    if (!lost) this.sched.setTimeout(() => this.deliver(frame), arriveAt - now);
    return { airtimeMs: airtime, lost, arriveAt };
  }

  /** ms until this direction's queue drains. */
  backlogMs() {
    return Math.max(0, this.busyUntil - this.sched.now());
  }
}

interface PeerLinks {
  ble?: ShapedLink;
  bulk?: ShapedLink;
}

function subsetSize(count: number): number {
  if (count <= 2) return count;
  let v = count - 1;
  let bits = 0;
  while (v > 0) {
    v >>= 1;
    bits++;
  }
  return Math.min(count, Math.max(1, bits + 1));
}

export class BitchatRadio {
  readonly links = new Map<string, PeerLinks>();
  app?: RadioApp;
  private seen = new Map<string, number>();
  private scheduled = new Map<string, number>();
  private lastTs = 0;
  /** Debug: never accept or send packets from/to these peers ("forced relay"). */
  readonly blocked = new Set<string>();
  listeners: ((e: RadioEvent) => void)[] = [];

  readonly peerId: string;
  readonly name: string;
  private sched: Scheduler;
  private rand: () => number;
  /** false = an old bitchat client: relays MeshSites packets but can't use them. */
  readonly patched: boolean;
  constructor(peerId: string, name: string, sched: Scheduler, rand: () => number, patched = true) {
    this.peerId = peerId;
    this.name = name;
    this.sched = sched;
    this.rand = rand;
    this.patched = patched;
  }

  emit(e: RadioEvent) {
    for (const l of this.listeners) l(e);
  }

  get degree() {
    let n = 0;
    for (const [peer, l] of this.links) if (l.ble && !this.blocked.has(peer)) n++;
    return n;
  }

  /** Unique, monotonic timestamp (bitchat dedupes on sender+ts+type+digest). */
  nextTs() {
    this.lastTs = Math.max(this.lastTs + 1, Math.floor(this.sched.now()));
    return this.lastTs;
  }

  attach(peer: string, kind: LinkKind, link: ShapedLink) {
    const l = this.links.get(peer) ?? {};
    l[kind] = link;
    this.links.set(peer, l);
  }

  detach(peer: string, kind?: LinkKind) {
    if (!kind) this.links.delete(peer);
    else {
      const l = this.links.get(peer);
      if (l) delete l[kind];
    }
  }

  hasBulk(peer: string) {
    return !!this.links.get(peer)?.bulk && !this.blocked.has(peer);
  }

  private label(p: SimPacket) {
    return this.app?.label?.(p) ?? `type 0x${p.type.toString(16)}`;
  }

  private transmit(peer: string, p: SimPacket) {
    const link = this.links.get(peer)?.ble;
    if (!link || this.blocked.has(peer)) return;
    const bytes = packetWireBytes(p);
    const r = link.send(p, bytes, !!p.recipient);
    this.emit({ kind: 'tx', from: this.peerId, to: peer, link: 'ble', packet: p, bytes, airtimeMs: r.airtimeMs, lost: r.lost, label: this.label(p) });
  }

  /** Originate a packet. */
  send(p: SimPacket) {
    this.markSeen(messageId(p));
    for (const peer of this.fanout(p, undefined)) this.transmit(peer, p);
  }

  /** Send a direct-session payload: bulk link if present, else directed BLE (stands in for noiseEncrypted). */
  sendDirect(peer: string, payload: Uint8Array, prefer: LinkKind = 'bulk') {
    const bulk = this.links.get(peer)?.bulk;
    if (prefer === 'bulk' && bulk && !this.blocked.has(peer)) {
      const r = bulk.send({ direct: true, from: this.peerId, payload }, payload.length + 16, true);
      this.emit({ kind: 'tx', from: this.peerId, to: peer, link: 'bulk', bytes: payload.length + 16, airtimeMs: r.airtimeMs, lost: r.lost, label: this.app?.labelDirect?.(payload) ?? 'direct' });
      return 'bulk' as const;
    }
    const inner = new Uint8Array(payload.length + 1);
    inner[0] = BITCHAT.type.meshSites; // NoisePayloadType 0x4D
    inner.set(payload, 1);
    this.send({ type: BITCHAT.type.noiseEncrypted, sender: this.peerId, recipient: peer, ttl: BITCHAT.ttlDefault, ts: this.nextTs(), payload: inner });
    return 'ble' as const;
  }

  /** Frame arriving from a link. */
  receiveFrame(from: string, frame: unknown) {
    if (this.blocked.has(from)) return;
    const f = frame as { direct?: boolean; from?: string; payload?: Uint8Array };
    if (f.direct) {
      this.emit({ kind: 'rx', at: this.peerId, from, link: 'bulk', label: this.app?.labelDirect?.(f.payload!) ?? 'direct' });
      if (this.patched) this.app?.onDirect(from, f.payload!, 'bulk');
      return;
    }
    this.receive(frame as SimPacket, from);
  }

  private markSeen(id: string) {
    const now = this.sched.now();
    this.seen.set(id, now);
    if (this.seen.size > BITCHAT.dedupMax) {
      const first = this.seen.keys().next().value!;
      this.seen.delete(first);
    }
  }

  private isDuplicate(id: string) {
    const t = this.seen.get(id);
    return t !== undefined && this.sched.now() - t < BITCHAT.dedupMaxAgeMs;
  }

  receive(p: SimPacket, from: string) {
    if (p.sender === this.peerId) return;
    const id = messageId(p);
    if (this.isDuplicate(id)) {
      if (this.degree > 2) {
        const h = this.scheduled.get(id);
        if (h !== undefined) {
          this.sched.clearTimeout(h);
          this.scheduled.delete(id);
        }
      }
      return;
    }
    this.markSeen(id);
    const forMe = p.recipient === this.peerId;
    if (this.patched) {
      if (p.type === BITCHAT.type.meshSites) {
        this.emit({ kind: 'rx', at: this.peerId, from, link: 'ble', label: this.label(p) });
        this.app?.onPacket(p, from);
      } else if (p.type === BITCHAT.type.noiseEncrypted && forMe && p.payload[0] === BITCHAT.type.meshSites) {
        this.emit({ kind: 'rx', at: this.peerId, from, link: 'ble', label: this.label(p) });
        this.app?.onDirect(p.sender, p.payload.subarray(1), 'ble');
      }
    }
    if (forMe) return;
    if (this.patched && this.app?.shouldRelay && !this.app.shouldRelay(p)) {
      this.emit({ kind: 'drop', at: this.peerId, label: this.label(p), reason: 'not relayed (MeshSites policy)' });
      return;
    }
    this.scheduleRelay(p, from, id);
  }

  private scheduleRelay(p: SimPacket, from: string, id: string) {
    const ttlCap = Math.min(p.ttl, BITCHAT.ttlDefault);
    if (ttlCap <= 1) return;
    const directed = p.type === BITCHAT.type.noiseEncrypted && !!p.recipient;
    let newTtl: number;
    let delay: number;
    const d = this.degree;
    const r = (a: number, b: number) => a + Math.floor(this.rand() * (b - a + 1));
    if (directed) {
      newTtl = ttlCap - 1;
      delay = r(20, 60);
    } else {
      const limit =
        d >= BITCHAT.highDegree ? Math.max(2, Math.min(ttlCap, 5)) : d <= 2 ? ttlCap : Math.max(2, Math.min(ttlCap, p.type === BITCHAT.type.announce ? 7 : 6));
      newTtl = limit - 1;
      delay = d <= 2 ? r(10, 40) : d <= 5 ? r(60, 150) : d <= 9 ? r(80, 180) : r(100, 220);
    }
    const relayed = { ...p, ttl: newTtl };
    const h = this.sched.setTimeout(() => {
      this.scheduled.delete(id);
      this.emit({ kind: 'relay', at: this.peerId, label: this.label(p), ttl: newTtl });
      for (const peer of this.fanout(relayed, from)) this.transmit(peer, relayed);
    }, delay);
    this.scheduled.set(id, h);
  }

  /** Which neighbours get this packet. */
  private fanout(p: SimPacket, ingress: string | undefined): string[] {
    const peers = [...this.links.keys()].filter((k) => k !== ingress && this.links.get(k)!.ble && !this.blocked.has(k));
    if (p.recipient && peers.includes(p.recipient)) return [p.recipient];
    const full = p.type === BITCHAT.type.announce || p.type === BITCHAT.type.fragment || (p.type === BITCHAT.type.noiseEncrypted && !!p.recipient);
    if (full) return peers;
    const k = subsetSize(peers.length);
    if (peers.length <= k) return peers;
    // Deterministic, message-ID-seeded subset (like BLEFanoutSelector).
    const seed = messageId(p);
    return peers
      .map((peer) => ({ peer, h: bytesToHex(sha256(new TextEncoder().encode(seed + peer))) }))
      .sort((a, b) => (a.h < b.h ? -1 : 1))
      .slice(0, k)
      .map((x) => x.peer);
  }
}
