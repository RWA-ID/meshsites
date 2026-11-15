/**
 * meshsites serve: a "box". Any computer on a Wi-Fi network with no internet
 * (a laptop, a Raspberry Pi, a travel router's companion) that hands verified
 * sites to plain browsers over HTTP. No app on the visitor's side.
 *
 * Trust: the box checks every CAR (all block hashes, the whole DAG, the caps)
 * and every name record signature before serving. A browser can't repeat that
 * over plain HTTP, so a visitor trusts whoever runs the box. The same CARs and
 * signed records are also served raw, so the MeshSites app can pull from a box
 * and verify for itself.
 *
 * Names without internet: a name is never looked up. The box holds the name's
 * signed record (the value of its `meshsites.record` ENS text record) and
 * checks the signature; `signers.json` pins which address may sign for a
 * name, learned from ENS while online.
 *
 * Hosts (the box's DNS should answer every name with the box's address):
 *   <domain>, an IP, localhost          → the list of sites, and the raw files
 *   <cid>.<domain>                      → that site, on its own origin
 *   <name>.eth  /  <name>.eth.<domain>  → the site a signed record names
 *   anything else                       → 302 to http://<domain>/ (captive portal)
 * By IP there are no subdomains, so sites are served at /ipfs/<cid>/ and
 * /ipns/<name>/ on one shared origin.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { CID } from 'multiformats/cid';
import {
  BOX_LIMITS,
  type BlockSource,
  LIMITS,
  openCar,
  resolvePath,
  type SignedNameRecord,
  toChecksumAddress,
  verifyRecord,
} from '@meshsites/protocol';

export interface BoxName {
  name: string;
  cid: string;
  seq: number;
  signer: string;
  /** 'verified': signed by the address signers.json pins for this name. */
  status: 'verified' | 'unverified';
  signed: SignedNameRecord;
}

export interface BoxSite {
  cid: string;
  file: string;
  title: string;
  totalBytes: number;
  logicalBytes: number;
  blockCount: number;
  /** Within the mesh caps, so phones can also pass it on over Bluetooth. */
  mesh: boolean;
  names: BoxName[];
}

export interface BoxContents {
  sites: Map<string, BoxSite>;
  names: Map<string, BoxName>;
  /** A record's original (gateway) CID → the mesh CID stored here. */
  origToMesh: Map<string, string>;
  /** Files that were refused, with the reason. */
  problems: string[];
}

const SIGNERS_FILE = 'signers.json';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function titleOf(root: CID, source: BlockSource): string {
  try {
    const r = resolvePath(root, '', source);
    if (r.kind !== 'file') return '';
    const head = new TextDecoder().decode(r.bytes.subarray(0, 8192));
    const raw = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] ?? '';
    const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
    return raw.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ENT[e]).replace(/\s+/g, ' ').trim().slice(0, 80);
  } catch {
    return '';
  }
}

