import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BOX_LIMITS, buildSiteCar, parsePrivateKey, signRecord, verifyCar, type NameRecord } from '@meshsites/protocol';
import { createSocket } from 'node:dgram';
import { createBox, dnsAnswer, loadBox, startDns, type BoxServer } from '../src/serve.ts';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'cli/src/main.ts');
const VEC = join(ROOT, 'protocol/vectors');
const records = JSON.parse(await readFile(join(VEC, 'records.json'), 'utf8'));
const [KEY, KEY2] = records.testKeys;
const BASIC = JSON.parse(await readFile(join(VEC, 'car.json'), 'utf8')).rootCid as string;
const EMERGENCIA = 'bafybeigvgj6gkgunhyhvrjejx6tzhmox6qzmk3i3dup3h7qkykpsweb76a';
const NOW = 1762470000;
const enc = (s: string) => new TextEncoder().encode(s);

function record(name: string, cid: string, seq: number, key = KEY) {
  const r: NameRecord = { v: 1, name, cid, origCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', seq, ts: NOW, signer: key.address.toLowerCase() };
  return signRecord(r, parsePrivateKey(key.privateKey));
}

let dir: string;
let box: BoxServer;
let server: Server;
let port: number;
let bigCid: string;
let bigFile: Uint8Array;
let xssCid: string;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** fetch() won't let us set Host, and Host is what the box routes on. */
function get(host: string, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'meshsites-box-'));
  await copyFile(join(VEC, 'site-basic.car'), join(dir, 'basic.car'));
  await copyFile(join(ROOT, 'examples/emergencia.car'), join(dir, 'emergencia.car'));
  await copyFile(join(VEC, 'site-basic.tampered-block.car'), join(dir, 'tampered.car'));

  // 2 MiB of incompressible data: over the mesh cap, fine for a box.
  bigFile = new Uint8Array(randomBytes(2 * 1024 * 1024));
  const big = await buildSiteCar(
    [
      { path: 'index.html', content: enc('<!doctype html><title>Big site</title><video src="clip.mp4"></video>') },
      { path: 'clip.mp4', content: bigFile },
    ],
    { limits: BOX_LIMITS },
  );
  bigCid = big.root.toString();
  await writeFile(join(dir, 'big.car'), big.car);

  const xss = await buildSiteCar([{ path: 'index.html', content: enc('<title>a &lt;img src=x onerror=alert(1)&gt; &amp; b</title>') }]);
  xssCid = xss.root.toString();
  await writeFile(join(dir, 'xss.car'), xss.car);

  await writeFile(join(dir, 'example.record.signed.json'), JSON.stringify(record('example.eth', BASIC, 12)));
  await writeFile(join(dir, 'example-old.record.signed.json'), JSON.stringify(record('example.eth', EMERGENCIA, 5)));
  await writeFile(join(dir, 'loose.record.signed.json'), JSON.stringify(record('loose.eth', EMERGENCIA, 3)));
  // Signed by the wrong key for a pinned name: refused.
  await writeFile(join(dir, 'forged.record.signed.json'), JSON.stringify(record('example.eth', xssCid, 99, KEY2)));
  // Two signers, nothing pinned: the name is not served at all.
  await writeFile(join(dir, 'split-a.record.signed.json'), JSON.stringify(record('split.eth', BASIC, 1)));
  await writeFile(join(dir, 'split-b.record.signed.json'), JSON.stringify(record('split.eth', EMERGENCIA, 2, KEY2)));
  await writeFile(join(dir, 'signers.json'), JSON.stringify({ 'example.eth': KEY.address }));
  await writeFile(join(dir, 'notes.json'), JSON.stringify({ hello: 'not a record' }));

  box = await createBox(dir, { domain: 'mesh.lan', now: NOW });
  server = createServer(box.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('loadBox keeps verified CARs and refuses the rest, with reasons', () => {
  const c = box.contents();
  assert.deepEqual([...c.sites.keys()].sort(), [BASIC, EMERGENCIA, bigCid, xssCid].sort());
  assert.ok(c.problems.some((p) => p.startsWith('tampered.car: ') && p.includes('hash mismatch')), c.problems.join('\n'));
  assert.equal(c.sites.get(BASIC)!.mesh, true);
  assert.equal(c.sites.get(bigCid)!.mesh, false);
  assert.equal(c.sites.get(bigCid)!.title, 'Big site');
});

test('names resolve offline from signed records: pinned signer, highest seq, forgeries refused', () => {
  const c = box.contents();
  const ex = c.names.get('example.eth')!;
  assert.equal(ex.cid, BASIC);
  assert.equal(ex.seq, 12);
  assert.equal(ex.status, 'verified');
  assert.equal(c.names.get('loose.eth')!.status, 'unverified');
  assert.ok(!c.names.has('split.eth'));
  assert.ok(c.problems.some((p) => p.startsWith('forged.record.signed.json: not-authorized')), c.problems.join('\n'));
  assert.ok(c.problems.some((p) => p.startsWith('split.eth: records from more than one signer')));
  assert.ok(!c.problems.some((p) => p.startsWith('notes.json')));
});

test('a newer record whose CAR is missing does not take the name down', async () => {
  const d = await mkdtemp(join(tmpdir(), 'meshsites-box-'));
  await copyFile(join(VEC, 'site-basic.car'), join(d, 'basic.car'));
  await writeFile(join(d, 'a.json'), JSON.stringify(record('example.eth', BASIC, 1)));
  await writeFile(join(d, 'b.json'), JSON.stringify(record('example.eth', EMERGENCIA, 2)));
  const c = await loadBox(d, { now: NOW });
  assert.equal(c.names.get('example.eth')!.seq, 1);
  assert.ok(c.problems.some((p) => p.includes('newest record (seq 2) has no CAR here')));
  await rm(d, { recursive: true, force: true });
});

test('a site is served on its own origin by CID, with a self-only CSP', async () => {
  const host = `${BASIC}.mesh.lan:${port}`;
  const r = await get(host, '/');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /^text\/html/);
  assert.deepEqual(r.body, await readFile(join(VEC, 'site-basic/index.html')));
  assert.match(String(r.headers['content-security-policy']), new RegExp(`^default-src http://${BASIC}\\.mesh\\.lan:${port};`));
  assert.equal(r.headers['x-meshsites-root'], BASIC);
  assert.match(String(r.headers['cache-control']), /immutable/);

  const css = await get(host, '/css/site.css');
  assert.equal(css.status, 200);
  assert.match(String(css.headers['content-type']), /^text\/css/);
  assert.deepEqual(css.body, await readFile(join(VEC, 'site-basic/css/site.css')));

  const dirRedirect = await get(host, '/css');
  assert.equal(dirRedirect.status, 301);
  assert.equal(dirRedirect.headers.location, 'css/');
  assert.equal((await get(host, '/nope.html')).status, 404);
  // Dot segments are resolved inside the site (URL rules); they can't climb out of it.
  assert.deepEqual((await get(host, '/css/%2e%2e/%2e%2e/index.html')).body, r.body);
  assert.equal((await get(host, '/%zz')).status, 400);
});

