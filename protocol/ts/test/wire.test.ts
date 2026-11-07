import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { decodeMessage, encodeMessage, WireError } from '../src/index.ts';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '../../vectors');
const wire = JSON.parse(await readFile(join(VEC, 'wire.json'), 'utf8'));

for (const v of wire.valid) {
  test(`wire ${v.id}: decode → encode is byte-identical`, () => {
    const m = decodeMessage(hexToBytes(v.hex));
    assert.ok(m);
    assert.equal(bytesToHex(encodeMessage(m)), v.hex);
  });
}

for (const v of wire.invalid) {
  test(`wire ${v.id}: ${v.expect}`, () => {
    const run = () => decodeMessage(hexToBytes(v.hex));
    if (v.expect === 'invalid') assert.throws(run, WireError);
    else if (v.expect === 'ignore') assert.equal(run(), null);
    else assert.ok(run());
  });
}

test('every public gossip message fits one BLE frame (≤ 469 B payload)', () => {
  for (const v of wire.valid) if (!v.id.startsWith('block')) assert.ok(v.hex.length / 2 <= 469, v.id);
});

test('encoder refuses out-of-range values', () => {
  const root = decodeMessage(hexToBytes(wire.valid.find((v: { id: string }) => v.id === 'announce').hex));
  assert.ok(root && root.t === 'announce');
  const site = root.sites[0];
  assert.throws(() => encodeMessage({ t: 'announce', sites: Array(9).fill(site) }), WireError);
  assert.throws(() => encodeMessage({ t: 'announce', sites: [] }), WireError);
  assert.throws(() => encodeMessage({ t: 'want', reqId: new Uint8Array(7), origTtl: 5, root: site.root }), WireError);
  assert.throws(() => encodeMessage({ t: 'want', reqId: new Uint8Array(8), origTtl: 5 }), WireError);
});
