/**
 * Site packaging (CARv1 + UnixFS, 16 KiB chunks) and strict verification
 * (protocol/SPEC.md §2). Browser-safe: no Node APIs here (see node.ts).
 */
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

export interface Block {
  cid: CID;
  bytes: Uint8Array;
}

/** Anything that can answer "do you have this verified block?" */
export interface BlockSource {
  get(cid: CID): Uint8Array | undefined;
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

async function importToMap(files: SiteFile[], options: ImporterOptions) {
  const blocks = new Map<string, Block>();
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

/** Links of a block, in order (none for raw). Throws on undecodable dag-pb. */
export function linksOf(cid: CID, bytes: Uint8Array): CID[] {
  if (cid.code !== CODEC_DAG_PB) return [];
  return dagPb.decode(bytes).Links.map((l) => l.Hash);
}

/** Serialize blocks into a CARv1 exactly as given (no checks; also used for negative test vectors). */
export async function writeCar(roots: CID[], blocks: Block[]): Promise<Uint8Array> {
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

/** Blocks reachable from root, depth-first pre-order, each once. */
export function orderedBlocks(root: CID, src: BlockSource): Block[] {
  const ordered: Block[] = [];
  const seen = new Set<string>();
  const visit = (cid: CID) => {
    const k = cid.toString();
    if (seen.has(k)) return;
    seen.add(k);
    const bytes = src.get(cid);
    if (!bytes) throw new Error(`missing block ${k}`);
    ordered.push({ cid, bytes });
    for (const l of linksOf(cid, bytes)) visit(l);
  };
  visit(root);
  return ordered;
}

/**
 * Build the mesh CAR. Blocks are written depth-first pre-order from the root, each once.
 * `limits` replaces the whole-site caps of the self-check (e.g. BOX_LIMITS for a box-only site).
 */
export async function buildSiteCar(
  files: SiteFile[],
  opts: { skipVerify?: boolean; limits?: { maxSiteBytes?: number; maxLogicalBytes?: number } } = {},
): Promise<BuiltCar> {
  if (files.length === 0) throw new Error('site has no files');
  const { root, blocks } = await importToMap(files, MESH_IMPORTER_OPTIONS);
  const ordered = orderedBlocks(root, { get: (c) => blocks.get(c.toString())?.bytes });
  const car = await writeCar([root], ordered);
  const totalBytes = ordered.reduce((n, b) => n + b.bytes.length, 0);
  // Verify what we built with the same rules a receiver uses.
  const check = opts.skipVerify ? { ok: true, errors: [] } : await verifyCar(car, opts.limits);
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
  const ruleErr = checkCidRules(cid);
  if (ruleErr) return ruleErr;
  if (bytes.length > maxBlockBytes) return `${id}: block is ${bytes.length} bytes (max ${maxBlockBytes})`;
  const d = sha256(bytes);
  const want = cid.multihash.digest;
  for (let i = 0; i < 32; i++) if (d[i] !== want[i]) return `${id}: hash mismatch`;
  return null;
}

/** CID-only rules (version, codec, hash function). */
export function checkCidRules(cid: CID): string | null {
  const id = cid.toString();
  if (cid.version !== 1) return `${id}: not CIDv1`;
  if (cid.code !== CODEC_RAW && cid.code !== CODEC_DAG_PB) return `${id}: codec 0x${cid.code.toString(16)} not allowed`;
  if (cid.multihash.code !== HASH_SHA2_256 || cid.multihash.digest.length !== 32) return `${id}: hash must be sha2-256`;
  return null;
}

/** Parse a CAR into its root and blocks, applying per-block checks (§2.2 steps 1-4). */
export async function readCar(car: Uint8Array, maxBlockBytes: number = LIMITS.maxBlockBytes) {
  const errors: string[] = [];
  const blocks = new Map<string, Block>();
  let totalBytes = 0;
  const it = await CarBlockIterator.fromBytes(car);
  if (it.version !== 1) throw new Error(`CAR version ${it.version}, need 1`);
  const roots = await it.getRoots();
  if (roots.length !== 1) throw new Error(`CAR has ${roots.length} roots, need 1`);
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
  return { root: roots[0], blocks, totalBytes, errors };
}

export interface DagVerification {
  ok: boolean;
  /** Verified-reachable blocks still to fetch (the frontier), in DFS order. */
  missing: CID[];
  /** Keys of blocks reached from the root. */
  reached: Set<string>;
  totalBytes: number;
  logicalBytes: number;
  errors: string[];
}

/**
 * Walk the DAG from root over blocks that are ALREADY hash-verified
 * (§2.2 steps 5-9). Used by verifyCar and by the mesh fetcher to find the
 * frontier of blocks still to request.
 */
export function verifyDag(
  root: CID,
  src: BlockSource,
  opts: { maxSiteBytes?: number; maxLogicalBytes?: number } = {},
): DagVerification {
  const errors: string[] = [];
  const missing: CID[] = [];
  const reached = new Set<string>();
  let totalBytes = 0;
  if (root.code !== CODEC_DAG_PB) errors.push(`root ${root.toString()} must be a dag-pb directory`);

  const stack: CID[] = [root];
  while (stack.length) {
    const cid = stack.pop()!;
    const k = cid.toString();
    if (reached.has(k)) continue;
    reached.add(k);
    const rule = checkCidRules(cid);
    if (rule) {
      errors.push(`link ${rule}`);
      continue;
    }
    const bytes = src.get(cid);
    if (!bytes) {
      missing.push(cid);
      continue;
    }
    totalBytes += bytes.length;
    if (cid.code === CODEC_RAW) continue;
    try {
      const node = dagPb.decode(bytes);
      if (!node.Data) throw new Error('dag-pb node has no UnixFS data');
      const fs = UnixFS.unmarshal(node.Data);
      if (fs.type !== 'file' && fs.type !== 'directory' && fs.type !== 'raw')
        throw new Error(`UnixFS type ${fs.type} not supported`);
      if (fs.type === 'directory' && node.Links.some((l) => l.Name === undefined || l.Name === ''))
        throw new Error('directory entry without a name');
      if (k === root.toString() && fs.type !== 'directory') throw new Error('root must be a directory');
      // Push in reverse so pops follow link order (DFS pre-order).
      for (let i = node.Links.length - 1; i >= 0; i--) stack.push(node.Links[i].Hash);
    } catch (e) {
      errors.push(`${k}: ${(e as Error).message}`);
    }
  }
  const maxSite = opts.maxSiteBytes ?? LIMITS.maxSiteBytes;
  if (totalBytes > maxSite) errors.push(`site is ${totalBytes} bytes (max ${maxSite})`);

  // Expanded size: a small CAR can reference one block many times. Memoised,
  // so a crafted DAG can't make this walk exponential.
  let logicalBytes = 0;
  if (errors.length === 0 && missing.length === 0) {
    const memo = new Map<string, number>();
    const size = (cid: CID): number => {
      const k = cid.toString();
      const m = memo.get(k);
      if (m !== undefined) return m;
      const bytes = src.get(cid)!;
      let n = bytes.length;
      if (cid.code === CODEC_DAG_PB) {
        const node = dagPb.decode(bytes);
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
  return { ok: errors.length === 0 && missing.length === 0, missing, reached, totalBytes, logicalBytes, errors };
}

/**
 * Verify a CAR strictly: v1 header with exactly one root, every block
 * hash-checked, the DAG from the root complete, no unreachable blocks, only
 * file/directory/raw UnixFS nodes, and the size caps.
 */
export async function verifyCar(car: Uint8Array, opts: VerifyCarOptions = {}): Promise<CarVerification> {
  return (await openCar(car, opts)).verification;
}

/**
 * verifyCar, plus the blocks when (and only when) the CAR passed, so a caller
 * that goes on to serve the site doesn't parse and hash it twice.
 */
export async function openCar(
  car: Uint8Array,
  opts: VerifyCarOptions = {},
): Promise<{ verification: CarVerification; root?: CID; source?: BlockSource }> {
  let parsed: Awaited<ReturnType<typeof readCar>>;
  try {
    parsed = await readCar(car, opts.maxBlockBytes);
  } catch (e) {
    const m = (e as Error).message;
    return {
      verification: { ok: false, blockCount: 0, totalBytes: 0, errors: [m.startsWith('CAR ') ? m : `CAR parse error: ${m}`] },
    };
  }
  const { root, blocks } = parsed;
  const errors = [...parsed.errors];
  if (opts.expectedRoot !== undefined && root.toString() !== opts.expectedRoot)
    errors.push(`root is ${root.toString()}, expected ${opts.expectedRoot}`);
  const source: BlockSource = { get: (c) => blocks.get(c.toString())?.bytes };
  const dag = verifyDag(root, source, opts);
  errors.push(...dag.errors);
  for (const m of dag.missing) errors.push(`${m.toString()}: missing block`);
  for (const k of blocks.keys()) if (!dag.reached.has(k)) errors.push(`${k}: block not reachable from root`);
  const verification: CarVerification = {
    ok: errors.length === 0,
    root: root.toString(),
    blockCount: blocks.size,
    totalBytes: parsed.totalBytes,
    logicalBytes: dag.logicalBytes,
    errors,
  };
  return verification.ok ? { verification, root, source } : { verification };
}
