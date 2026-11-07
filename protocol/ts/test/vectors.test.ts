/**
 * The committed vectors are the contract with MeshSitesCore (Swift). These
 * tests fail if the TS implementation drifts from them.
 */
import { readSiteDir } from '../src/node.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { hashMessage, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  addressFromPrivateKey,
  buildSiteCar,
  canonicalJson,
  CanonicalJsonError,
  eip191Hash,
  kuboDefaultCid,
  recordMessage,
  signRecord,
  verifyCar,
  verifyRecord,
} from '../src/index.ts';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '../../vectors');
const load = async (f: string) => JSON.parse(await readFile(join(VEC, f), 'utf8'));
const carJson = await load('car.json');
const records = await load('records.json');
const canon = await load('canonical-json.json');

test('site-basic builds to the committed root, block list and CAR bytes', async () => {
  const { files } = await readSiteDir(join(VEC, carJson.input));
  const built = await buildSiteCar(files);
  assert.equal(built.root.toString(), carJson.rootCid);
  assert.deepEqual(built.blocks, carJson.blocks);
  assert.equal(built.totalBytes, carJson.totalBytes);
  assert.deepEqual(built.car, new Uint8Array(await readFile(join(VEC, carJson.car))));
  assert.equal((await kuboDefaultCid(files)).toString(), carJson.origCidHint);
});

test('every block of site-basic is at most 16 KiB of file data', () => {
  for (const b of carJson.blocks) if (b.cid.startsWith('bafkrei')) assert.ok(b.size <= 16384, b.cid);
});

test('site-basic.car verifies', async () => {
  const res = await verifyCar(new Uint8Array(await readFile(join(VEC, carJson.car))), { expectedRoot: carJson.rootCid });
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.blockCount, carJson.blocks.length);
});

for (const n of carJson.negatives) {
  test(`negative CAR rejected: ${n.file} (${n.why})`, async () => {
    const res = await verifyCar(new Uint8Array(await readFile(join(VEC, n.file))));
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e: string) => e.includes(n.expect.errorContains)), res.errors.join('; '));
  });
}

test('expectedRoot mismatch is rejected', async () => {
  const res = await verifyCar(new Uint8Array(await readFile(join(VEC, carJson.car))), {
    expectedRoot: 'bafkreihzaauexlawvjv5ieuwx6taubz5dsymgtnr6qteu2kxqtspn5rjfe',
  });
  assert.equal(res.ok, false);
});

test('site size cap is enforced', async () => {
  const res = await verifyCar(new Uint8Array(await readFile(join(VEC, carJson.car))), { maxSiteBytes: carJson.totalBytes - 1 });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('max')));
});

test('test keys derive from their seeds', () => {
  for (const k of records.testKeys) {
    assert.equal(addressFromPrivateKey(hexToBytes(k.privateKey.slice(2))), k.address);
  }
});

for (const s of records.signing) {
  test(`signing vector ${s.record.name}: canonical JSON, EIP-191 hash, signature`, () => {
    const key = hexToBytes(records.testKeys[0].privateKey.slice(2));
    assert.equal(recordMessage(s.record), s.canonicalJson);
    assert.equal(bytesToHex(utf8ToBytes(s.canonicalJson)), s.canonicalJsonUtf8Hex);
    assert.equal(`0x${bytesToHex(eip191Hash(s.canonicalJson))}`, s.eip191Hash);
    assert.equal(signRecord(s.record, key).sig, s.sig);
  });

  test(`signing vector ${s.record.name} matches viem (independent implementation)`, async () => {
    const acct = privateKeyToAccount(records.testKeys[0].privateKey);
    assert.equal(hashMessage(s.canonicalJson), s.eip191Hash);
    assert.equal(await acct.signMessage({ message: s.canonicalJson }), s.sig);
    assert.equal((await recoverMessageAddress({ message: s.canonicalJson, signature: s.sig })).toLowerCase(), s.record.signer);
  });
}

for (const c of records.cases) {
  test(`record case ${c.id}: ${c.why}`, () => {
    const got = verifyRecord(c.input, c.options);
    assert.equal(got.ok, c.expect.ok, JSON.stringify(got));
    if (got.ok) {
      assert.equal(got.status, c.expect.status);
      assert.equal(got.signer, c.expect.signer);
    } else {
      assert.equal(got.reason, c.expect.reason, got.detail);
    }
  });
}

for (const c of canon.cases) {
  test(`canonical JSON: ${c.output}`, () => {
    assert.equal(canonicalJson(c.input), c.output);
    assert.equal(bytesToHex(utf8ToBytes(c.output)), c.outputUtf8Hex);
  });
}

for (const c of canon.mustReject) {
  test(`canonical JSON rejects ${c.why}`, () => {
    assert.throws(() => canonicalJson(JSON.parse(c.input)), CanonicalJsonError);
  });
}

test('canonical JSON rejects lone surrogates', () => {
  assert.throws(() => canonicalJson({ s: '\ud800' }), CanonicalJsonError);
});
