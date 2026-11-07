/**
 * MeshSites wire messages, DRAFT for M3 (protocol/SPEC.md §5).
 *
 * Carried in bitchat as:
 *   - public gossip: outer MessageType 0x4D, payload = this encoding
 *   - direct session: inside noiseEncrypted, NoisePayloadType 0x4D, same encoding
 *
 * payload = version u8 (=1) | subtype u8 | TLV*
 * TLV     = tag u8 | length u16 BE | value
 *
 * Unknown tags are skipped (forward compatible). A known tag repeated where it
 * may not repeat, a missing required tag, a bad length, or a malformed CID
 * makes the whole message invalid. The sender's peer ID and timestamp come
 * from the bitchat packet header, not from this payload.
 */
import { CID } from 'multiformats/cid';
import { checkCidRules } from './car.ts';

export const WIRE_VERSION = 1;
export const MESH_MESSAGE_TYPE = 0x4d;
export const MESH_NOISE_PAYLOAD_TYPE = 0x4d;

export const SUB = {
  announce: 0x01,
  nameRecord: 0x02,
  want: 0x03,
  have: 0x04,
  // 0x05 attestation: reserved (M5)
  blockReq: 0x10,
  block: 0x11,
  blockNone: 0x12,
} as const;

/** Sub-types allowed on public mesh gossip vs. inside a direct (Noise) session. */
export const PUBLIC_SUBTYPES = new Set<number>([SUB.announce, SUB.nameRecord, SUB.want, SUB.have]);
export const DIRECT_SUBTYPES = new Set<number>([SUB.blockReq, SUB.block, SUB.blockNone]);

/** Originator TTLs. bitchat relays while ttl > 1, so TTL N reaches N hops. */
export const TTL = { announce: 3, nameRecord: 7, want: 5, have: 5 } as const;

export const MAX_ANNOUNCE_ENTRIES = 8;
export const MAX_BLOCK_REQ = 32;

const TAG = {
  reqId: 0x01,
  rootCid: 0x02,
  ensName: 0x03,
  origTtl: 0x04,
  hops: 0x05,
  bulk: 0x06,
  sizeBytes: 0x07,
  blockCount: 0x08,
  blockCid: 0x09,
  blockBytes: 0x0a,
  site: 0x0b,
  signedRecord: 0x0c,
} as const;

export interface SiteEntry {
  root: CID;
  sizeBytes: number;
  blockCount: number;
}

export interface Bulk {
  /** Can serve over peer-to-peer Wi-Fi (Network.framework / AWDL). */
  p2pWifi: boolean;
  /** Can serve over BLE (directed Noise). */
  ble: boolean;
}

export type MeshMessage =
  | { t: 'announce'; sites: SiteEntry[] }
  | { t: 'name-record'; signed: string }
  | { t: 'want'; reqId: Uint8Array; origTtl: number; root?: CID; name?: string }
  | { t: 'have'; reqId: Uint8Array; root: CID; hops: number; bulk: Bulk; sizeBytes: number; blockCount: number }
  | { t: 'block-req'; root: CID; cids: CID[] }
  | { t: 'block'; cid: CID; bytes: Uint8Array }
  | { t: 'block-none'; cid: CID };

export class WireError extends Error {}

// ---------- encoding ----------

class Writer {
  private parts: number[] = [];
  private bufs: Uint8Array[] = [];
  private flush() {
    if (this.parts.length) {
      this.bufs.push(Uint8Array.from(this.parts));
      this.parts = [];
    }
  }
  u8(v: number) {
    this.parts.push(v & 0xff);
  }
  tlv(tag: number, value: Uint8Array) {
    if (value.length > 0xffff) throw new WireError(`TLV ${tag} too long`);
    this.u8(tag);
    this.u8(value.length >> 8);
    this.u8(value.length);
    this.flush();
    this.bufs.push(value);
  }
  bytes(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.bufs.reduce((n, b) => n + b.length, 0));
    let off = 0;
    for (const b of this.bufs) {
      out.set(b, off);
      off += b.length;
    }
    return out;
  }
}

const u8b = (v: number) => Uint8Array.of(v);
const u16b = (v: number) => Uint8Array.of(v >> 8, v);
const u32b = (v: number) => Uint8Array.of(v >>> 24, v >>> 16, v >>> 8, v);
const utf8 = new TextEncoder();
const utf8d = new TextDecoder('utf-8', { fatal: true });

function checkInt(name: string, v: number, max: number) {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new WireError(`${name} out of range: ${v}`);
}

