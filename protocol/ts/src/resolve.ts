/**
 * Resolve a URL path inside a verified site DAG to file bytes. Used by the
 * web viewer's service worker (and mirrored by the iOS scheme handler).
 *
 * Only call this on a DAG that verifyDag() accepted: it assumes every block
 * is present and hash-checked.
 */
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import type { CID } from 'multiformats/cid';
import { CODEC_RAW } from './limits.ts';
import type { BlockSource } from './car.ts';

export type Resolved =
  | { kind: 'file'; path: string; bytes: Uint8Array; mime: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'not-found' };

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

export function mimeFor(path: string): string {
  const ext = path.toLowerCase().split('/').pop()?.split('.').pop() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

function readFileBytes(cid: CID, src: BlockSource): Uint8Array {
  const bytes = src.get(cid);
  if (!bytes) throw new Error(`missing block ${cid.toString()}`);
  if (cid.code === CODEC_RAW) return bytes;
  const node = dagPb.decode(bytes);
  const fs = UnixFS.unmarshal(node.Data!);
  if (fs.type === 'directory') throw new Error('is a directory');
  const parts: Uint8Array[] = [];
  if (fs.data?.length) parts.push(fs.data);
  for (const l of node.Links) parts.push(readFileBytes(l.Hash, src));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function lookup(dir: CID, name: string, src: BlockSource): CID | undefined {
  const bytes = src.get(dir);
  if (!bytes || dir.code === CODEC_RAW) return undefined;
  const node = dagPb.decode(bytes);
  if (UnixFS.unmarshal(node.Data!).type !== 'directory') return undefined;
  return node.Links.find((l) => l.Name === name)?.Hash;
}

function isDir(cid: CID, src: BlockSource): boolean {
  if (cid.code === CODEC_RAW) return false;
  const bytes = src.get(cid);
  return !!bytes && UnixFS.unmarshal(dagPb.decode(bytes).Data!).type === 'directory';
}

/**
 * Resolve `path` (already URL-decoded, '/'-separated, relative to the site
 * root) like a static gateway: directories serve index.html, and a directory
 * requested without a trailing slash redirects to one.
 */
export function resolvePath(root: CID, path: string, src: BlockSource): Resolved {
  const segs = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) return { kind: 'not-found' };
  let cur: CID = root;
  for (const s of segs) {
    const next = lookup(cur, s, src);
    if (!next) return { kind: 'not-found' };
    cur = next;
  }
  if (isDir(cur, src)) {
    if (segs.length > 0 && !path.endsWith('/')) return { kind: 'redirect', location: `${segs[segs.length - 1]}/` };
    const index = lookup(cur, 'index.html', src);
    if (!index) return { kind: 'not-found' };
    return { kind: 'file', path: [...segs, 'index.html'].join('/'), bytes: readFileBytes(index, src), mime: MIME.html };
  }
  const p = segs.join('/');
  return { kind: 'file', path: p, bytes: readFileBytes(cur, src), mime: mimeFor(p) };
}
