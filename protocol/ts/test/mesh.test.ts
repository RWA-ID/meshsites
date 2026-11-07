/**
 * Mesh engine tests in virtual time. Covers the Phase W / M3 / M4 behaviours
 * that don't need radios: multi-hop fetch, verification badges, fallback on a
 * corrupt peer, old-client relaying, TTL caps, rate limits, dedupe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMessage, TTL } from '../src/index.ts';
import { BITCHAT, FakeScheduler, type RadioEvent, SimWorld } from '../src/mesh/index.ts';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '../../vectors');
const car = new Uint8Array(await readFile(join(VEC, 'site-basic.car')));
const records = JSON.parse(await readFile(join(VEC, 'records.json'), 'utf8'));
const carJson = JSON.parse(await readFile(join(VEC, 'car.json'), 'utf8'));
const SIGNED = records.cases.find((c: { id: string }) => c.id === 'valid-verified').input;
const SIGNER = records.testKeys[0].address;
const ROOT = carJson.rootCid;

async function seeded(w: SimWorld, holder: string) {
  const n = w.get(holder).node!;
  await n.importCar(car);
  n.addRecord(SIGNED);
}

test('C opens example.eth from A through B (2 hops, BLE): verified, byte-identical', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'B', 'C']);
  await seeded(w, 'A');
  const C = w.get('C').node!;
  C.trust('example.eth', SIGNER);
  const r = await s.runUntil(C.open('example.eth'));
  assert.equal(r.status, 'verified');
  assert.equal(r.root, ROOT);
  assert.equal(r.stats.blocks, 9);
  assert.deepEqual(r.stats.sources.map((x) => [x.peer, x.hops, x.via]), [[w.get('A').radio.peerId, 2, 'ble']]);
  for (const b of carJson.blocks) assert.ok(C.blocks.has(b.cid));
  // B only relayed; it stored nothing.
  assert.equal(w.get('B').node!.blocks.size, 0);
});

test('unknown signer → "unverified" (still opens, UI must warn)', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'B', 'C']);
  await seeded(w, 'A');
  const r = await s.runUntil(w.get('C').node!.open('example.eth'));
  assert.equal(r.status, 'unverified');
});

test('a record from the wrong signer is rejected when the trusted signer is known', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'C']);
  const A = w.get('A').node!;
  await A.importCar(car);
  A.addRecord(records.cases.find((c: { id: string }) => c.id === 'wrong-signer').input);
  const C = w.get('C').node!;
  C.trust('example.eth', SIGNER);
  await assert.rejects(s.runUntil(C.open('example.eth')), /no NAME_RECORD/);
  assert.ok((C.spam.get(w.get('A').radio.peerId) ?? 0) >= 1);
});

test('works across an UNPATCHED bitchat node (old client relays unknown type 0x4D and directed noise)', async () => {
  const s = new FakeScheduler();
  const w = new SimWorld(s);
  w.add('A');
  w.add('Old', { patched: false });
  w.add('C');
  w.link('A', 'Old');
  w.link('Old', 'C');
  await seeded(w, 'A');
  const C = w.get('C').node!;
  C.trust('example.eth', SIGNER);
  const r = await s.runUntil(C.open('example.eth'));
  assert.equal(r.status, 'verified');
  assert.equal(r.stats.sources[0].hops, 2);
});

test('a corrupt holder is detected and the fetch falls back to an honest one', async () => {
  const s = new FakeScheduler();
  const w = new SimWorld(s);
  w.add('A');
  w.add('B');
  w.add('Evil', { corruptBlocks: true });
  w.add('C');
  w.link('A', 'B');
  w.link('B', 'C');
  w.link('Evil', 'C'); // Evil is closer (1 hop) and is tried first
  await seeded(w, 'A');
  await w.get('Evil').node!.importCar(car);
  const C = w.get('C').node!;
  const r = await s.runUntil(C.open(ROOT));
  assert.equal(r.status, 'raw-cid');
  assert.ok(r.stats.corruptRejected >= 1);
  assert.equal(r.stats.sources[0].peer, w.get('Evil').radio.peerId);
  assert.equal(r.stats.sources.at(-1)!.peer, w.get('A').radio.peerId);
  for (const b of carJson.blocks) assert.ok(C.blocks.has(b.cid));
  assert.ok((C.spam.get(w.get('Evil').radio.peerId) ?? 0) >= 1);
});

test('adjacent bulk-capable holder is preferred and is much faster than BLE', async () => {
  const time = async (bulk: boolean) => {
    const s = new FakeScheduler();
    const w = new SimWorld(s);
    w.add('A');
    w.add('C');
    w.link('A', 'C', { bulk });
    await seeded(w, 'A');
    const r = await s.runUntil(w.get('C').node!.open(ROOT));
    return r.stats;
  };
  const ble = await time(false);
  const bulk = await time(true);
  assert.equal(ble.sources[0].via, 'ble');
  assert.equal(bulk.sources[0].via, 'bulk');
  // Exclude the fixed 3 s HAVE window from the comparison.
  assert.ok(bulk.ms - 3000 < (ble.ms - 3000) / 5, `bulk ${bulk.ms} vs ble ${ble.ms}`);
});

test('forced relay: A and C in range but blocked from each other still reach via B', async () => {
  const s = new FakeScheduler();
  const w = new SimWorld(s);
  for (const n of ['A', 'B', 'C']) w.add(n);
  w.link('A', 'B');
  w.link('B', 'C');
  w.link('A', 'C');
  w.get('C').radio.blocked.add(w.get('A').radio.peerId);
  w.get('A').radio.blocked.add(w.get('C').radio.peerId);
  await seeded(w, 'A');
  const r = await s.runUntil(w.get('C').node!.open(ROOT));
  assert.equal(r.stats.sources[0].hops, 2);
});

test('a site cached by a fetcher is served onward (B fetches, then D gets it from B)', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'B', 'D']);
  await seeded(w, 'A');
  await s.runUntil(w.get('B').node!.open(ROOT));
  w.unlink('A', 'B'); // A leaves
  const r = await s.runUntil(w.get('D').node!.open(ROOT));
  assert.equal(r.stats.sources[0].peer, w.get('B').radio.peerId);
});

test('no holder → clear error after one re-WANT', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'B']);
  await assert.rejects(s.runUntil(w.get('B').node!.open(ROOT)), /could not fetch/);
});

function capture(w: SimWorld) {
  const ev: (RadioEvent & { node: string })[] = [];
  for (const n of w.nodes.values()) n.radio.listeners.push((e) => ev.push({ ...e, node: n.name }));
  return ev;
}

test('patched relays drop gossip whose TTL exceeds the cap (and count it as spam)', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'B', 'C']);
  const ev = capture(w);
  const A = w.get('A').radio;
  const payload = encodeMessage({ t: 'want', reqId: new Uint8Array(8).fill(9), origTtl: 7, root: (await w.get('C').node!.importCar(car)).root });
  A.send({ type: BITCHAT.type.meshSites, sender: A.peerId, ttl: 7, ts: A.nextTs(), payload });
  await s.advance(2000);
  assert.ok(ev.some((e) => e.kind === 'drop' && e.node === 'B' && e.reason.includes('not relayed')));
  assert.ok(!ev.some((e) => e.kind === 'rx' && e.node === 'C'));
  assert.equal(w.get('B').node!.spam.get(A.peerId), 1);
});

test('announce rate limit: a second ANNOUNCE within 60 s is not relayed', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'B', 'C']);
  const A = w.get('A').node!;
  await A.importCar(car);
  await s.advance(1000); // first announce goes out
  const ev = capture(w);
  A.announce();
  await s.advance(1000);
  assert.ok(!ev.some((e) => e.kind === 'rx' && e.node === 'C'), 'C must not hear the spammy announce');
  assert.ok(w.get('C').node!.heard.get(ROOT)?.has(A.id), 'C did hear the first announce');
  assert.equal(w.get('C').node!.heard.get(ROOT)!.get(A.id)!.hops, 2);
});

test('WANT dedupe by reqId: a re-sent WANT (new timestamp, same reqId) is not relayed again', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'B', 'C']);
  const ev = capture(w);
  const A = w.get('A').radio;
  const payload = encodeMessage({ t: 'want', reqId: new Uint8Array(8).fill(7), origTtl: TTL.want, name: 'x.eth' });
  for (let i = 0; i < 2; i++) {
    A.send({ type: BITCHAT.type.meshSites, sender: A.peerId, ttl: TTL.want, ts: A.nextTs(), payload });
    await s.advance(500);
  }
  assert.equal(ev.filter((e) => e.kind === 'rx' && e.node === 'C').length, 1);
});

test('TTL semantics match bitchat: TTL 3 reaches exactly 3 hops', async () => {
  const s = new FakeScheduler();
  const w = SimWorld.chain(s, ['A', 'B', 'C', 'D', 'E']);
  await w.get('A').node!.importCar(car);
  await s.advance(2000);
  assert.ok(w.get('D').node!.heard.has(ROOT));
  assert.ok(!w.get('E').node!.heard.has(ROOT));
});

test('a non-seeding node does not answer WANT', async () => {
  const s = new FakeScheduler();
  const w = new SimWorld(s);
  w.add('A', { seeding: false });
  w.add('C');
  w.link('A', 'C');
  await w.get('A').node!.importCar(car);
  await assert.rejects(s.runUntil(w.get('C').node!.open(ROOT)), /could not fetch/);
});