test('a name host serves the site its record points at, and is not cached as immutable', async () => {
  for (const host of [`example.eth:${port}`, `example.eth.mesh.lan:${port}`, `EXAMPLE.eth.:${port}`]) {
    const r = await get(host, '/');
    assert.equal(r.status, 200, host);
    assert.equal(r.headers['x-meshsites-root'], BASIC, host);
    assert.equal(r.headers['cache-control'], 'no-cache', host);
  }
  const unknown = await get(`nobody.eth:${port}`, '/');
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.toString(), /nobody\.eth<\/span> isn't stored here/);
  assert.equal((await get(`split.eth:${port}`, '/')).status, 404);
  assert.equal((await get(`bafynotreal.mesh.lan:${port}`, '/')).status, 404);
});

test('any other host is sent to the box (captive portal)', async () => {
  for (const [host, path] of [['captive.apple.com', '/hotspot-detect.html'], ['connectivitycheck.gstatic.com', '/generate_204'], ['example.com', '/']]) {
    const r = await get(host, path);
    assert.equal(r.status, 302, host);
    assert.equal(r.headers.location, `http://mesh.lan/`, host);
  }
  assert.equal((await get(`example.com:${port}`, '/x')).headers.location, `http://mesh.lan:${port}/`);
});

test('the list: subdomain links by name, path links by IP, titles escaped', async () => {
  const byName = (await get(`mesh.lan:${port}`, '/')).body.toString();
  assert.ok(byName.includes(`href="http://example.eth.mesh.lan:${port}/"`));
  assert.ok(byName.includes(`href="http://${bigCid}.mesh.lan:${port}/"`));
  assert.ok(byName.includes('Name verified'));
  assert.ok(byName.includes('Name not checked against ENS'));
  assert.ok(byName.includes('Wi-Fi only'));

  const r = await get(`127.0.0.1:${port}`, '/');
  const byIp = r.body.toString();
  assert.ok(byIp.includes('href="/ipns/example.eth/"'));
  assert.ok(byIp.includes(`href="/ipfs/${bigCid}/"`));
  assert.ok(!byIp.includes('<img'), 'a site title must not inject markup');
  assert.ok(byIp.includes('a &#60;img src=x onerror=alert(1)&#62; &#38; b'));
  assert.match(String(r.headers['content-security-policy']), /^default-src 'none'/);
});