export function encodeMessage(m: MeshMessage): Uint8Array {
  const w = new Writer();
  w.u8(WIRE_VERSION);
  switch (m.t) {
    case 'announce': {
      if (m.sites.length < 1 || m.sites.length > MAX_ANNOUNCE_ENTRIES) throw new WireError('announce needs 1..8 sites');
      w.u8(SUB.announce);
      for (const s of m.sites) {
        checkInt('sizeBytes', s.sizeBytes, 0xffffffff);
        checkInt('blockCount', s.blockCount, 0xffff);
        const c = s.root.bytes;
        const v = new Uint8Array(6 + c.length);
        v.set(u32b(s.sizeBytes), 0);
        v.set(u16b(s.blockCount), 4);
        v.set(c, 6);
        w.tlv(TAG.site, v);
      }
      break;
    }
    case 'name-record':
      w.u8(SUB.nameRecord);
      w.tlv(TAG.signedRecord, utf8.encode(m.signed));
      break;
    case 'want':
      if (m.reqId.length !== 8) throw new WireError('reqId must be 8 bytes');
      if ((m.root === undefined) === (m.name === undefined)) throw new WireError('want needs exactly one of root or name');
      checkInt('origTtl', m.origTtl, 255);
      w.u8(SUB.want);
      w.tlv(TAG.reqId, m.reqId);
      w.tlv(TAG.origTtl, u8b(m.origTtl));
      if (m.root) w.tlv(TAG.rootCid, m.root.bytes);
      else w.tlv(TAG.ensName, utf8.encode(m.name!));
      break;
    case 'have':
      if (m.reqId.length !== 8) throw new WireError('reqId must be 8 bytes');
      checkInt('hops', m.hops, 255);
      checkInt('sizeBytes', m.sizeBytes, 0xffffffff);
      checkInt('blockCount', m.blockCount, 0xffff);
      w.u8(SUB.have);
      w.tlv(TAG.reqId, m.reqId);
      w.tlv(TAG.rootCid, m.root.bytes);
      w.tlv(TAG.hops, u8b(m.hops));
      w.tlv(TAG.bulk, u8b((m.bulk.p2pWifi ? 1 : 0) | (m.bulk.ble ? 2 : 0)));
      w.tlv(TAG.sizeBytes, u32b(m.sizeBytes));
      w.tlv(TAG.blockCount, u16b(m.blockCount));
      break;
    case 'block-req':
      if (m.cids.length < 1 || m.cids.length > MAX_BLOCK_REQ) throw new WireError('block-req needs 1..32 CIDs');
      w.u8(SUB.blockReq);
      w.tlv(TAG.rootCid, m.root.bytes);
      for (const c of m.cids) w.tlv(TAG.blockCid, c.bytes);
      break;
    case 'block':
      w.u8(SUB.block);
      w.tlv(TAG.blockCid, m.cid.bytes);
      w.tlv(TAG.blockBytes, m.bytes);
      break;
    case 'block-none':
      w.u8(SUB.blockNone);
      w.tlv(TAG.blockCid, m.cid.bytes);
      break;
  }
  return w.bytes();
}

// ---------- decoding ----------

const REPEATABLE = new Set<number>([TAG.site, TAG.blockCid]);

function parseTlvs(b: Uint8Array, from: number): Map<number, Uint8Array[]> {
  const out = new Map<number, Uint8Array[]>();
  let i = from;
  while (i < b.length) {
    if (i + 3 > b.length) throw new WireError('truncated TLV header');
    const tag = b[i];
    const len = (b[i + 1] << 8) | b[i + 2];
    i += 3;
    if (i + len > b.length) throw new WireError(`TLV ${tag} overruns payload`);
    const list = out.get(tag) ?? [];
    list.push(b.subarray(i, i + len));
    out.set(tag, list);
    i += len;
  }
  return out;
}

function one(t: Map<number, Uint8Array[]>, tag: number, name: string, len?: number): Uint8Array {
  const v = t.get(tag);
  if (!v) throw new WireError(`missing ${name}`);
  if (v.length > 1) throw new WireError(`${name} repeated`);
  if (len !== undefined && v[0].length !== len) throw new WireError(`${name} must be ${len} bytes`);
  return v[0];
}

function opt(t: Map<number, Uint8Array[]>, tag: number, name: string): Uint8Array | undefined {
  return t.has(tag) ? one(t, tag, name) : undefined;
}

function cid(b: Uint8Array, name: string): CID {
  let c: CID;
  try {
    c = CID.decode(b);
  } catch {
    throw new WireError(`${name} is not a CID`);
  }
  const rule = checkCidRules(c);
  if (rule) throw new WireError(`${name}: ${rule}`);
  return c;
}

