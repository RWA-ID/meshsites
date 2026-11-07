/**
 * Replays protocol/vectors/gossip.json against GossipPolicy. MeshSitesCore
 * (Gossip.swift) runs the same file; together they keep the two in step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { CID } from 'multiformats/cid';
import { encodeMessage, GossipPolicy } from '../src/index.ts';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '../../vectors');
const gossip = JSON.parse(await readFile(join(VEC, 'gossip.json'), 'utf8'));

for (const sc of gossip.scenarios) {
  test(`gossip ${sc.id}`, () => {
    const g = new GossipPolicy(gossip.self, sc.config);
    for (const s of sc.setup.sites ?? []) g.sites.set(s.root, { root: CID.parse(s.root), sizeBytes: s.sizeBytes, blockCount: s.blockCount, complete: true });
    for (const [n, a] of Object.entries(sc.setup.signers ?? {})) g.trust(n, a as string);
    for (const r of sc.setup.records ?? []) g.addRecord(r, sc.nowSec);
    sc.steps.forEach((st: any, i: number) => {
      const v = g.receive({ sender: st.sender, recipient: st.recipient, ttl: st.ttl, payload: hexToBytes(st.payloadHex), authenticated: st.authenticated }, st.at, sc.nowSec);
      const got = {
        relay: v.relay,
        ...(v.drop ? { drop: v.drop } : {}),
        spam: v.spam,
        ...(v.have ? { have: { from: v.have.from, reqIdHex: bytesToHex(v.have.reqId) } } : {}),
        ...(v.name ? { name: v.name } : {}),
        send: v.send.map((o) => ({ payloadHex: bytesToHex(encodeMessage(o.msg)), ttl: o.ttl, ...(o.recipient ? { recipient: o.recipient } : {}) })),
      };
      assert.deepEqual(got, st.expect, `step ${i}`);
    });
  });
}

test('gossip: spam strikes are counted per sender', () => {
  const sc = gossip.scenarios.find((s: any) => s.id === 'ttl-caps');
  const g = new GossipPolicy(gossip.self, sc.config);
  for (const st of sc.steps) g.receive({ ...st, payload: hexToBytes(st.payloadHex) }, st.at, sc.nowSec);
  assert.equal(g.spam.get('c1c1c1c1c1c1c1c1'), 4);
  assert.equal(g.spam.get('b1b1b1b1b1b1b1b1'), undefined);
});

test('gossip: ANNOUNCE sightings record hops and expire', () => {
  const sc = gossip.scenarios.find((s: any) => s.id === 'ttl-caps');
  const g = new GossipPolicy(gossip.self, { heardMs: 1000 });
  const st = sc.steps[0];
  g.receive({ ...st, payload: hexToBytes(st.payloadHex), ttl: 2 }, 0, sc.nowSec);
  const root = [...g.heard.keys()][0];
  assert.equal(g.heard.get(root)!.get(st.sender)!.hops, 2);
  // Any later MeshSites message prunes stale sightings (unknown sub-types pass straight through).
  const want = encodeMessage({ t: 'want', reqId: new Uint8Array(8), origTtl: 5, root: CID.parse(root) });
  g.receive({ sender: 'c1c1c1c1c1c1c1c1', ttl: 5, payload: want, authenticated: true }, 5000, sc.nowSec);
  assert.equal(g.heard.size, 0);
});

test('gossip: reqId dedupe window is bounded', () => {
  const g = new GossipPolicy(gossip.self, { want: { burst: 1e9, refillMs: 1 } });
  const root = CID.parse(gossip.scenarios.find((s: any) => s.id === 'want-answered-with-have').setup.sites[0].root);
  const want = (n: number) => encodeMessage({ t: 'want', reqId: hexToBytes(n.toString(16).padStart(16, '0')), origTtl: 5, root });
  for (let n = 0; n < 1500; n++) g.receive({ sender: 'b1b1b1b1b1b1b1b1', ttl: 5, payload: want(n), authenticated: true }, n, 0);
  // The oldest reqIds were evicted (1000 cap), so 0 is accepted again; 1499 is still a duplicate.
  assert.equal(g.receive({ sender: 'b1b1b1b1b1b1b1b1', ttl: 5, payload: want(0), authenticated: true }, 1500, 0).drop, undefined);
  assert.equal(g.receive({ sender: 'b1b1b1b1b1b1b1b1', ttl: 5, payload: want(1499), authenticated: true }, 1501, 0).drop, 'duplicate');
});