/** Read a box folder: every *.car and every signed record (*.json) at its top level. */
export async function loadBox(dir: string, opts: { now?: number } = {}): Promise<BoxContents> {
  const sites = new Map<string, BoxSite>();
  const problems: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();

  for (const file of entries.filter((f) => f.endsWith('.car'))) {
    const size = (await stat(join(dir, file))).size;
    // A CAR is its blocks plus a few bytes of framing each; don't read a huge file just to refuse it.
    if (size > BOX_LIMITS.maxSiteBytes * 1.1) {
      problems.push(`${file}: ${size} bytes, over the box limit of ${BOX_LIMITS.maxSiteBytes}`);
      continue;
    }
    const { verification: v, root, source } = await openCar(new Uint8Array(await readFile(join(dir, file))), BOX_LIMITS);
    if (!v.ok || !root || !source) {
      problems.push(`${file}: ${v.errors[0] ?? 'failed verification'}`);
      continue;
    }
    const cid = root.toString();
    if (sites.has(cid)) continue; // the same site twice
    const logicalBytes = v.logicalBytes ?? 0;
    sites.set(cid, {
      cid,
      file,
      title: titleOf(root, source),
      totalBytes: v.totalBytes,
      logicalBytes,
      blockCount: v.blockCount,
      mesh: v.totalBytes <= LIMITS.maxSiteBytes && logicalBytes <= LIMITS.maxLogicalBytes,
      names: [],
    });
  }

  // Trusted signers, learned from ENS while online: { "name.eth": "0x…" }.
  const signers = new Map<string, string>();
  if (entries.includes(SIGNERS_FILE)) {
    try {
      const o = JSON.parse(await readFile(join(dir, SIGNERS_FILE), 'utf8')) as Record<string, unknown>;
      for (const [name, addr] of Object.entries(o)) {
        if (typeof addr === 'string' && ADDR_RE.test(addr)) signers.set(name, addr.toLowerCase());
        else problems.push(`${SIGNERS_FILE}: ${name} is not an address`);
      }
    } catch (e) {
      problems.push(`${SIGNERS_FILE}: ${(e as Error).message}`);
    }
  }

  const byName = new Map<string, BoxName[]>();
  for (const file of entries.filter((f) => f.endsWith('.json') && f !== SIGNERS_FILE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
      continue;
    }
    // Unsigned records and other JSON may sit next to the CARs; only signed records count.
    if (typeof parsed !== 'object' || parsed === null || !('record' in parsed) || !('sig' in parsed)) continue;
    const name = (parsed as { record?: { name?: unknown } }).record?.name;
    const res = verifyRecord(parsed, { now: opts.now, expectedSigner: typeof name === 'string' ? signers.get(name) : undefined });
    if (!res.ok) {
      problems.push(`${file}: ${res.reason}: ${res.detail}`);
      continue;
    }
    const list = byName.get(res.record.name) ?? [];
    list.push({ name: res.record.name, cid: res.record.cid, seq: res.record.seq, signer: res.signer, status: res.status, signed: parsed as SignedNameRecord });
    byName.set(res.record.name, list);
  }

  const names = new Map<string, BoxName>();
  const origToMesh = new Map<string, string>();
  for (const [name, list] of byName) {
    // With no pinned signer, two different signers can't be told apart: serve neither.
    if (new Set(list.map((r) => r.signer)).size > 1) {
      problems.push(`${name}: records from more than one signer and none pinned in ${SIGNERS_FILE}; name not served`);
      continue;
    }
    list.sort((a, b) => b.seq - a.seq);
    const best = list.find((r) => sites.has(r.cid));
    if (!best) {
      problems.push(`${name}: its record points at ${list[0].cid}, which is not on this box`);
      continue;
    }
    if (best !== list[0]) problems.push(`${name}: newest record (seq ${list[0].seq}) has no CAR here; serving seq ${best.seq}`);
    names.set(name, best);
    sites.get(best.cid)!.names.push(best);
    origToMesh.set(best.signed.record.origCid, best.cid);
  }
  return { sites, names, origToMesh, problems };
}

