/**
 * Signed ENS -> CID NAME_RECORD (protocol/SPEC.md §4).
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ens_normalize } from '@adraffy/ens-normalize';
import { CID } from 'multiformats/cid';
import { canonicalJson } from './canonical.ts';
import { LIMITS } from './limits.ts';

export interface NameRecord {
  v: 1;
  name: string;
  cid: string;
  origCid: string;
  seq: number;
  ts: number;
  /** Lowercase 0x-hex address. */
  signer: string;
}

export interface SignedNameRecord {
  record: NameRecord;
  /** 0x + r(32) s(32) v(1), v in {27, 28}. */
  sig: string;
}

export type RecordStatus =
  /** Signature valid and the signer is the one we trust for this name. */
  | 'verified'
  /** Signature valid, but no trusted signer is known for this name. */
  | 'unverified';

export type RecordRejection =
  | 'malformed'
  | 'bad-signature'
  | 'signer-mismatch'
  | 'not-authorized'
  | 'stale-seq'
  | 'future-ts';

export type RecordVerification =
  | { ok: true; status: RecordStatus; record: NameRecord; signer: string }
  | { ok: false; reason: RecordRejection; detail: string };

const KEYS = ['cid', 'name', 'origCid', 'seq', 'signer', 'ts', 'v'];
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const N = secp256k1.Point.CURVE().n;

export class RecordError extends Error {}

/** Throws RecordError with a reason if the record is not well-formed. */
export function assertWellFormed(r: unknown): asserts r is NameRecord {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new RecordError('record is not an object');
  const o = r as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join() !== KEYS.join()) throw new RecordError(`record keys must be exactly ${KEYS.join(',')}`);
  if (o.v !== 1) throw new RecordError('v must be 1');
  if (typeof o.name !== 'string') throw new RecordError('name must be a string');
  let norm: string;
  try {
    norm = ens_normalize(o.name);
  } catch (e) {
    throw new RecordError(`name is not a valid ENS name: ${(e as Error).message}`);
  }
  if (norm !== o.name) throw new RecordError(`name must be ENSIP-15 normalized (${norm})`);
  if (!o.name.includes('.')) throw new RecordError('name must have a parent (e.g. example.eth)');
  for (const k of ['cid', 'origCid'] as const) {
    const s = o[k];
    if (typeof s !== 'string') throw new RecordError(`${k} must be a string`);
    let c: CID;
    try {
      c = CID.parse(s);
    } catch {
      throw new RecordError(`${k} is not a CID`);
    }
    if (c.toString() !== s) throw new RecordError(`${k} must be in canonical string form (${c.toString()})`);
    if (k === 'cid' && c.version !== 1) throw new RecordError('cid must be CIDv1');
  }
  for (const k of ['seq', 'ts'] as const) {
    if (!Number.isSafeInteger(o[k]) || (o[k] as number) < 0) throw new RecordError(`${k} must be a non-negative integer`);
  }
  if (typeof o.signer !== 'string' || !ADDR_RE.test(o.signer)) throw new RecordError('signer must be a lowercase 0x address');
}

/** The exact UTF-8 bytes that are signed (before the EIP-191 prefix). */
export function recordMessage(record: NameRecord): string {
  assertWellFormed(record);
  return canonicalJson(record);
}

/** keccak256("\x19Ethereum Signed Message:\n" + len(bytes) + bytes). */
export function eip191Hash(message: string | Uint8Array): Uint8Array {
  const body = typeof message === 'string' ? utf8ToBytes(message) : message;
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak_256(all);
}

