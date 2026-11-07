import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'cli/src/main.ts');
const SITE = join(ROOT, 'protocol/vectors/site-basic');
const records = JSON.parse(await readFile(join(ROOT, 'protocol/vectors/records.json'), 'utf8'));
const KEY = records.testKeys[0];
const car = JSON.parse(await readFile(join(ROOT, 'protocol/vectors/car.json'), 'utf8'));

async function cli(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await run(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
}

test('publish (local key) → verify → verify-record round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meshsites-'));
  const out = join(dir, 'site.car');
  const p = await cli(['publish', SITE, '--name', 'example.eth', '--out', out, '--key-env', 'MS_KEY', '--seq', '12', '--ts', '1762470000'], { MS_KEY: KEY.privateKey });
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, new RegExp(`mesh CID   ${car.rootCid}`));
  assert.match(p.stdout, /meshsites\.signer = 0x6EA2147F6874d28aAa3821B4c68c64ff7db0c8df/);
  assert.ok(!p.stdout.includes(KEY.privateKey.slice(2)), 'private key must never be printed');

  assert.equal((await cli(['verify', out, '--root', car.rootCid])).code, 0);
  const signed = join(dir, 'site.record.signed.json');
  const v = await cli(['verify-record', signed, '--signer', KEY.address, '--cached-seq', '11', '--now', '1762470000']);
  assert.equal(v.code, 0, v.stderr);
  assert.match(v.stdout, /^VERIFIED/);

  // Same signed record matches the committed signing vector.
  const s = JSON.parse(await readFile(signed, 'utf8'));
  assert.equal(s.sig, records.signing[0].sig);
});

test('verify-record rejects a lower or equal seq', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meshsites-'));
  const f = join(dir, 'r.json');
  await writeFile(f, JSON.stringify({ record: records.signing[0].record, sig: records.signing[0].sig }));
  for (const cached of ['12', '13']) {
    const r = await cli(['verify-record', f, '--cached-seq', cached, '--now', '1762470000']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /stale-seq/);
  }
});

test('verify-record rejects a tampered record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meshsites-'));
  const f = join(dir, 'r.json');
  const rec = { ...records.signing[0].record, seq: 99 };
  await writeFile(f, JSON.stringify({ record: rec, sig: records.signing[0].sig }));
  const r = await cli(['verify-record', f, '--now', '1762470000']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /signer-mismatch/);
});

test('verify fails (exit 1) on a tampered CAR', async () => {
  const r = await cli(['verify', join(ROOT, 'protocol/vectors/site-basic.tampered-block.car')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /hash mismatch/);
});

test('wallet flow: publish --signer prints the message; sign-record --sig attaches a wallet signature', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meshsites-'));
  const out = join(dir, 'w.car');
  const p = await cli(['publish', SITE, '--name', 'example.eth', '--out', out, '--signer', KEY.address, '--seq', '12', '--ts', '1762470000']);
  assert.equal(p.code, 0, p.stderr);
  const recPath = join(dir, 'w.record.json');
  const record = JSON.parse(await readFile(recPath, 'utf8'));
  const message = records.signing[0].canonicalJson;
  assert.ok(p.stdout.includes(message), 'publish must print the exact message to sign');

  // Simulate the wallet with viem.
  const sig = await privateKeyToAccount(KEY.privateKey).signMessage({ message });
  const s = await cli(['sign-record', recPath, '--sig', sig]);
  assert.equal(s.code, 0, s.stderr);
  const v = await cli(['verify-record', join(dir, 'w.record.signed.json'), '--signer', record.signer, '--now', '1762470000']);
  assert.equal(v.code, 0, v.stderr);

  // A signature from the wrong key is refused before writing.
  const bad = await privateKeyToAccount(records.testKeys[1].privateKey).signMessage({ message });
  assert.equal((await cli(['sign-record', recPath, '--sig', bad])).code, 2);
});

test('publish refuses a private key passed any way but the environment', async () => {
  const r = await cli(['publish', SITE, '--name', 'example.eth', '--key', KEY.privateKey]);
  assert.notEqual(r.code, 0);
});