/** Verified sites held in memory, least recently used dropped first. */
class SiteCache {
  private readonly held = new Map<string, { root: CID; source: BlockSource; bytes: number }>();
  private total = 0;
  private readonly dir: string;
  private readonly maxBytes: number;
  constructor(dir: string, maxBytes: number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  /** Always re-verified when read from disk: the file may have changed since the scan. */
  async get(site: BoxSite): Promise<{ root: CID; source: BlockSource }> {
    const hit = this.held.get(site.cid);
    if (hit) {
      this.held.delete(site.cid);
      this.held.set(site.cid, hit);
      return hit;
    }
    const { verification: v, root, source } = await openCar(new Uint8Array(await readFile(join(this.dir, site.file))), {
      ...BOX_LIMITS,
      expectedRoot: site.cid,
    });
    if (!v.ok || !root || !source) throw new Error(v.errors[0] ?? 'failed verification');
    const entry = { root, source, bytes: v.totalBytes };
    this.held.set(site.cid, entry);
    this.total += entry.bytes;
    for (const [k, e] of this.held) {
      if (this.total <= this.maxBytes || k === site.cid) break;
      this.held.delete(k);
      this.total -= e.bytes;
    }
    return entry;
  }

  clear() {
    this.held.clear();
    this.total = 0;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const PAGE_CSS = `
:root{--bg:#f6f5f1;--panel:#fff;--ink:#1b1d1f;--muted:#6b6f75;--line:#dedcd5;--accent:#0f7b6c;--ok:#16794a;--ok-bg:#e3f4ea;--warn:#9a5b00;--warn-bg:#fdf0d8;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--panel:#1d1f22;--ink:#ececea;--muted:#9a9ea5;--line:#2f3236;--accent:#3cc2ad;--ok:#6fd19c;--ok-bg:#173326;--warn:#e9b44c;--warn-bg:#3a2c10}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}
p{margin:0 0 12px}
.muted{color:var(--muted);font-size:14px}
ul{list-style:none;padding:0;margin:20px 0}
li{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:0 0 10px}
li>a.open{display:block;padding:14px 16px 6px;color:inherit;text-decoration:none}
.title{font-weight:600;font-size:17px;overflow-wrap:anywhere}
.addr{color:var(--accent);font:13px ui-monospace,'SF Mono',Menlo,Consolas,monospace;overflow-wrap:anywhere}
.meta{padding:0 16px 12px;font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.tag{border-radius:999px;padding:1px 8px;font-size:12px}
.ok{background:var(--ok-bg);color:var(--ok)}
.warn{background:var(--warn-bg);color:var(--warn)}
.meta a{color:var(--muted)}
.note{border-top:1px solid var(--line);padding-top:16px;margin-top:28px}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

/** Sources a site may load from: only itself. Same rules as the app's viewer. */
function cspFor(own: string): string {
  return [
    `default-src ${own}`,
    `script-src ${own} 'unsafe-inline'`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    `media-src ${own} blob:`,
    `connect-src ${own}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    `base-uri ${own}`,
  ].join('; ');
}

function splitHost(header: string | undefined): { hostname: string; port: string } {
  const h = (header ?? '').trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[^:]*)(?::(\d+))?$/.exec(h);
  return { hostname: (m?.[1] ?? '').replace(/^\[|\]$/g, '').replace(/\.$/, ''), port: m?.[2] ?? '' };
}

/** `bytes=a-b` against a body of `size` bytes. null = unsatisfiable; undefined = no (usable) range. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

export interface BoxOptions {
  /** The box's own DNS name; sites live on its subdomains. */
  domain?: string;
  /** Memory for loaded sites, in bytes. */
  cacheBytes?: number;
  now?: number;
}

export interface BoxServer {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  contents: () => BoxContents;
  /** Re-read the folder. Also happens by itself when the folder changes. */
  reload: () => Promise<BoxContents>;
}

