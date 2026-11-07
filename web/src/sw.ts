/// <reference lib="webworker" />
/**
 * Service worker for /site/<cid>/…: serves files ONLY from a CAR that it
 * verifies itself (every block hashed, DAG complete, caps). It is the trust
 * boundary: whatever the page put in IndexedDB is re-checked here.
 *
 * Network policy for site pages:
 *   - same-site paths (/site/<same cid>/…)  → served from the verified DAG
 *   - anything else (other paths, other sites, other origins) → 403
 *   - plus a CSP whose every source is this site's own path, so fetch/XHR/
 *     WebSocket/beacon/img to anywhere else are refused by the browser first
 * Known gap (testbed only): WebRTC is not covered by CSP or the SW. The iOS
 * app uses WKContentRuleList + a custom scheme instead.
 */
import { CID } from 'multiformats/cid';
import { readCar, resolvePath, verifyDag, type BlockSource } from '@meshsites/protocol';
import { getCar } from './store.ts';

declare const self: ServiceWorkerGlobalScope;

/**
 * CSP scoped to this one site's path, so even same-origin URLs outside
 * /site/<cid>/ are refused by the browser before they reach the SW.
 */
function cspFor(root: string) {
  const own = `${self.location.origin}/site/${root}/`;
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

const verified = new Map<string, Promise<BlockSource>>();

async function loadSite(root: string): Promise<BlockSource> {
  const stored = await getCar(root);
  if (!stored) throw new Error('site not in local store');
  const { root: carRoot, blocks, errors } = await readCar(stored.car);
  if (errors.length) throw new Error(errors[0]);
  if (carRoot.toString() !== root) throw new Error('CAR root does not match the requested CID');
  const src: BlockSource = { get: (c) => blocks.get(c.toString())?.bytes };
  const dag = verifyDag(carRoot, src);
  if (!dag.ok) throw new Error(dag.errors[0] ?? `${dag.missing.length} block(s) missing`);
  return src;
}

function site(root: string) {
  let p = verified.get(root);
  if (!p) {
    p = loadSite(root);
    p.catch(() => verified.delete(root));
    verified.set(root, p);
  }
  return p;
}

const SITE_RE = /^\/site\/([a-z0-9]+)\/(.*)$/;

function blocked(why: string) {
  return new Response(`Blocked by MeshSites: ${why}`, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-meshsites': 'blocked' } });
}

async function clientSite(e: FetchEvent): Promise<string | undefined> {
  const c = e.clientId ? await self.clients.get(e.clientId) : undefined;
  const url = c?.url ?? e.request.referrer;
  if (!url) return undefined;
  const u = new URL(url);
  if (u.origin !== self.location.origin) return undefined;
  return SITE_RE.exec(u.pathname)?.[1];
}

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  e.respondWith(
    (async () => {
      const url = new URL(e.request.url);
      const fromSite = await clientSite(e);
      const m = url.origin === self.location.origin ? SITE_RE.exec(url.pathname) : null;

      if (!m) {
        // Only site pages are restricted; the testbed's own pages are not controlled (scope /site/).
        if (fromSite) return blocked(`network access to ${url.origin === self.location.origin ? url.pathname : url.origin} is not allowed`);
        return fetch(e.request);
      }
      const [, rootStr, rawPath] = m;
      if (fromSite && fromSite !== rootStr) return blocked('a site may not read another site');
      if (e.request.method !== 'GET' && e.request.method !== 'HEAD') return blocked('only GET');
      let root: CID;
      try {
        root = CID.parse(rootStr);
      } catch {
        return new Response('bad CID', { status: 400 });
      }
      let src: BlockSource;
      try {
        src = await site(root.toString());
      } catch (err) {
        return new Response(`Not available offline: ${(err as Error).message}`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      let path: string;
      try {
        path = decodeURIComponent(rawPath);
      } catch {
        return new Response('bad path', { status: 400 });
      }
      const r = resolvePath(root, path, src);
      // r.location is relative to the requested path ("css" → "css/").
      if (r.kind === 'redirect') return Response.redirect(new URL(r.location, url).href, 301);
      if (r.kind === 'not-found') return new Response('Not found in this site', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': cspFor(root.toString()) } });
      return new Response(r.bytes as BodyInit, {
        status: 200,
        headers: {
          'content-type': r.mime,
          'content-security-policy': cspFor(root.toString()),
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
          'x-meshsites-root': root.toString(),
        },
      });
    })(),
  );
});
