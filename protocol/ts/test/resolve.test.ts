import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCar, resolvePath } from '../src/index.ts';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '../../vectors');
const SITE = join(VEC, 'site-basic');
const { root, blocks } = await readCar(new Uint8Array(await readFile(join(VEC, 'site-basic.car'))));
const src = { get: (c: { toString(): string }) => blocks.get(c.toString())?.bytes };

const file = async (p: string) => new Uint8Array(await readFile(join(SITE, p)));

test('/ serves index.html', async () => {
  const r = resolvePath(root, '', src);
  assert.equal(r.kind, 'file');
  if (r.kind === 'file') {
    assert.equal(r.mime, 'text/html; charset=utf-8');
    assert.deepEqual(r.bytes, await file('index.html'));
  }
});

test('a multi-chunk file reassembles byte-exact', async () => {
  const r = resolvePath(root, 'js/app.js', src);
  assert.equal(r.kind, 'file');
  if (r.kind === 'file') {
    assert.equal(r.bytes.length, 40113);
    assert.deepEqual(r.bytes, await file('js/app.js'));
    assert.match(r.mime, /javascript/);
  }
});

test('nested file and mime', async () => {
  const r = resolvePath(root, 'css/site.css', src);
  assert.ok(r.kind === 'file' && r.mime.startsWith('text/css'));
});

test('directory without trailing slash redirects; missing → not-found; .. refused', () => {
  assert.deepEqual(resolvePath(root, 'css', src), { kind: 'redirect', location: 'css/' });
  assert.deepEqual(resolvePath(root, 'css/', src), { kind: 'not-found' }); // no index.html in css/
  assert.deepEqual(resolvePath(root, 'nope.html', src), { kind: 'not-found' });
  assert.deepEqual(resolvePath(root, 'css/../index.html', src), { kind: 'not-found' });
});
