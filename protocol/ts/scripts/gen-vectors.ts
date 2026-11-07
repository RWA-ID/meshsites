/**
 * Regenerate protocol/vectors/. Deterministic: running it twice produces
 * identical files (RFC 6979 signatures, fixed fixture site). Tests fail if the
 * committed vectors drift from what this code produces.
 *
 *   npm run vectors
 */
import { readSiteDir } from '../src/node.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { CarBlockIterator } from '@ipld/car/iterator';
import {
  addressFromPrivateKey,
  buildSiteCar,
  canonicalJson,
  eip191Hash,
  kuboDefaultCid,
  LIMITS,
  type NameRecord,
  recordMessage,
  signRecord,
  type SignedNameRecord,
  type VerifyRecordOptions,
  verifyCar,
  verifyRecord,
  writeCar,
} from '../src/index.ts';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '../../vectors');

/** TEST ONLY. Derived from a public string; never fund this address. */
export const TEST_KEY_SEED = 'meshsites test vector key 1';
export const TEST_KEY_2_SEED = 'meshsites test vector key 2';
const key1 = keccak_256(utf8ToBytes(TEST_KEY_SEED));
const key2 = keccak_256(utf8ToBytes(TEST_KEY_2_SEED));

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

async function siteVectors() {
  const { files } = await readSiteDir(join(VEC, 'site-basic'));
  const built = await buildSiteCar(files);
  const origCidHint = (await kuboDefaultCid(files)).toString();
  await writeFile(join(VEC, 'site-basic.car'), built.car);

  // Re-read the blocks in CAR order to build the negative cases.
  const blocks: { cid: CID; bytes: Uint8Array }[] = [];
  for await (const b of await CarBlockIterator.fromBytes(built.car)) blocks.push(b);
  const lastLeaf = blocks.length - 1; // a raw leaf of js/app.js

  const extraBytes = utf8ToBytes('not part of the site');
  const extra = { cid: CID.createV1(raw.code, await sha256.digest(extraBytes)), bytes: extraBytes };
  const bigBytes = new Uint8Array(LIMITS.maxBlockBytes + 1).fill(0x61);
  const big = { cid: CID.createV1(raw.code, await sha256.digest(bigBytes)), bytes: bigBytes };

  const negatives: { file: string; why: string; error: string; blocks: typeof blocks; roots?: CID[] }[] = [
    {
      file: 'site-basic.tampered-block.car',
      error: 'hash mismatch',
      why: 'one byte of the last raw leaf flipped; CID unchanged',
      blocks: blocks.map((b, i) => {
        if (i !== lastLeaf) return b;
        const bytes = b.bytes.slice();
        bytes[0] ^= 0x01;
        return { cid: b.cid, bytes };
      }),
    },
    { file: 'site-basic.missing-block.car',
      error: 'missing block', why: 'last raw leaf omitted', blocks: blocks.filter((_, i) => i !== lastLeaf) },
    { file: 'site-basic.extra-block.car',
      error: 'block not reachable from root', why: 'an unreachable raw block appended', blocks: [...blocks, extra] },
    { file: 'site-basic.oversized-block.car',
      error: 'bytes (max', why: `an unreachable ${bigBytes.length}-byte block (cap ${LIMITS.maxBlockBytes})`, blocks: [...blocks, big] },
    { file: 'site-basic.duplicate-block.car',
      error: 'duplicate block', why: 'the root block written twice', blocks: [...blocks, blocks[0]] },
    { file: 'site-basic.raw-root.car',
      error: 'must be a dag-pb directory', why: 'root is a raw block, not a directory', blocks: [extra], roots: [extra.cid] },
  ];

  // 6 MiB of zeros dedupes to a ~17 KiB CAR, so only the logical-size cap catches it.
  const bomb = await buildSiteCar([{ path: 'index.html', content: new Uint8Array(6 * 1024 * 1024) }], { skipVerify: true });
  const bombBlocks: typeof blocks = [];
  for await (const b of await CarBlockIterator.fromBytes(bomb.car)) bombBlocks.push(b);
  negatives.push({
    file: 'dedupe-bomb.car',
    why: 'one 16 KiB leaf referenced 384 times: 6 MiB of files from a tiny CAR',
    error: 'expands to 6291456 bytes',
    blocks: bombBlocks,
    roots: [bomb.root],
  });

  const cars = [];
  for (const n of negatives) {
    const bytes = await writeCar(n.roots ?? [built.root], n.blocks);
    await writeFile(join(VEC, n.file), bytes);
    const v = await verifyCar(bytes);
    if (v.ok || !v.errors.some((e) => e.includes(n.error)))
      throw new Error(`negative vector ${n.file}: expected an error containing "${n.error}", got ${JSON.stringify(v.errors)}`);
    cars.push({ file: n.file, why: n.why, expect: { ok: false, errorContains: n.error } });
  }

  return {
    description: 'CAR packaging vectors. site-basic/ is the input; every implementation must reproduce rootCid and block list byte-for-byte, accept site-basic.car, and reject every negative CAR.',
    meshProfile: {
      cidVersion: 1,
      hash: 'sha2-256',
      rawLeaves: true,
      chunker: `size-${LIMITS.chunkSize}`,
      layout: `balanced, maxChildrenPerNode ${LIMITS.maxChildrenPerNode}`,
      wrapWithDirectory: true,
      hamtSharding: 'never',
      blockOrder: 'depth-first pre-order from the root, each block once',
      kuboEquivalent: `ipfs add -r --cid-version=1 --chunker=size-${LIMITS.chunkSize} <dir>`,
    },
    limits: { maxBlockBytes: LIMITS.maxBlockBytes, maxSiteBytes: LIMITS.maxSiteBytes, maxLogicalBytes: LIMITS.maxLogicalBytes },
    input: 'site-basic',
    car: 'site-basic.car',
    rootCid: built.root.toString(),
    origCidHint,
    origCidHintNote: 'what a default `ipfs add -r` gives; the real ENS contenthash may differ',
    crossChecked: 'rootCid and origCidHint confirmed with Kubo 0.43.1 (2026-11-06)',
    totalBytes: built.totalBytes,
    blocks: built.blocks,
    negatives: cars,
  };
}