export async function createBox(dir: string, opts: BoxOptions = {}): Promise<BoxServer> {
  const domain = (opts.domain ?? 'mesh.lan').toLowerCase();
  const cache = new SiteCache(dir, opts.cacheBytes ?? 256 * 1024 * 1024);
  let contents = await loadBox(dir, opts);
  let stamp = (await stat(dir)).mtimeMs;
  let reloading: Promise<BoxContents> | undefined;

  const reload = () => {
    reloading ??= (async () => {
      try {
        stamp = (await stat(dir)).mtimeMs;
        contents = await loadBox(dir, opts);
        cache.clear();
        return contents;
      } finally {
        reloading = undefined;
      }
    })();
    return reloading;
  };
  // Adding or removing a file changes the folder's mtime; one stat per page view.
  const refreshIfChanged = async () => {
    try {
      if ((await stat(dir)).mtimeMs !== stamp) await reload();
    } catch {
      // Folder briefly unreadable (USB stick pulled): keep serving what we have.
    }
  };

  const text = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };
  const html = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };

  /** Is this host the box itself, reached without our DNS (so no subdomains)? */
  const isPlainHost = (h: string) => h === '' || isIP(h) !== 0 || h === 'localhost' || h.endsWith('.local') || !h.includes('.');

  const siteByCid = (cid: string): BoxSite | undefined => contents.sites.get(cid) ?? contents.sites.get(contents.origToMesh.get(cid) ?? '');

  function indexPage(hostname: string, port: string): string {
    const p = port && port !== '80' ? `:${port}` : '';
    const sub = !isPlainHost(hostname);
    const hrefCid = (cid: string) => (sub ? `http://${cid}.${domain}${p}/` : `/ipfs/${cid}/`);
    const hrefName = (n: string) => (sub ? `http://${n}.${domain}${p}/` : `/ipns/${n}/`);
    const boxBase = sub ? `http://${domain}${p}` : '';
    const sites = [...contents.sites.values()].sort(
      (a, b) => Number(b.names.length > 0) - Number(a.names.length > 0) || (a.title || a.cid).localeCompare(b.title || b.cid),
    );
    const items = sites.map((s) => {
      const n = s.names[0];
      const href = n ? hrefName(n.name) : hrefCid(s.cid);
      const addr = n ? n.name : `${s.cid.slice(0, 12)}…${s.cid.slice(-6)}`;
      const tags = [
        n ? (n.status === 'verified' ? '<span class="tag ok">Name verified</span>' : '<span class="tag warn">Name not checked against ENS</span>') : '',
        s.mesh ? '' : '<span class="tag warn">Wi-Fi only</span>',
      ].join('');
      return `<li><a class="open" href="${esc(href)}"><div class="title">${esc(s.title || addr)}</div><div class="addr">${esc(addr)}</div></a><div class="meta"><span>${human(s.totalBytes)}</span>${tags}<a href="${esc(`${boxBase}/car/${s.cid}.car`)}">File for the app</a></div></li>`;
    });
    const list = items.length ? `<ul>${items.join('')}</ul>` : '<p class="muted" style="margin-top:20px">No sites on this box yet.</p>';
    return page(
      'MeshSites box',
      `<h1>MeshSites box</h1><p class="muted">Websites stored on this box. They open without internet.</p>${list}` +
        `<div class="note muted"><p><strong>About trust.</strong> This box checked every site against its content hash before listing it. Your browser can't repeat that check, so you are trusting whoever runs this box. The MeshSites app checks each site itself.</p>` +
        `<p>${sites.length} site${sites.length === 1 ? '' : 's'}. “Wi-Fi only” sites are too large to pass between phones over Bluetooth.</p></div>`,
    );
  }

  async function serveSite(req: IncomingMessage, res: ServerResponse, site: BoxSite, rawPath: string, own: string, immutable: boolean) {
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return text(res, 400, 'Bad path');
    }
    let loaded: { root: CID; source: BlockSource };
    try {
      loaded = await cache.get(site);
    } catch (e) {
      return text(res, 503, `This site failed verification on the box: ${(e as Error).message}`);
    }
    const csp = cspFor(own);
    const r = resolvePath(loaded.root, path, loaded.source);
    // r.location is relative to the requested path ("css" → "css/").
    if (r.kind === 'redirect') return void res.writeHead(301, { location: r.location, 'cache-control': 'no-store' }).end();
    if (r.kind === 'not-found') return text(res, 404, 'Not found in this site', { 'content-security-policy': csp });
    const headers: Record<string, string | number> = {
      'content-type': r.mime,
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // A CID address can never change; a name can be pointed at a new site.
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'accept-ranges': 'bytes',
      'x-meshsites-root': site.cid,
    };
    const range = parseRange(req.headers.range, r.bytes.length);
    if (range === null) return void res.writeHead(416, { 'content-range': `bytes */${r.bytes.length}` }).end();
    const body = range ? r.bytes.subarray(range.start, range.end + 1) : r.bytes;
    if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${r.bytes.length}`;
    headers['content-length'] = body.length;
    res.writeHead(range ? 206 : 200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Only GET', { allow: 'GET, HEAD' });
    const { hostname, port } = splitHost(req.headers.host);
    const p = port && port !== '80' ? `:${port}` : '';
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return text(res, 400, 'Bad request');
    }
    await refreshIfChanged();

    // A site on its own origin: <cid>.<domain>, name.eth, or name.eth.<domain>.
    const under = hostname.endsWith(`.${domain}`) ? hostname.slice(0, -domain.length - 1) : undefined;
    const named = contents.names.get(under ?? hostname) ?? contents.names.get(hostname);
    if (named) return serveSite(req, res, contents.sites.get(named.cid)!, pathname.slice(1), `http://${hostname}${p}`, false);
    if (under !== undefined) {
      const site = siteByCid(under);
      if (site) return serveSite(req, res, site, pathname.slice(1), `http://${hostname}${p}`, true);
    }
    if (under !== undefined || hostname.endsWith('.eth')) {
      const back = `http://${domain}${p}/`;
      return html(res, 404, page('Not on this box', `<h1>Not on this box</h1><p><span class="addr">${esc(under ?? hostname)}</span> isn't stored here.</p><p><a href="${esc(back)}">See what this box has</a></p>`));
    }

    // Some other name our DNS answered for (a phone's "is there internet?" probe,
    // or whatever the visitor typed): send it to the list. This is what makes
    // phones pop the "sign in to network" sheet.
    if (hostname !== domain && !isPlainHost(hostname)) {
      return void res.writeHead(302, { location: `http://${domain}${p}/`, 'cache-control': 'no-store' }).end();
    }

    // The box itself.
    if (pathname === '/') return html(res, 200, indexPage(hostname, port));
    if (pathname === '/sites.json') {
      const body = JSON.stringify({
        v: 1,
        sites: [...contents.sites.values()].map((s) => ({
          cid: s.cid,
          title: s.title,
          sizeBytes: s.totalBytes,
          blockCount: s.blockCount,
          mesh: s.mesh,
          car: `/car/${s.cid}.car`,
          names: s.names.map((n) => ({ name: n.name, seq: n.seq, status: n.status, signer: toChecksumAddress(n.signer), record: `/record/${n.name}.json` })),
        })),
      });
      return text(res, 200, body, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    }
    let m = /^\/car\/([a-z0-9]+)\.car$/.exec(pathname);
    if (m) {
      const site = siteByCid(m[1]);
      if (!site) return text(res, 404, 'Not on this box');
      const bytes = await readFile(join(dir, site.file));
      res.writeHead(200, {
        'content-type': 'application/vnd.ipld.car',
        'content-length': bytes.length,
        'content-disposition': `attachment; filename="${site.cid}.car"`,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      return void res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    m = /^\/record\/(.+)\.json$/.exec(pathname);
    if (m) {
      let n: BoxName | undefined;
      try {
        n = contents.names.get(decodeURIComponent(m[1]));
      } catch {
        n = undefined;
      }
      if (!n) return text(res, 404, 'Not on this box');
      return text(res, 200, JSON.stringify(n.signed), { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    }
    // No subdomains by IP: sites share this origin, each confined to its path by CSP.
    m = /^\/(ipfs|ipns)\/([^/]+)(\/.*)?$/.exec(pathname);
    if (m) {
      let key: string;
      try {
        key = decodeURIComponent(m[2]);
      } catch {
        return text(res, 400, 'Bad path');
      }
      const site = m[1] === 'ipfs' ? siteByCid(key) : contents.sites.get(contents.names.get(key)?.cid ?? '');
      if (!site) return text(res, 404, 'Not on this box');
      if (m[3] === undefined) return void res.writeHead(301, { location: `/${m[1]}/${m[2]}/`, 'cache-control': 'no-store' }).end();
      return serveSite(req, res, site, m[3].slice(1), `http://${req.headers.host}/${m[1]}/${m[2]}/`, m[1] === 'ipfs');
    }
    return text(res, 404, 'Not found');
  }

  return {
    handler: (req, res) => {
      handle(req, res).catch((e) => {
        if (!res.headersSent) text(res, 500, 'Box error');
        else res.destroy();
        process.stderr.write(`error: ${req.url}: ${(e as Error).message}\n`);
      });
    },
    contents: () => contents,
    reload,
  };
}

/**
 * Answer one DNS query the way a box does: every name is this box. A queries
 * get `ip`; everything else (AAAA, HTTPS, …) gets an empty answer so clients
 * fall back to A at once. Returns undefined for packets not worth a reply.
 */
export function dnsAnswer(query: Uint8Array, ip: readonly number[]): Uint8Array | undefined {
  if (query.length < 17 || query.length > 512) return undefined;
  const flags = (query[2] << 8) | query[3];
  // Only standard queries with exactly one question.
  if (flags & 0x8000 || (flags >> 11) & 0xf || query[4] !== 0 || query[5] !== 1) return undefined;
  let i = 12;
  while (i < query.length && query[i] !== 0) {
    if (query[i] > 63) return undefined; // compression has no place in a question
    i += query[i] + 1;
  }
  const end = i + 5; // root label, QTYPE, QCLASS
  if (end > query.length) return undefined;
  const qtype = (query[i + 1] << 8) | query[i + 2];
  const qclass = (query[i + 3] << 8) | query[i + 4];
  const answer = qtype === 1 && qclass === 1;
  const out = new Uint8Array(end + (answer ? 16 : 0));
  out.set(query.subarray(0, end));
  out[2] = 0x84 | (query[2] & 0x01); // response, authoritative, RD as asked
  out[3] = 0x80; // recursion "available", NOERROR
  out.fill(0, 6, 12);
  if (answer) {
    out[7] = 1;
    // Name = pointer to the question, type A, class IN, TTL 10 s (so a phone
    // that returns to the internet forgets us quickly), 4 bytes of address.
    out.set([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, ...ip], end);
  }
  return out;
}

export function parseIPv4(s: string): number[] | undefined {
  if (isIP(s) !== 4) return undefined;
  return s.split('.').map(Number);
}

/** A DNS server that answers every name with `ip`. Port 53 needs root on most systems. */
export function startDns(ip: readonly number[], port = 53, host = '0.0.0.0'): Promise<Socket> {
  const sock = createSocket('udp4');
  sock.on('message', (msg, from) => {
    const reply = dnsAnswer(msg, ip);
    if (reply) sock.send(reply, from.port, from.address);
  });
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, host, () => resolve(sock));
  });
}

/** Run until killed. Prints what is being served and where. */
export async function serveCommand(dir: string, opts: { port: number; host: string; domain: string; dns?: number[] }): Promise<never> {
  const out = (s = '') => process.stdout.write(`${s}\n`);
  const box = await createBox(dir, { domain: opts.domain });
  const c = box.contents();
  for (const s of c.sites.values()) {
    const n = s.names[0];
    out(`  ${s.cid}  ${human(s.totalBytes).padStart(8)}  ${n ? `${n.name} (${n.status})` : s.title || s.file}${s.mesh ? '' : '  [Wi-Fi only]'}`);
  }
  for (const p of c.problems) process.stderr.write(`  refused  ${p}\n`);
  out(`${c.sites.size} site(s), ${c.names.size} name(s) from ${dir}`);

  const server = createServer(box.handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, resolve);
  });
  const p = opts.port === 80 ? '' : `:${opts.port}`;
  out();
  out(`This computer:  http://localhost${p}/`);
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out(`On the network: http://${a.address}${p}/`);
  if (opts.dns) {
    try {
      await startDns(opts.dns);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new Error(code === 'EACCES' ? 'DNS needs port 53: run with sudo' : `DNS on port 53: ${(e as Error).message}`);
    }
    out(`DNS:            every name → ${opts.dns.join('.')}   so http://${opts.domain}${p}/ and http://name.eth${p}/ work`);
    out(`                (point the network's DNS server at ${opts.dns.join('.')}; see docs/box.md)`);
  } else {
    out(`With box DNS:   http://${opts.domain}${p}/   (add --dns <this computer's IP>; see docs/box.md)`);
  }
  return new Promise<never>(() => {});
}