export function addressFromPublicKey(pub: Uint8Array): string {
  const uncompressed = pub.length === 65 ? pub : secp256k1.Point.fromBytes(pub).toBytes(false);
  return `0x${bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
}

export function addressFromPrivateKey(priv: Uint8Array): string {
  return addressFromPublicKey(secp256k1.getPublicKey(priv, false));
}

/** EIP-55 mixed-case form, for display only. */
export function toChecksumAddress(addr: string): string {
  const a = addr.toLowerCase().replace(/^0x/, '');
  const h = bytesToHex(keccak_256(utf8ToBytes(a)));
  return `0x${[...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')}`;
}

export function parsePrivateKey(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new RecordError('private key must be 32 bytes of hex');
  return hexToBytes(h);
}

/** personal_sign the canonical JSON with a local key. Deterministic (RFC 6979). */
export function signRecord(record: NameRecord, priv: Uint8Array): SignedNameRecord {
  const signer = addressFromPrivateKey(priv);
  if (signer !== record.signer) throw new RecordError(`key is for ${signer}, record.signer is ${record.signer}`);
  const rec = secp256k1.sign(eip191Hash(recordMessage(record)), priv, { prehash: false, format: 'recovered' });
  // noble 'recovered' = recovery(1) | r(32) | s(32); Ethereum wants r | s | v(27+rec).
  const sig = new Uint8Array(65);
  sig.set(rec.subarray(1), 0);
  sig[64] = 27 + rec[0];
  return { record, sig: `0x${bytesToHex(sig)}` };
}

/** Attach a signature produced elsewhere (e.g. a wallet's personal_sign). */
export function attachSignature(record: NameRecord, sig: string): SignedNameRecord {
  assertWellFormed(record);
  return { record, sig: sig.toLowerCase() };
}

/** Recover the address that produced an Ethereum personal_sign signature. */
export function recoverSigner(message: string | Uint8Array, sig: string): string {
  if (!SIG_RE.test(sig)) throw new RecordError('sig must be 65 bytes of hex');
  const b = hexToBytes(sig.slice(2));
  let v = b[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new RecordError(`bad recovery byte ${b[64]}`);
  const s = BigInt(`0x${bytesToHex(b.subarray(32, 64))}`);
  if (s === 0n || s > N / 2n) throw new RecordError('signature s is not low-s');
  const rec = new Uint8Array(65);
  rec[0] = v;
  rec.set(b.subarray(0, 64), 1);
  const pub = secp256k1.recoverPublicKey(rec, eip191Hash(message), { prehash: false });
  return addressFromPublicKey(pub);
}

export interface VerifyRecordOptions {
  /** Trusted signer for this name, learned online (signer cache). */
  expectedSigner?: string;
  /** Highest seq already cached for this name. The new record must be strictly higher. */
  cachedSeq?: number;
  /** Unix seconds; defaults to now. */
  now?: number;
}

export function verifyRecord(signed: unknown, opts: VerifyRecordOptions = {}): RecordVerification {
  const fail = (reason: RecordRejection, detail: string): RecordVerification => ({ ok: false, reason, detail });
  if (typeof signed !== 'object' || signed === null) return fail('malformed', 'not an object');
  const { record, sig } = signed as Partial<SignedNameRecord>;
  if (Object.keys(signed).sort().join() !== 'record,sig') return fail('malformed', 'keys must be exactly record,sig');
  try {
    assertWellFormed(record);
  } catch (e) {
    return fail('malformed', (e as Error).message);
  }
  if (typeof sig !== 'string') return fail('malformed', 'sig must be a string');
  let recovered: string;
  try {
    recovered = recoverSigner(recordMessage(record), sig);
  } catch (e) {
    return fail('bad-signature', (e as Error).message);
  }
  if (recovered !== record.signer) return fail('signer-mismatch', `signature is from ${recovered}, record says ${record.signer}`);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (record.ts > now + LIMITS.maxFutureSkewSec) return fail('future-ts', `ts ${record.ts} is ahead of now ${now}`);
  if (opts.cachedSeq !== undefined && record.seq <= opts.cachedSeq)
    return fail('stale-seq', `seq ${record.seq} is not newer than cached ${opts.cachedSeq}`);
  if (opts.expectedSigner !== undefined) {
    if (opts.expectedSigner.toLowerCase() !== record.signer)
      return fail('not-authorized', `${record.signer} is not the trusted signer ${opts.expectedSigner.toLowerCase()}`);
    return { ok: true, status: 'verified', record, signer: recovered };
  }
  return { ok: true, status: 'unverified', record, signer: recovered };
}