interface RecordCase {
  id: string;
  why: string;
  input: unknown;
  options?: VerifyRecordOptions;
  expect: { ok: true; status: 'verified' | 'unverified'; signer: string } | { ok: false; reason: string };
}

function recordVectors(rootCid: string, origCid: string) {
  const signer1 = addressFromPrivateKey(key1);
  const signer2 = addressFromPrivateKey(key2);
  const now = 1762470000 + 60;
  const base: NameRecord = { v: 1, name: 'example.eth', cid: rootCid, origCid, seq: 12, ts: 1762470000, signer: signer1 };
  const unicode: NameRecord = { ...base, name: 'café.eth', seq: 3 };
  const good = signRecord(base, key1);
  const goodUnicode = signRecord(unicode, key1);

  // High-s twin of a valid signature: same signer, but non-canonical.
  const sig = hexToBytes(good.sig.slice(2));
  const n = secp256k1.Point.CURVE().n;
  const s = BigInt(`0x${bytesToHex(sig.subarray(32, 64))}`);
  const highS = new Uint8Array(sig);
  highS.set(hexToBytes((n - s).toString(16).padStart(64, '0')), 32);
  highS[64] = sig[64] === 27 ? 28 : 27;

  const withRecord = (r: Record<string, unknown>): SignedNameRecord => ({ record: r as unknown as NameRecord, sig: good.sig });
  const cases: RecordCase[] = [
    { id: 'valid-verified', why: 'signed by the trusted signer', input: good, options: { expectedSigner: signer1, now }, expect: { ok: true, status: 'verified', signer: signer1 } },
    { id: 'valid-unverified', why: 'valid signature, no trusted signer known (show "Unverified name")', input: good, options: { now }, expect: { ok: true, status: 'unverified', signer: signer1 } },
    { id: 'valid-unicode', why: 'non-ASCII name: EIP-191 length is UTF-8 bytes', input: goodUnicode, options: { expectedSigner: signer1, now }, expect: { ok: true, status: 'verified', signer: signer1 } },
    { id: 'newer-seq', why: 'seq 12 replaces cached seq 11', input: good, options: { expectedSigner: signer1, cachedSeq: 11, now }, expect: { ok: true, status: 'verified', signer: signer1 } },
    { id: 'stale-seq-lower', why: 'seq 12 is older than cached seq 13', input: good, options: { expectedSigner: signer1, cachedSeq: 13, now }, expect: { ok: false, reason: 'stale-seq' } },
    { id: 'stale-seq-equal', why: 'replay of the cached seq', input: good, options: { expectedSigner: signer1, cachedSeq: 12, now }, expect: { ok: false, reason: 'stale-seq' } },
    { id: 'tampered-cid', why: 'cid changed after signing', input: withRecord({ ...base, cid: 'bafkreihzaauexlawvjv5ieuwx6taubz5dsymgtnr6qteu2kxqtspn5rjfe' }), options: { now }, expect: { ok: false, reason: 'signer-mismatch' } },
    { id: 'tampered-seq', why: 'seq bumped after signing', input: withRecord({ ...base, seq: 13 }), options: { now }, expect: { ok: false, reason: 'signer-mismatch' } },
    { id: 'wrong-signer', why: 'a valid record from a key that is not trusted for the name', input: signRecord({ ...base, signer: signer2 }, key2), options: { expectedSigner: signer1, now }, expect: { ok: false, reason: 'not-authorized' } },
    { id: 'claimed-signer', why: 'record names signer1 but key2 signed it', input: { record: base, sig: signRecord({ ...base, signer: signer2 }, key2).sig }, options: { now }, expect: { ok: false, reason: 'signer-mismatch' } },
    { id: 'high-s', why: 'malleated (high-s) twin of a valid signature', input: { record: base, sig: `0x${bytesToHex(highS)}` }, options: { now }, expect: { ok: false, reason: 'bad-signature' } },
    { id: 'future-ts', why: `ts more than ${LIMITS.maxFutureSkewSec}s ahead of now`, input: good, options: { now: base.ts - LIMITS.maxFutureSkewSec - 1 }, expect: { ok: false, reason: 'future-ts' } },
    { id: 'uppercase-signer', why: 'signer must be lowercase hex', input: withRecord({ ...base, signer: signer1.toUpperCase().replace('0X', '0x') }), options: { now }, expect: { ok: false, reason: 'malformed' } },
    { id: 'extra-key', why: 'unknown key in a v1 record', input: withRecord({ ...base, extra: 1 }), options: { now }, expect: { ok: false, reason: 'malformed' } },
    { id: 'non-integer-seq', why: 'seq must be an integer', input: withRecord({ ...base, seq: 1.5 }), options: { now }, expect: { ok: false, reason: 'malformed' } },
    { id: 'unnormalized-name', why: 'name must be ENSIP-15 normalized', input: withRecord({ ...base, name: 'Example.eth' }), options: { now }, expect: { ok: false, reason: 'malformed' } },
    { id: 'cidv0-mesh-cid', why: 'mesh cid must be CIDv1', input: withRecord({ ...base, cid: origCid }), options: { now }, expect: { ok: false, reason: 'malformed' } },
  ];

  for (const c of cases) {
    const got = verifyRecord(c.input, c.options);
    const same = got.ok === c.expect.ok && (got.ok ? got.status === (c.expect as { status: string }).status : got.reason === (c.expect as { reason: string }).reason);
    if (!same) throw new Error(`record case ${c.id}: got ${JSON.stringify(got)}`);
  }

  const signing = [base, unicode].map((r) => {
    const msg = recordMessage(r);
    return {
      record: r,
      canonicalJson: msg,
      canonicalJsonUtf8Hex: bytesToHex(utf8ToBytes(msg)),
      eip191Hash: `0x${bytesToHex(eip191Hash(msg))}`,
      sig: signRecord(r, key1).sig,
    };
  });

  return {
    description: 'NAME_RECORD vectors. `signing` pins canonical JSON, the EIP-191 hash and the RFC 6979 signature; `cases` pins verifyRecord outcomes.',
    testKeys: [
      { seed: TEST_KEY_SEED, privateKey: `0x${bytesToHex(key1)}`, address: signer1, note: 'TEST ONLY: privateKey = keccak256(utf8(seed)). Never fund.' },
      { seed: TEST_KEY_2_SEED, privateKey: `0x${bytesToHex(key2)}`, address: signer2, note: 'TEST ONLY.' },
    ],
    signing,
    cases,
  };
}

