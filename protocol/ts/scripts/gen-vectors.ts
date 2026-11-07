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
  encodeMessage,
  decodeMessage,
  type MeshMessage,
  DEFAULT_GOSSIP_CONFIG,
  type GossipConfig,
  GossipPolicy,
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

  // The no-network probe site, rendered by the viewers' explicit network test.
  const probe = await buildSiteCar((await readSiteDir(join(VEC, 'probe-site'))).files);
  await writeFile(join(VEC, 'probe-site.car'), probe.car);

  return {
    probe: { input: 'probe-site', car: 'probe-site.car', rootCid: probe.root.toString() },
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
    {
      id: 'unrecoverable-r',
      why: 'r = 5 is not the x-coordinate of any curve point: recovery fails and must be a clean rejection, not a crash',
      input: { record: base, sig: `0x${'5'.padStart(64, '0')}${'1'.padStart(64, '0')}1b` },
      options: { now },
      expect: { ok: false, reason: 'bad-signature' },
    },
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

function wireVectors(rootCid: string) {
  const root = CID.parse(rootCid);
  const leaf = CID.parse('bafkreihzaauexlawvjv5ieuwx6taubz5dsymgtnr6qteu2kxqtspn5rjfe');
  const reqId = hexToBytes('0102030405060708');
  const msgs: { id: string; msg: MeshMessage }[] = [
    { id: 'announce', msg: { t: 'announce', sites: [{ root, sizeBytes: 41002, blockCount: 9 }] } },
    { id: 'name-record', msg: { t: 'name-record', signed: '{"record":{},"sig":"0x00"}' } },
    { id: 'want-root', msg: { t: 'want', reqId, origTtl: 5, root } },
    { id: 'want-name', msg: { t: 'want', reqId, origTtl: 5, name: 'café.eth' } },
    { id: 'have', msg: { t: 'have', reqId, root, hops: 2, bulk: { p2pWifi: true, ble: true }, sizeBytes: 41002, blockCount: 9 } },
    { id: 'block-req', msg: { t: 'block-req', root, cids: [root, leaf] } },
    { id: 'block', msg: { t: 'block', cid: leaf, bytes: utf8ToBytes('hello') } },
    { id: 'block-none', msg: { t: 'block-none', cid: leaf } },
  ];
  const valid = msgs.map(({ id, msg }) => {
    const bytes = encodeMessage(msg);
    const back = decodeMessage(bytes);
    if (!back || back.t !== msg.t) throw new Error(`wire ${id} does not round-trip`);
    return { id, hex: bytesToHex(bytes) };
  });
  const announceHex = valid[0].hex;
  const blockNoneHex = valid[7].hex;
  const cidHex = bytesToHex(leaf.bytes);
  const len = (n: number) => n.toString(16).padStart(4, '0');
  const invalid = [
    { id: 'empty', hex: '', expect: 'invalid' },
    { id: 'future-version', hex: '0201', expect: 'ignore' },
    { id: 'unknown-subtype', hex: '0177', expect: 'ignore' },
    { id: 'unknown-tag-skipped', hex: `${blockNoneHex}ee0002abcd`, expect: 'valid' },
    { id: 'truncated-tlv', hex: announceHex.slice(0, -4), expect: 'invalid' },
    { id: 'tlv-overrun', hex: '0112' + '09' + len(200) + cidHex, expect: 'invalid' },
    { id: 'repeated-tag', hex: `${blockNoneHex}09${len(leaf.bytes.length)}${cidHex}`, expect: 'invalid' },
    { id: 'cidv0-block', hex: '011209' + len(34) + bytesToHex(CID.parse('QmQvsUW5SBQ83mueVKcQK7q8ME26opJQGWah9ZbUgJTDSe').bytes), expect: 'invalid' },
    { id: 'want-both-root-and-name', hex: '0103' + '01' + len(8) + '0102030405060708' + '04' + len(1) + '05' + '02' + len(root.bytes.length) + bytesToHex(root.bytes) + '03' + len(3) + bytesToHex(utf8ToBytes('a.b')), expect: 'invalid' },
    { id: 'block-req-33', hex: '0110' + '02' + len(root.bytes.length) + bytesToHex(root.bytes) + `09${len(leaf.bytes.length)}${cidHex}`.repeat(33), expect: 'invalid' },
  ];
  for (const v of invalid) {
    let got: string;
    try {
      got = decodeMessage(hexToBytes(v.hex)) ? 'valid' : 'ignore';
    } catch {
      got = 'invalid';
    }
    if (got !== v.expect) throw new Error(`wire vector ${v.id}: expected ${v.expect}, got ${got}`);
  }
  return {
    description: 'DRAFT (pre-M3) MeshSites wire messages. payload = version u8 | subtype u8 | (tag u8, len u16 BE, value)*. "ignore" = unknown version/subtype (drop silently); "invalid" = malformed (drop and count against the peer).',
    outerBitchatType: '0x4D',
    noisePayloadType: '0x4D',
    valid,
    invalid,
  };
}

// ---------------- gossip.json (M3) ----------------

interface GossipStepIn {
  at: number;
  sender: string;
  recipient?: string;
  ttl: number;
  authenticated?: boolean;
  msg?: MeshMessage;
  payloadHex?: string;
  /** Hand-written: relay / drop / spam, plus have/name when they apply. */
  expect: { relay: boolean; drop?: string; spam?: boolean; have?: boolean; name?: { name: string; status: string }; sends?: number };
}

interface GossipScenarioIn {
  id: string;
  why: string;
  config?: Partial<GossipConfig>;
  setup?: { sites?: { root: string; sizeBytes: number; blockCount: number }[]; signers?: Record<string, string>; records?: string[] };
  nowSec?: number;
  steps: GossipStepIn[];
}

function gossipVectors(rootCid: string, origCid: string) {
  const SELF = 'aaaaaaaaaaaaaaaa';
  const B = 'b1b1b1b1b1b1b1b1';
  const C = 'c1c1c1c1c1c1c1c1';
  const root = CID.parse(rootCid);
  const other = CID.parse('bafkreihzaauexlawvjv5ieuwx6taubz5dsymgtnr6qteu2kxqtspn5rjfe');
  const signer1 = addressFromPrivateKey(key1);
  const ts = 1762470000;
  const nowSec = ts + 60;
  const base: NameRecord = { v: 1, name: 'example.eth', cid: rootCid, origCid, seq: 12, ts, signer: signer1 };
  const text = (r: SignedNameRecord) => JSON.stringify(r);
  const good = text(signRecord(base, key1));
  const older = text(signRecord({ ...base, seq: 11 }, key1));
  const byKey2 = text(signRecord({ ...base, seq: 13, signer: addressFromPrivateKey(key2) }, key2));
  const tampered = text({ record: { ...base, seq: 13 }, sig: signRecord(base, key1).sig });
  const badSig = (seq: number) => text({ record: { ...base, seq }, sig: `0x${'11'.repeat(64)}1b` });
  const rid = (n: number) => hexToBytes(n.toString(16).padStart(16, '0'));
  const want = (n: number): MeshMessage => ({ t: 'want', reqId: rid(n), origTtl: 5, root });
  const announce: MeshMessage = { t: 'announce', sites: [{ root, sizeBytes: 41002, blockCount: 9 }] };
  const have: MeshMessage = { t: 'have', reqId: rid(1), root, hops: 1, bulk: { p2pWifi: true, ble: true }, sizeBytes: 41002, blockCount: 9 };
  const site = { root: rootCid, sizeBytes: 41002, blockCount: 9 };
  const ok = { relay: true };

  const scenarios: GossipScenarioIn[] = [
    {
      id: 'unknown-subtype-relayed',
      why: 'a sub-type from a newer version is relayed untouched, as an unpatched bitchat node would',
      steps: [
        { at: 0, sender: B, ttl: 5, payloadHex: '0177', expect: ok },
        { at: 0, sender: B, ttl: 5, payloadHex: '0201', expect: ok },
      ],
    },
    {
      id: 'malformed-dropped',
      why: 'a truncated TLV is dropped, not relayed, and counts against the sender',
      steps: [{ at: 0, sender: B, ttl: 3, payloadHex: bytesToHex(encodeMessage(announce)).slice(0, -4), expect: { relay: false, drop: 'malformed', spam: true } }],
    },
    {
      id: 'direct-subtype-on-gossip',
      why: 'BLOCK_NONE belongs inside a Noise session; on public gossip it is an attack',
      steps: [{ at: 0, sender: B, ttl: 1, msg: { t: 'block-none', cid: other }, expect: { relay: false, drop: 'not-public', spam: true } }],
    },
    {
      id: 'ttl-caps',
      why: 'old relays do not know our caps, so a packet above the originator TTL was forged or mis-sent: drop it',
      steps: [
        { at: 0, sender: B, ttl: 3, msg: announce, expect: ok },
        { at: 0, sender: C, ttl: 4, msg: announce, expect: { relay: false, drop: 'ttl-over-cap', spam: true } },
        { at: 0, sender: C, ttl: 6, msg: want(1), expect: { relay: false, drop: 'ttl-over-cap', spam: true } },
        { at: 0, sender: C, ttl: 6, recipient: B, msg: have, expect: { relay: false, drop: 'ttl-over-cap', spam: true } },
        { at: 0, sender: C, ttl: 8, msg: { t: 'name-record', signed: good }, expect: { relay: false, drop: 'ttl-over-cap', spam: true } },
      ],
    },
    {
      id: 'announce-rate-limit',
      why: 'one ANNOUNCE per sender per half interval (30 s by default)',
      steps: [
        { at: 0, sender: B, ttl: 3, msg: announce, expect: ok },
        { at: 10_000, sender: B, ttl: 2, msg: announce, expect: { relay: false, drop: 'rate-limited', spam: true } },
        { at: 10_000, sender: C, ttl: 3, msg: announce, expect: ok },
        { at: 30_000, sender: B, ttl: 3, msg: announce, expect: ok },
      ],
    },
    {
      id: 'want-dedupe',
      why: 'the same reqId arriving over a second path is a duplicate: not relayed, not blamed',
      steps: [
        { at: 0, sender: B, ttl: 5, msg: want(1), expect: ok },
        { at: 50, sender: B, ttl: 4, msg: want(1), expect: { relay: false, drop: 'duplicate', spam: false } },
      ],
    },
    {
      id: 'want-answered-with-have',
      why: 'a seeder holding the site answers with a directed HAVE; hops = origTtl - ttl + 1, HAVE TTL = min(5, hops + 1)',
      setup: { sites: [site] },
      steps: [
        { at: 0, sender: B, ttl: 4, msg: want(1), expect: { relay: true, sends: 1 } },
        { at: 0, sender: C, ttl: 5, msg: { t: 'want', reqId: rid(2), origTtl: 5, root: other }, expect: { relay: true, sends: 0 } },
        // A lying origTtl (below the arriving TTL) clamps to hops = 1, HAVE TTL 2.
        { at: 0, sender: C, ttl: 5, msg: { t: 'want', reqId: rid(3), origTtl: 0, root }, expect: { relay: true, sends: 1 } },
      ],
    },
    {
      id: 'want-not-seeding',
      why: 'a node with seeding off never answers',
      config: { seeding: false },
      setup: { sites: [site] },
      steps: [{ at: 0, sender: B, ttl: 5, msg: want(1), expect: { relay: true, sends: 0 } }],
    },
    {
      id: 'want-rate-limit',
      why: 'per-sender bucket: 8 at once, then one per 2 s',
      steps: [
        ...Array.from({ length: 8 }, (_, i) => ({ at: 0, sender: B, ttl: 5, msg: want(10 + i), expect: ok })),
        { at: 0, sender: B, ttl: 5, msg: want(20), expect: { relay: false, drop: 'rate-limited', spam: true } },
        { at: 0, sender: C, ttl: 5, msg: want(21), expect: ok },
        { at: 2_000, sender: B, ttl: 5, msg: want(22), expect: ok },
        { at: 2_000, sender: B, ttl: 5, msg: want(23), expect: { relay: false, drop: 'rate-limited', spam: true } },
      ],
    },
    {
      id: 'want-unauthenticated-shared-bucket',
      why: 'unverifiable senders share one bucket, so rotating the claimed sender ID does not buy more WANTs',
      steps: [
        ...Array.from({ length: 8 }, (_, i) => ({ at: 0, sender: `d${i}`.padEnd(16, '0'), ttl: 5, authenticated: false, msg: want(30 + i), expect: ok })),
        { at: 0, sender: 'e0'.padEnd(16, '0'), ttl: 5, authenticated: false, msg: want(40), expect: { relay: false, drop: 'rate-limited', spam: true } },
        { at: 0, sender: B, ttl: 5, msg: want(41), expect: ok },
      ],
    },
    {
      id: 'have-recipient',
      why: 'a HAVE for us is consumed; a HAVE for someone else is relayed',
      steps: [
        { at: 0, sender: B, ttl: 2, recipient: SELF, msg: have, expect: { relay: false, have: true } },
        { at: 0, sender: B, ttl: 2, recipient: C, msg: have, expect: ok },
      ],
    },
    {
      id: 'name-record-unverified-then-duplicate',
      why: 'a valid record with no trusted signer is stored as unverified; the same record again is a duplicate',
      nowSec,
      steps: [
        { at: 0, sender: B, ttl: 7, msg: { t: 'name-record', signed: good }, expect: { relay: true, name: { name: 'example.eth', status: 'unverified' } } },
        { at: 100, sender: C, ttl: 6, msg: { t: 'name-record', signed: good }, expect: { relay: false, drop: 'duplicate', spam: false } },
      ],
    },
    {
      id: 'name-record-verified',
      why: 'signed by the signer learned online',
      nowSec,
      setup: { signers: { 'example.eth': signer1 } },
      steps: [{ at: 0, sender: B, ttl: 7, msg: { t: 'name-record', signed: good }, expect: { relay: true, name: { name: 'example.eth', status: 'verified' } } }],
    },
    {
      id: 'name-record-rejections',
      why: 'invalid records are not relayed; a stale seq is normal on a mesh and not blamed',
      nowSec,
      setup: { signers: { 'example.eth': signer1 }, records: [good] },
      steps: [
        { at: 0, sender: B, ttl: 7, msg: { t: 'name-record', signed: byKey2 }, expect: { relay: false, drop: 'record:not-authorized', spam: true } },
        { at: 0, sender: B, ttl: 7, msg: { t: 'name-record', signed: tampered }, expect: { relay: false, drop: 'record:signer-mismatch', spam: true } },
        { at: 0, sender: C, ttl: 7, msg: { t: 'name-record', signed: older }, expect: { relay: false, drop: 'record:stale-seq', spam: false } },
        { at: 0, sender: C, ttl: 7, msg: { t: 'name-record', signed: '{"record":' }, expect: { relay: false, drop: 'record:malformed', spam: true } },
      ],
    },
    {
      id: 'name-record-future-ts',
      why: 'ts more than 300 s ahead of the receiver clock',
      nowSec: ts - 301,
      steps: [{ at: 0, sender: B, ttl: 7, msg: { t: 'name-record', signed: good }, expect: { relay: false, drop: 'record:future-ts', spam: true } }],
    },
    {
      id: 'name-record-bucket',
      why: 'per-name bucket (4 at once) stops a flood of bad records for one name before signature checks',
      nowSec,
      steps: [
        ...[20, 21, 22, 23].map((seq) => ({ at: 0, sender: B, ttl: 7, msg: { t: 'name-record', signed: badSig(seq) } as MeshMessage, expect: { relay: false, drop: 'record:bad-signature', spam: true } })),
        { at: 0, sender: B, ttl: 7, msg: { t: 'name-record', signed: badSig(24) }, expect: { relay: false, drop: 'rate-limited', spam: false } },
      ],
    },
    {
      id: 'want-name-answered',
      why: 'a node holding the record re-broadcasts the exact signed text, at most once per 5 s per name',
      nowSec,
      setup: { records: [good] },
      steps: [
        { at: 0, sender: B, ttl: 5, msg: { t: 'want', reqId: rid(50), origTtl: 5, name: 'example.eth' }, expect: { relay: true, sends: 1 } },
        { at: 1_000, sender: C, ttl: 5, msg: { t: 'want', reqId: rid(51), origTtl: 5, name: 'example.eth' }, expect: { relay: true, sends: 0 } },
        { at: 5_000, sender: C, ttl: 5, msg: { t: 'want', reqId: rid(52), origTtl: 5, name: 'example.eth' }, expect: { relay: true, sends: 1 } },
      ],
    },
  ];

  const out = scenarios.map((sc) => {
    const g = new GossipPolicy(SELF, sc.config);
    const now = sc.nowSec ?? nowSec;
    for (const s of sc.setup?.sites ?? []) g.sites.set(s.root, { root: CID.parse(s.root), sizeBytes: s.sizeBytes, blockCount: s.blockCount, complete: true });
    for (const [n, a] of Object.entries(sc.setup?.signers ?? {})) g.trust(n, a);
    for (const r of sc.setup?.records ?? []) g.addRecord(r, now);
    const steps = sc.steps.map((st, i) => {
      const payloadHex = st.payloadHex ?? bytesToHex(encodeMessage(st.msg!));
      const auth = st.authenticated ?? true;
      const v = g.receive({ sender: st.sender, recipient: st.recipient, ttl: st.ttl, payload: hexToBytes(payloadHex), authenticated: auth }, st.at, now);
      const e = st.expect;
      const fail = (what: string) => {
        throw new Error(`gossip ${sc.id} step ${i}: ${what} (got ${JSON.stringify({ relay: v.relay, drop: v.drop, spam: v.spam, sends: v.send.length })})`);
      };
      if (v.relay !== e.relay) fail('relay');
      if (v.drop !== e.drop) fail('drop');
      if (v.spam !== (e.spam ?? false)) fail('spam');
      if (!!v.have !== !!e.have) fail('have');
      if ((v.name?.name ?? null) !== (e.name?.name ?? null) || (v.name?.status ?? null) !== (e.name?.status ?? null)) fail('name');
      if (e.sends !== undefined && v.send.length !== e.sends) fail('sends');
      return {
        at: st.at,
        sender: st.sender,
        ...(st.recipient ? { recipient: st.recipient } : {}),
        ttl: st.ttl,
        authenticated: auth,
        payloadHex,
        expect: {
          relay: v.relay,
          ...(v.drop ? { drop: v.drop } : {}),
          spam: v.spam,
          ...(v.have ? { have: { from: v.have.from, reqIdHex: bytesToHex(v.have.reqId) } } : {}),
          ...(v.name ? { name: v.name } : {}),
          send: v.send.map((o) => ({ payloadHex: bytesToHex(encodeMessage(o.msg)), ttl: o.ttl, ...(o.recipient ? { recipient: o.recipient } : {}) })),
        },
      };
    });
    return { id: sc.id, why: sc.why, config: { ...DEFAULT_GOSSIP_CONFIG, ...sc.config }, setup: sc.setup ?? {}, nowSec: now, steps };
  });

  return {
    description:
      'M3 gossip policy. Each scenario starts a fresh node with id `self` and `config`, applies `setup` (sites are complete; records are added with nowSec), then feeds `steps` in order. `at` is the node clock in ms; nowSec is the wall clock for record checks. A receiver must produce exactly `expect`: relay or not, the drop reason code, whether the sender is blamed, a consumed HAVE, an accepted name, and the packets to send (payload, TTL, recipient) in order.',
    self: SELF,
    scenarios: out,
  };
}

await mkdir(VEC, { recursive: true });
const car = await siteVectors();
await writeFile(join(VEC, 'car.json'), json(car));
await writeFile(join(VEC, 'records.json'), json(recordVectors(car.rootCid, car.origCidHint)));
await writeFile(join(VEC, 'canonical-json.json'), json(canonicalVectors()));
await writeFile(join(VEC, 'wire.json'), json(wireVectors(car.rootCid)));
await writeFile(join(VEC, 'gossip.json'), json(gossipVectors(car.rootCid, car.origCidHint)));
console.log(`vectors written to ${VEC}`);
