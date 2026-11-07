/**
 * Replays protocol/vectors/fetch.json against Fetcher and Server.
 * MeshSitesCore (Fetch.swift) runs the same file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { CID } from 'multiformats/cid';
import { encodeMessage, type FetchAction, Fetcher, Server } from '../src/index.ts';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '../../vectors');
const v = JSON.parse(await readFile(join(VEC, 'fetch.json'), 'utf8'));
const sets: Record<string, { root: CID; blocks: Map<string, Uint8Array> }> = {};
for (const [k, s] of Object.entries<any>(v.blockSets)) {
  sets[k] = { root: CID.parse(s.root), blocks: new Map(Object.entries<string>(s.blocks).map(([c, h]) => [c, hexToBytes(h)])) };
}

const enc = (a: FetchAction) => {
  switch (a.a) {
    case 'request': return { a: a.a, peer: a.peer, via: a.via, cids: a.cids.map(String), deadline: a.deadline };
    case 'stored': return { a: a.a, cid: a.cid.toString() };
    case 'blame': return { a: a.a, peer: a.peer, reason: a.reason };
    case 'next': return { a: a.a, from: a.from, reason: a.reason };
    case 'done': return { a: a.a, totalBytes: a.totalBytes, blockCount: a.blockCount };
    case 'failed': return { a: a.a, reason: a.reason };
  }
};

for (const sc of v.fetch) {
  test(`fetch ${sc.id}`, () => {
    const set = sets[sc.blockSet];
    const local = new Set<string>(sc.local);
    const f = new Fetcher(set.root, sc.holders, { get: (c) => (local.has(c.toString()) ? set.blocks.get(c.toString()) : undefined) });
    sc.steps.forEach((st: any, i: number) => {
      const e = st.event;
      let acts: FetchAction[];
      if (e.ev === 'start') acts = f.start(e.at);
      else if (e.ev === 'tick') acts = f.tick(e.at);
      else if (e.ev === 'none') acts = f.onBlockNone(e.peer, CID.parse(e.cid), e.at);
      else {
        let b = set.blocks.get(e.cid)!;
        if (e.bytes === 'corrupt') {
          b = b.slice();
          b[b.length >> 1] ^= 0xff;
        }
        acts = f.onBlock(e.peer, CID.parse(e.cid), b, e.at);
      }
      assert.deepEqual(acts.map(enc), st.actions, `step ${i} (${e.ev})`);
    });
  });
}

for (const sc of v.server) {
  test(`server ${sc.id}`, () => {
    const s = new Server(sc.config);
    const site = sets['site-basic'];
    const lookup = (root: CID, cid: CID) => (root.equals(site.root) ? site.blocks.get(cid.toString()) : undefined);
    sc.steps.forEach((st: any, i: number) => {
      const r = s.handle(st.peer, hexToBytes(st.payloadHex), st.at, lookup);
      const got =
        r.kind === 'reply' ? { kind: r.kind, messagesHex: r.messages.map((m) => bytesToHex(encodeMessage(m))) }
        : r.kind === 'block' ? { kind: r.kind, cid: r.cid.toString(), bytesHex: bytesToHex(r.bytes) }
        : r.kind === 'block-none' ? { kind: r.kind, cid: r.cid.toString() }
        : { kind: r.kind, reason: r.reason, spam: r.spam };
      assert.deepEqual(got, st.expect, `step ${i}`);
    });
  });
}

test('fetch: late answers after a failover are ignored', () => {
  const set = sets['site-basic'];
  const f = new Fetcher(set.root, [
    { peer: 'b', via: 'ble', hops: 1, sizeBytes: 41002, blockCount: 9 },
    { peer: 'c', via: 'ble', hops: 1, sizeBytes: 41002, blockCount: 9 },
  ]);
  const [req] = f.start(0) as Extract<FetchAction, { a: 'request' }>[];
  f.onBlockNone('b', req.cids[0], 1); // moves to c
  const root = req.cids[0];
  assert.deepEqual(f.onBlock('b', root, set.blocks.get(root.toString())!, 2), [], 'b is no longer asked');
  assert.equal(f.onBlock('c', root, set.blocks.get(root.toString())!, 3)[0].a, 'stored');
});
