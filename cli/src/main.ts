#!/usr/bin/env node
/**
 * meshsites: publisher CLI.
 *
 *   meshsites publish <dir> --name <ens> [--out site.car] [--seq N] [--orig-cid CID] [--key-env VAR]
 *   meshsites verify <file.car> [--root CID]
 *   meshsites sign-record <record.json> (--key-env VAR | --sig 0x…) [--out signed.json]
 *   meshsites verify-record <signed.json> [--signer 0x…] [--cached-seq N] [--now SECONDS]
 *
 * Private keys are only read from an environment variable named by --key-env,
 * never from argv (argv lands in shell history and `ps`).
 */
import { readSiteDir } from '@meshsites/protocol/node';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import {
  addressFromPrivateKey,
  attachSignature,
  assertWellFormed,
  buildSiteCar,
  kuboDefaultCid,
  LIMITS,
  type NameRecord,
  parsePrivateKey,
  recordMessage,
  signRecord,
  type SignedNameRecord,
  toChecksumAddress,
  verifyCar,
  verifyRecord,
} from '@meshsites/protocol';
import { ens_normalize } from '@adraffy/ens-normalize';

class UsageError extends Error {}

const USAGE = `usage:
  meshsites publish <dir> --name <ens> [--out site.car] [--seq N] [--orig-cid CID] [--key-env VAR] [--signer 0x…]
  meshsites verify <file.car> [--root CID]
  meshsites sign-record <record.json> (--key-env VAR | --sig 0x…) [--out signed.json]
  meshsites verify-record <signed.json> [--signer 0x…] [--cached-seq N] [--now SECONDS]`;

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

function keyFromEnv(name: string): Uint8Array {
  const v = process.env[name];
  if (!v) throw new UsageError(`environment variable ${name} is not set`);
  return parsePrivateKey(v);
}

function int(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new UsageError(`--${name} must be a non-negative integer`);
  return Number(v);
}

function printTextRecords(signed: SignedNameRecord) {
  out('ENS text records to set on ' + signed.record.name + ':');
  out(`  meshsites.signer = ${toChecksumAddress(signed.record.signer)}`);
  out(`  meshsites.record = ${JSON.stringify(signed)}`);
}

async function publish(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      out: { type: 'string' },
      seq: { type: 'string' },
      ts: { type: 'string' },
      'orig-cid': { type: 'string' },
      'key-env': { type: 'string' },
      signer: { type: 'string' },
    },
  });
  const dir = positionals[0];
  if (!dir || !values.name) throw new UsageError('publish needs <dir> and --name');
  const name = ens_normalize(values.name);
  if (name !== values.name) err(`note: name normalized to ${name}`);

  const { files, skipped } = await readSiteDir(dir);
  if (skipped.length) err(`skipped: ${skipped.join(', ')}`);
  if (!files.some((f) => f.path === 'index.html')) err('warning: no index.html at the site root');
  const built = await buildSiteCar(files);
  if (built.totalBytes > LIMITS.maxSiteBytes)
    throw new UsageError(`site is ${built.totalBytes} bytes; the mesh limit is ${LIMITS.maxSiteBytes}`);

  const carPath = values.out ?? `${basename(dir.replace(/\/+$/, '')) || 'site'}.car`;
  await writeFile(carPath, built.car);

  let origCid = values['orig-cid'];
  if (!origCid) {
    origCid = (await kuboDefaultCid(files)).toString();
    err('note: --orig-cid not given; using the default `ipfs add -r` CID. Pass your real ENS contenthash CID if it differs.');
  }

  const key = values['key-env'] ? keyFromEnv(values['key-env']) : undefined;
  const signer = (key ? addressFromPrivateKey(key) : values.signer)?.toLowerCase();
  if (!signer) throw new UsageError('publish needs --key-env VAR (sign locally) or --signer 0x… (sign with a wallet)');
  if (key && values.signer && values.signer.toLowerCase() !== signer)
    throw new UsageError(`--signer ${values.signer} does not match the key's address ${signer}`);

  const ts = int('ts', values.ts) ?? Math.floor(Date.now() / 1000);
  const record: NameRecord = { v: 1, name, cid: built.root.toString(), origCid, seq: int('seq', values.seq) ?? ts, ts, signer };
  assertWellFormed(record);

  out(`mesh CID   ${record.cid}`);
  out(`orig CID   ${record.origCid}`);
  out(`CAR        ${carPath} (${built.car.length} bytes, ${built.blocks.length} blocks, ${built.totalBytes} block bytes)`);
  out(`seq        ${record.seq}`);
  out();

  const base = carPath.replace(/\.car$/, '');
  if (key) {
    const signed = signRecord(record, key);
    const signedPath = `${base}.record.signed.json`;
    await writeFile(signedPath, `${JSON.stringify(signed, null, 2)}\n`);
    out(`signed record → ${signedPath}`);
    out();
    printTextRecords(signed);
  } else {
    const recordPath = `${base}.record.json`;
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    out(`unsigned record → ${recordPath}`);
    out();
    out(`Sign this exact message with personal_sign from ${toChecksumAddress(signer)}:`);
    out(recordMessage(record));
    out();
    out(`then: meshsites sign-record ${recordPath} --sig 0x…`);
  }
}