function canonicalVectors() {
  const cases: { input: unknown; output: string }[] = [
    { input: { b: 1, a: 'x' }, output: '' },
    { input: { s: 'quote " backslash \\ slash / tab \t nl \n bell \u0007 é 🦊' }, output: '' },
    { input: { n: 0, neg: -5, big: 9007199254740991 }, output: '' },
    { input: { nested: { z: [1, true, null], y: false } }, output: '' },
  ].map((c) => ({ ...c, output: canonicalJson(c.input) }));
  return {
    description: 'Canonical JSON. Each output is exact; outputUtf8Hex removes any doubt about escaping.',
    cases: cases.map((c) => ({ ...c, outputUtf8Hex: bytesToHex(utf8ToBytes(c.output)) })),
    mustReject: [
      { input: '{"n":1.5}', why: 'non-integer number' },
      { input: '{"n":9007199254740992}', why: 'beyond 2^53-1' },
      { input: '{"bad-key":1}', why: 'key outside [A-Za-z0-9_]' },
    ],
  };
}

await mkdir(VEC, { recursive: true });
const car = await siteVectors();
await writeFile(join(VEC, 'car.json'), json(car));
await writeFile(join(VEC, 'records.json'), json(recordVectors(car.rootCid, car.origCidHint)));
await writeFile(join(VEC, 'canonical-json.json'), json(canonicalVectors()));
console.log(`vectors written to ${VEC}`);
