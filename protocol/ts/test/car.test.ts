import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { sha512 } from 'multiformats/hashes/sha2';
import { CarBlockIterator } from '@ipld/car/iterator';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSiteCar, checkBlock, readSiteDir, verifyCar, writeCar, LIMITS } from '../src/index.ts';

const site = (n: number) => [
  { path: 'index.html', content: utf8ToBytes('<h1>hi</h1>') },
  { path: 'big.bin', content: noise(n) },
];

/** Non-repeating bytes, so chunks don't dedupe. */
function noise(n: number) {
  const out = new Uint8Array(n);
  let x = 0x12345678;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

async function blocksOf(car: Uint8Array) {
  const out: { cid: CID; bytes: Uint8Array }[] = [];
  for await (const b of await CarBlockIterator.fromBytes(car)) out.push(b);
  return out;
}

test('a 1 MiB-limit site builds with 16 KiB leaves and verifies', async () => {
  const built = await buildSiteCar(site(200 * 1024));
  const leaves = built.blocks.filter((b) => b.cid.startsWith('bafkrei'));
  assert.ok(leaves.length >= 13);
  for (const l of leaves) assert.ok(l.size <= LIMITS.chunkSize);
  assert.equal((await verifyCar(built.car)).ok, true);
});

test('a site over 1 MiB is refused at build time', async () => {
  await assert.rejects(buildSiteCar(site(LIMITS.maxSiteBytes + 1)), /max 1048576/);
});

test('a dedupe bomb (one leaf referenced thousands of times) is rejected by the logical-size cap', async () => {
  // 6 MiB of zeros: every 16 KiB leaf is the same block, so the CAR is tiny.
  const built = await buildSiteCar([{ path: 'index.html', content: new Uint8Array(6 * 1024 * 1024) }]).catch((e) => e);
  assert.ok(built instanceof Error && /expands to 6291456 bytes/.test(built.message), String(built));
});

test('flipping any single byte of any block is detected', async () => {
  const built = await buildSiteCar(site(40 * 1024));
  const blocks = await blocksOf(built.car);
  for (let i = 0; i < blocks.length; i++) {
    const tampered = blocks.map((b, j) => {
      if (j !== i) return b;
      const bytes = b.bytes.slice();
      bytes[bytes.length >> 1] ^= 0x80;
      return { cid: b.cid, bytes };
    });
    const res = await verifyCar(await writeCar([built.root], tampered));
    assert.equal(res.ok, false, `block ${i} tamper not detected`);
    assert.ok(res.errors.some((e) => e.includes('hash mismatch')));
  }
});

test('non-sha256 and CIDv0 blocks are rejected', async () => {
  const bytes = utf8ToBytes('x');
  const v1sha512 = CID.createV1(raw.code, await sha512.digest(bytes));
  assert.match(checkBlock(v1sha512, bytes) ?? '', /sha2-256/);
  const v0 = CID.createV0(await sha256.digest(bytes));
  assert.match(checkBlock(v0, bytes) ?? '', /CIDv1/);
});

test('a CAR with two roots is rejected', async () => {
  const built = await buildSiteCar(site(10));
  const blocks = await blocksOf(built.car);
  const res = await verifyCar(await writeCar([built.root, blocks[1].cid], blocks));
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /2 roots/);
});

test('garbage input is rejected without throwing', async () => {
  const res = await verifyCar(utf8ToBytes('definitely not a car file'));
  assert.equal(res.ok, false);
});

test('dotfiles and .DS_Store are skipped and do not change the CID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meshsites-'));
  await writeFile(join(dir, 'index.html'), '<h1>hi</h1>');
  const clean = await buildSiteCar((await readSiteDir(dir)).files);
  await writeFile(join(dir, '.DS_Store'), 'junk');
  await mkdir(join(dir, '.git'));
  await writeFile(join(dir, '.git', 'HEAD'), 'ref');
  const { files, skipped } = await readSiteDir(dir);
  assert.deepEqual(skipped.sort(), ['.DS_Store', '.git']);
  assert.equal((await buildSiteCar(files)).root.toString(), clean.root.toString());
});
