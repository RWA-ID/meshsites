/**
 * Site packaging (CARv1 + UnixFS, 16 KiB chunks) and strict verification
 * (protocol/SPEC.md §2).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { importer, type ImporterOptions } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { CarWriter } from '@ipld/car/writer';
import { CarBlockIterator } from '@ipld/car/iterator';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { sha256 } from '@noble/hashes/sha2.js';
import { CODEC_DAG_PB, CODEC_RAW, HASH_SHA2_256, LIMITS } from './limits.ts';

export interface SiteFile {
  /** POSIX path relative to the site root, e.g. "css/site.css". */
  path: string;
  content: Uint8Array;
}

/** The mesh profile. Every option is pinned so the mesh CID is reproducible. */
export const MESH_IMPORTER_OPTIONS: ImporterOptions = {
  cidVersion: 1,
  rawLeaves: true,
  reduceSingleLeafToSelf: true,
  chunker: fixedSize({ chunkSize: LIMITS.chunkSize }),
  layout: balanced({ maxChildrenPerNode: LIMITS.maxChildrenPerNode }),
  wrapWithDirectory: true,
  // Never HAMT-shard: receivers don't support sharded directories in the MVP.
  // An oversized directory fails verification instead.
  shardSplitThresholdBytes: 2 ** 31,
  fieldOrder: 'links-first',
};

/** What a default `ipfs add -r` (Kubo) produces. Only a hint for origCid. */
export const KUBO_DEFAULT_OPTIONS: ImporterOptions = { profile: 'unixfs-v0-2015', wrapWithDirectory: true };

const IGNORED = new Set(['.DS_Store', 'Thumbs.db']);