test('by IP, sites are served under /ipfs and /ipns with a path-scoped CSP', async () => {
  const host = `127.0.0.1:${port}`;
  const bare = await get(host, `/ipfs/${BASIC}`);
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.location, `/ipfs/${BASIC}/`);
  const r = await get(host, `/ipfs/${BASIC}/js/app.js`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, await readFile(join(VEC, 'site-basic/js/app.js')));
  assert.match(String(r.headers['content-security-policy']), new RegExp(`^default-src http://127\\.0\\.0\\.1:${port}/ipfs/${BASIC}/;`));
  const named = await get(host, '/ipns/example.eth/');
  assert.equal(named.status, 200);
  assert.equal(named.headers['x-meshsites-root'], BASIC);
  assert.equal((await get(host, '/ipns/split.eth/')).status, 404);
  assert.equal((await get(host, '/etc/passwd')).status, 404);
});

test('a site over the mesh cap is served, with byte ranges for media', async () => {
  const host = `${bigCid}.mesh.lan:${port}`;
  const whole = await get(host, '/clip.mp4');
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.ok(whole.body.equals(bigFile));

  const part = await get(host, '/clip.mp4', { range: 'bytes=100000-100099' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 100000-100099/${bigFile.length}`);
  assert.ok(part.body.equals(bigFile.subarray(100000, 100100)));

  const tail = await get(host, '/clip.mp4', { range: 'bytes=-10' });
  assert.equal(tail.status, 206);
  assert.ok(tail.body.equals(bigFile.subarray(bigFile.length - 10)));
  const open = await get(host, '/clip.mp4', { range: `bytes=${bigFile.length - 5}-` });
  assert.equal(open.body.length, 5);
  assert.equal((await get(host, '/clip.mp4', { range: `bytes=${bigFile.length}-` })).status, 416);

  const head = await get(host, '/clip.mp4', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(bigFile.length));
  assert.equal(head.body.length, 0);

  // The mesh rules still refuse it.
  const mesh = await verifyCar(new Uint8Array(await readFile(join(dir, 'big.car'))));
  assert.equal(mesh.ok, false);
  assert.ok(mesh.errors.some((e) => /max 1048576/.test(e)));
});

test('raw CARs and signed records are served for clients that verify for themselves', async () => {
  const host = `mesh.lan:${port}`;
  const car = await get(host, `/car/${BASIC}.car`);
  assert.equal(car.status, 200);
  assert.equal(car.headers['content-type'], 'application/vnd.ipld.car');
  assert.equal((await verifyCar(new Uint8Array(car.body), { expectedRoot: BASIC })).ok, true);
  assert.equal((await get(host, '/car/bafynope.car')).status, 404);

  const rec = await get(host, '/record/example.eth.json');
  assert.equal(rec.status, 200);
  assert.deepEqual(JSON.parse(rec.body.toString()), record('example.eth', BASIC, 12));
  assert.equal((await get(host, '/record/split.eth.json')).status, 404);

  const list = JSON.parse((await get(host, '/sites.json')).body.toString());
  assert.equal(list.sites.length, 4);
  const basic = list.sites.find((s: { cid: string }) => s.cid === BASIC);
  assert.deepEqual(basic.names.map((n: { name: string; status: string }) => [n.name, n.status]), [['example.eth', 'verified']]);
  assert.equal(list.sites.find((s: { cid: string }) => s.cid === bigCid).mesh, false);
});

test('only GET and HEAD', async () => {
  const r = await get(`mesh.lan:${port}`, '/', {}, 'POST');
  assert.equal(r.status, 405);
});

test('a CAR dropped into the folder appears without a restart; a corrupted one stops being served', async () => {
  const site = await buildSiteCar([{ path: 'index.html', content: enc('<title>Late arrival</title>') }]);
  const cid = site.root.toString();
  assert.equal((await get(`${cid}.mesh.lan:${port}`, '/')).status, 404);
  await writeFile(join(dir, 'late.car'), site.car);
  assert.equal((await get(`${cid}.mesh.lan:${port}`, '/')).status, 200);
  assert.ok((await get(`mesh.lan:${port}`, '/')).body.toString().includes('Late arrival'));

  // Flip a byte in place (the folder's mtime doesn't change): re-verification on load catches it.
  await box.reload();
  const bytes = await readFile(join(dir, 'late.car'));
  bytes[bytes.length - 3] ^= 0xff;
  await writeFile(join(dir, 'late.car'), bytes);
  const r = await get(`${cid}.mesh.lan:${port}`, '/');
  assert.equal(r.status, 503);
  assert.match(r.body.toString(), /failed verification/);
});

test('publish: over 1 MiB needs --box; verify --box accepts what plain verify refuses', async () => {
  const d = await mkdtemp(join(tmpdir(), 'meshsites-pub-'));
  const site = join(d, 'site');
  await run('mkdir', [site]);
  await writeFile(join(site, 'index.html'), '<title>big</title>');
  await writeFile(join(site, 'blob.bin'), randomBytes(1200 * 1024));
  const cli = (args: string[]) =>
    run(process.execPath, [CLI, ...args], { env: { ...process.env, MS_KEY: KEY.privateKey } }).then(
      (r) => ({ code: 0, ...r }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
  const out = join(d, 'site.car');
  const plain = await cli(['publish', site, '--name', 'example.eth', '--out', out, '--key-env', 'MS_KEY']);
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, /the mesh limit is 1048576\. Pass --box/);
  const boxed = await cli(['publish', site, '--name', 'example.eth', '--out', out, '--key-env', 'MS_KEY', '--box']);
  assert.equal(boxed.code, 0, boxed.stderr);
  assert.match(boxed.stderr, /phones will not pass it on over Bluetooth/);
  assert.equal((await cli(['verify', out])).code, 1);
  assert.equal((await cli(['verify', out, '--box'])).code, 0);
  await rm(d, { recursive: true, force: true });
});

/** A one-question DNS query. */
function dnsQuery(name: string, qtype: number, id = 0x1234): Uint8Array {
  const labels = name.split('.').flatMap((l) => [l.length, ...enc(l)]);
  return new Uint8Array([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, qtype >> 8, qtype & 0xff, 0, 1]);
}

test('box DNS: every name is the box; non-A questions get an empty answer', () => {
  const q = dnsQuery('meshsites.eth', 1);
  const a = dnsAnswer(q, [192, 168, 8, 2])!;
  assert.deepEqual([...a.subarray(0, 12)], [0x12, 0x34, 0x85, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(a.subarray(12, q.length), q.subarray(12), 'question echoed');
  assert.deepEqual([...a.subarray(q.length)], [0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 192, 168, 8, 2]);

  for (const qtype of [28, 65]) {
    const empty = dnsAnswer(dnsQuery('captive.apple.com', qtype), [192, 168, 8, 2])!;
    assert.equal(empty.length, dnsQuery('captive.apple.com', qtype).length);
    assert.deepEqual([...empty.subarray(6, 8)], [0, 0]);
    assert.equal(empty[3] & 0x0f, 0, 'NOERROR');
  }

  // Not answered: a response, two questions, a truncated or oversized packet, a compressed name.
  const resp = dnsQuery('a.eth', 1);
  resp[2] |= 0x80;
  assert.equal(dnsAnswer(resp, [1, 2, 3, 4]), undefined);
  const two = dnsQuery('a.eth', 1);
  two[5] = 2;
  assert.equal(dnsAnswer(two, [1, 2, 3, 4]), undefined);
  assert.equal(dnsAnswer(q.subarray(0, q.length - 2), [1, 2, 3, 4]), undefined);
  assert.equal(dnsAnswer(new Uint8Array(600), [1, 2, 3, 4]), undefined);
  const ptr = dnsQuery('a.eth', 1);
  ptr[12] = 0xc0;
  assert.equal(dnsAnswer(ptr, [1, 2, 3, 4]), undefined);
});

test('box DNS answers over UDP', async () => {
  const dns = await startDns([10, 0, 0, 1], 0, '127.0.0.1');
  const client = createSocket('udp4');
  try {
    const reply = await new Promise<Buffer>((resolve, reject) => {
      client.once('message', resolve);
      client.once('error', reject);
      client.send(dnsQuery('anything.example', 1), dns.address().port, '127.0.0.1');
    });
    assert.deepEqual([...reply.subarray(reply.length - 4)], [10, 0, 0, 1]);
  } finally {
    client.close();
    dns.close();
  }
});