async function verify(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { root: { type: 'string' } } });
  if (!positionals[0]) throw new UsageError('verify needs <file.car>');
  const res = await verifyCar(new Uint8Array(await readFile(positionals[0])), { expectedRoot: values.root });
  if (res.ok) {
    out(`OK  root ${res.root}  ${res.blockCount} blocks  ${res.totalBytes} bytes, every block re-hashed`);
    return 0;
  }
  err(`FAIL  ${positionals[0]}`);
  for (const e of res.errors) err(`  ${e}`);
  return 1;
}

async function signRecordCmd(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'key-env': { type: 'string' }, sig: { type: 'string' }, out: { type: 'string' } },
  });
  if (!positionals[0]) throw new UsageError('sign-record needs <record.json>');
  const record = JSON.parse(await readFile(positionals[0], 'utf8'));
  assertWellFormed(record);
  let signed: SignedNameRecord;
  if (values['key-env']) signed = signRecord(record, keyFromEnv(values['key-env']));
  else if (values.sig) signed = attachSignature(record, values.sig);
  else throw new UsageError('sign-record needs --key-env VAR or --sig 0x…');
  const check = verifyRecord(signed, { expectedSigner: record.signer, now: record.ts });
  if (!check.ok) throw new UsageError(`signature does not verify: ${check.reason}: ${check.detail}`);
  const path = values.out ?? positionals[0].replace(/(\.record)?\.json$/, '.record.signed.json');
  await writeFile(path, `${JSON.stringify(signed, null, 2)}\n`);
  out(`signed record → ${path}`);
  out();
  printTextRecords(signed);
  return 0;
}

async function verifyRecordCmd(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { signer: { type: 'string' }, 'cached-seq': { type: 'string' }, now: { type: 'string' } },
  });
  if (!positionals[0]) throw new UsageError('verify-record needs <signed.json>');
  const signed = JSON.parse(await readFile(positionals[0], 'utf8'));
  const res = verifyRecord(signed, {
    expectedSigner: values.signer,
    cachedSeq: int('cached-seq', values['cached-seq']),
    now: int('now', values.now),
  });
  if (!res.ok) {
    err(`FAIL  ${res.reason}: ${res.detail}`);
    return 1;
  }
  out(`${res.status === 'verified' ? 'VERIFIED' : 'UNVERIFIED (signature valid, signer not trusted yet)'}  ${res.record.name} → ${res.record.cid}  seq ${res.record.seq}  signer ${toChecksumAddress(res.signer)}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'publish':
      await publish(rest);
      return 0;
    case 'verify':
      return verify(rest);
    case 'sign-record':
      return signRecordCmd(rest);
    case 'verify-record':
      return verifyRecordCmd(rest);
    case undefined:
    case '-h':
    case '--help':
      out(USAGE);
      return cmd ? 0 : 2;
    default:
      throw new UsageError(`unknown command ${cmd}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    err(`error: ${(e as Error).message}`);
    if (e instanceof UsageError) err(USAGE);
    process.exit(e instanceof UsageError ? 2 : 1);
  },
);