const rd16 = (b: Uint8Array, o = 0) => (b[o] << 8) | b[o + 1];
const rd32 = (b: Uint8Array, o = 0) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/**
 * Decode a MeshSites payload. Returns null for a version or sub-type this
 * implementation doesn't know (ignore it, as bitchat does); throws WireError
 * for a malformed message of a known kind (drop it, count it against the peer).
 */
export function decodeMessage(b: Uint8Array): MeshMessage | null {
  if (b.length < 2) throw new WireError('payload too short');
  if (b[0] !== WIRE_VERSION) return null;
  const sub = b[1];
  if (!PUBLIC_SUBTYPES.has(sub) && !DIRECT_SUBTYPES.has(sub)) return null;
  const t = parseTlvs(b, 2);
  for (const [tag, vals] of t) if (vals.length > 1 && !REPEATABLE.has(tag) && Object.values(TAG).includes(tag as never)) throw new WireError(`tag ${tag} repeated`);
  switch (sub) {
    case SUB.announce: {
      const sites = t.get(TAG.site) ?? [];
      if (sites.length < 1 || sites.length > MAX_ANNOUNCE_ENTRIES) throw new WireError('announce needs 1..8 sites');
      return {
        t: 'announce',
        sites: sites.map((v) => {
          if (v.length < 7) throw new WireError('site entry too short');
          return { sizeBytes: rd32(v), blockCount: rd16(v, 4), root: cid(v.subarray(6), 'site root') };
        }),
      };
    }
    case SUB.nameRecord: {
      let signed: string;
      try {
        signed = utf8d.decode(one(t, TAG.signedRecord, 'signedRecord'));
      } catch (e) {
        if (e instanceof WireError) throw e;
        throw new WireError('signedRecord is not UTF-8');
      }
      return { t: 'name-record', signed };
    }
    case SUB.want: {
      const reqId = one(t, TAG.reqId, 'reqId', 8);
      const origTtl = one(t, TAG.origTtl, 'origTtl', 1)[0];
      const r = opt(t, TAG.rootCid, 'rootCid');
      const n = opt(t, TAG.ensName, 'ensName');
      if ((r === undefined) === (n === undefined)) throw new WireError('want needs exactly one of rootCid or ensName');
      if (n) {
        let name: string;
        try {
          name = utf8d.decode(n);
        } catch {
          throw new WireError('ensName is not UTF-8');
        }
        return { t: 'want', reqId: reqId.slice(), origTtl, name };
      }
      return { t: 'want', reqId: reqId.slice(), origTtl, root: cid(r!, 'rootCid') };
    }
    case SUB.have: {
      const bulk = one(t, TAG.bulk, 'bulk', 1)[0];
      return {
        t: 'have',
        reqId: one(t, TAG.reqId, 'reqId', 8).slice(),
        root: cid(one(t, TAG.rootCid, 'rootCid'), 'rootCid'),
        hops: one(t, TAG.hops, 'hops', 1)[0],
        bulk: { p2pWifi: (bulk & 1) !== 0, ble: (bulk & 2) !== 0 },
        sizeBytes: rd32(one(t, TAG.sizeBytes, 'sizeBytes', 4)),
        blockCount: rd16(one(t, TAG.blockCount, 'blockCount', 2)),
      };
    }
    case SUB.blockReq: {
      const cids = t.get(TAG.blockCid) ?? [];
      if (cids.length < 1 || cids.length > MAX_BLOCK_REQ) throw new WireError('block-req needs 1..32 CIDs');
      return { t: 'block-req', root: cid(one(t, TAG.rootCid, 'rootCid'), 'rootCid'), cids: cids.map((c) => cid(c, 'blockCid')) };
    }
    case SUB.block: {
      const cids = t.get(TAG.blockCid) ?? [];
      if (cids.length !== 1) throw new WireError('block needs exactly one blockCid');
      return { t: 'block', cid: cid(cids[0], 'blockCid'), bytes: one(t, TAG.blockBytes, 'blockBytes').slice() };
    }
    case SUB.blockNone: {
      const cids = t.get(TAG.blockCid) ?? [];
      if (cids.length !== 1) throw new WireError('block-none needs exactly one blockCid');
      return { t: 'block-none', cid: cid(cids[0], 'blockCid') };
    }
  }
  return null;
}

export function subtypeOf(b: Uint8Array): number | undefined {
  return b.length >= 2 && b[0] === WIRE_VERSION ? b[1] : undefined;
}