/** Read a directory into SiteFiles, sorted by path. Dotfiles are skipped. */
export async function readSiteDir(dir: string): Promise<{ files: SiteFile[]; skipped: string[] }> {
  const files: SiteFile[] = [];
  const skipped: string[] = [];
  async function walk(d: string) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (ent.name.startsWith('.') || IGNORED.has(ent.name)) {
        skipped.push(rel);
        continue;
      }
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) files.push({ path: rel, content: new Uint8Array(await readFile(full)) });
      else skipped.push(rel);
    }
  }
  await walk(dir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

async function importToMap(files: SiteFile[], options: ImporterOptions) {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  const store = {
    put(cid: CID, bytes: Uint8Array) {
      blocks.set(cid.toString(), { cid, bytes });
      return cid;
    },
  };
  let root: CID | undefined;
  for await (const entry of importer(
    files.map((f) => ({ path: f.path, content: f.content })),
    store as never,
    options,
  )) {
    root = entry.cid;
  }
  if (!root) throw new Error('empty site');
  return { root, blocks };
}

/** Root CID a default `ipfs add -r` would give. A hint: the real contenthash may differ. */
export async function kuboDefaultCid(files: SiteFile[]): Promise<CID> {
  return (await importToMap(files, KUBO_DEFAULT_OPTIONS)).root;
}

export interface BuiltCar {
  root: CID;
  car: Uint8Array;
  blocks: { cid: string; size: number }[];
  totalBytes: number;
}

/** Links of a block, in order (none for raw). */
function linksOf(cid: CID, bytes: Uint8Array): CID[] {
  if (cid.code !== CODEC_DAG_PB) return [];
  return dagPb.decode(bytes).Links.map((l) => l.Hash);
}

/** Serialize blocks into a CARv1 exactly as given (no checks; also used for negative test vectors). */
export async function writeCar(roots: CID[], blocks: { cid: CID; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create(roots);
  const chunks: Uint8Array[] = [];
  const collecting = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  await collecting;
  const car = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    car.set(c, off);
    off += c.length;
  }
  return car;
}

/** Build the mesh CAR. Blocks are written depth-first pre-order from the root, each once. */
export async function buildSiteCar(files: SiteFile[], opts: { skipVerify?: boolean } = {}): Promise<BuiltCar> {
  if (files.length === 0) throw new Error('site has no files');
  const { root, blocks } = await importToMap(files, MESH_IMPORTER_OPTIONS);
  const ordered: { cid: CID; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();
  const visit = (cid: CID) => {
    const k = cid.toString();
    if (seen.has(k)) return;
    seen.add(k);
    const b = blocks.get(k);
    if (!b) throw new Error(`importer did not produce block ${k}`);
    ordered.push(b);
    for (const l of linksOf(cid, b.bytes)) visit(l);
  };
  visit(root);

  const car = await writeCar([root], ordered);
  const totalBytes = ordered.reduce((n, b) => n + b.bytes.length, 0);
  // Verify what we built with the same rules a receiver uses.
  const check = opts.skipVerify ? { ok: true, errors: [] } : await verifyCar(car);
  if (!check.ok) throw new Error(`built CAR fails verification: ${check.errors.join('; ')}`);
  return { root, car, blocks: ordered.map((b) => ({ cid: b.cid.toString(), size: b.bytes.length })), totalBytes };
}

export interface VerifyCarOptions {
  maxBlockBytes?: number;
  maxSiteBytes?: number;
  /** Cap on the expanded size of all files (blocks counted once per reference). */
  maxLogicalBytes?: number;
  /** If set, the CAR's root must equal this CID. */
  expectedRoot?: string;
}

export interface CarVerification {
  ok: boolean;
  root?: string;
  blockCount: number;
  totalBytes: number;
  /** Expanded size of all file data; 0 when the CAR has other errors. */
  logicalBytes?: number;
  errors: string[];
}

/** Check one block's CID rules and hash. Returns an error string or null. */
export function checkBlock(cid: CID, bytes: Uint8Array, maxBlockBytes: number = LIMITS.maxBlockBytes): string | null {
  const id = cid.toString();
  if (cid.version !== 1) return `${id}: not CIDv1`;
  if (cid.code !== CODEC_RAW && cid.code !== CODEC_DAG_PB) return `${id}: codec 0x${cid.code.toString(16)} not allowed`;
  if (cid.multihash.code !== HASH_SHA2_256 || cid.multihash.digest.length !== 32) return `${id}: hash must be sha2-256`;
  if (bytes.length > maxBlockBytes) return `${id}: block is ${bytes.length} bytes (max ${maxBlockBytes})`;
  const d = sha256(bytes);
  const want = cid.multihash.digest;
  for (let i = 0; i < 32; i++) if (d[i] !== want[i]) return `${id}: hash mismatch`;
  return null;
}

/**
 * Verify a CAR strictly: v1 header with exactly one root, every block
 * hash-checked, the DAG from the root complete, no unreachable blocks, only
 * file/directory/raw UnixFS nodes, and the size caps.
 */
export async function verifyCar(car: Uint8Array, opts: VerifyCarOptions = {}): Promise<CarVerification> {
  const maxBlockBytes = opts.maxBlockBytes ?? LIMITS.maxBlockBytes;
  const maxSiteBytes = opts.maxSiteBytes ?? LIMITS.maxSiteBytes;
  const errors: string[] = [];
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  let totalBytes = 0;
  let root: CID;
  try {
    const it = await CarBlockIterator.fromBytes(car);
    if (it.version !== 1) return { ok: false, blockCount: 0, totalBytes: 0, errors: [`CAR version ${it.version}, need 1`] };
    const roots = await it.getRoots();
    if (roots.length !== 1) return { ok: false, blockCount: 0, totalBytes: 0, errors: [`CAR has ${roots.length} roots, need 1`] };
    root = roots[0];
    for await (const { cid, bytes } of it) {
      const k = cid.toString();
      if (blocks.has(k)) {
        errors.push(`${k}: duplicate block`);
        continue;
      }
      const err = checkBlock(cid, bytes, maxBlockBytes);
      if (err) {
        errors.push(err);
        continue;
      }
      totalBytes += bytes.length;
      blocks.set(k, { cid, bytes });
    }
  } catch (e) {
    return { ok: false, blockCount: blocks.size, totalBytes, errors: [...errors, `CAR parse error: ${(e as Error).message}`] };
  }
  if (opts.expectedRoot !== undefined && root.toString() !== opts.expectedRoot)
    errors.push(`root is ${root.toString()}, expected ${opts.expectedRoot}`);
  if (totalBytes > maxSiteBytes) errors.push(`site is ${totalBytes} bytes (max ${maxSiteBytes})`);

  if (root.code !== CODEC_DAG_PB) errors.push(`root ${root.toString()} must be a dag-pb directory`);

  // Walk the DAG from the root.
  const reached = new Set<string>();
  const stack: CID[] = [root];
  while (stack.length) {
    const cid = stack.pop()!;
    const k = cid.toString();
    if (reached.has(k)) continue;
    reached.add(k);
    const b = blocks.get(k);
    if (!b) {
      // Bad link CIDs are reported here too: they can never be present.
      const err = checkBlock(cid, new Uint8Array(0), Infinity);
      errors.push(err && !err.endsWith('hash mismatch') ? `link ${err}` : `${k}: missing block`);
      continue;
    }
    if (cid.code === CODEC_RAW) continue;
    try {
      const node = dagPb.decode(b.bytes);
      if (!node.Data) throw new Error('dag-pb node has no UnixFS data');
      const fs = UnixFS.unmarshal(node.Data);
      if (fs.type !== 'file' && fs.type !== 'directory' && fs.type !== 'raw')
        throw new Error(`UnixFS type ${fs.type} not supported`);
      if (fs.type === 'directory' && node.Links.some((l) => l.Name === undefined || l.Name === ''))
        throw new Error('directory entry without a name');
      if (k === root.toString() && fs.type !== 'directory') throw new Error('root must be a directory');
      for (const l of node.Links) stack.push(l.Hash);
    } catch (e) {
      errors.push(`${k}: ${(e as Error).message}`);
    }
  }
  for (const k of blocks.keys()) if (!reached.has(k)) errors.push(`${k}: block not reachable from root`);

  // Expanded size: a small CAR can reference one block many times. Memoised,
  // so a crafted DAG can't make this walk exponential.
  let logicalBytes = 0;
  if (errors.length === 0) {
    const memo = new Map<string, number>();
    const size = (cid: CID): number => {
      const k = cid.toString();
      const m = memo.get(k);
      if (m !== undefined) return m;
      const b = blocks.get(k)!;
      let n = b.bytes.length;
      if (cid.code === CODEC_DAG_PB) {
        const node = dagPb.decode(b.bytes);
        n = UnixFS.unmarshal(node.Data!).data?.length ?? 0; // inline data, if any
        for (const l of node.Links) n += size(l.Hash);
      }
      memo.set(k, n);
      return n;
    };
    logicalBytes = size(root);
    const maxLogical = opts.maxLogicalBytes ?? LIMITS.maxLogicalBytes;
    if (logicalBytes > maxLogical) errors.push(`site expands to ${logicalBytes} bytes of files (max ${maxLogical})`);
  }
  return { ok: errors.length === 0, root: root.toString(), blockCount: blocks.size, totalBytes, logicalBytes, errors };
}
