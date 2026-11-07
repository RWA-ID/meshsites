/**
 * Dev server for the web testbed: static files + WebRTC signalling relay.
 *
 *   node web/server.ts           → http://127.0.0.1:5173 (this machine only)
 *   node web/server.ts --lan     → also reachable from phones on the LAN
 *
 * Signalling (rooms are in-memory, nothing is stored):
 *   GET  /signal/events?room=R&peer=P   Server-Sent Events: hello/bye/msg
 *   POST /signal/send  {room, from, to, data}
 * The server only forwards SDP/ICE between tabs. Mesh traffic itself goes
 * peer-to-peer over WebRTC data channels.
 */
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { build } from './build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const lan = process.argv.includes('--lan');
const port = Number(process.env.PORT ?? 5173);
// Loopback on both IPv4 and IPv6 ("localhost" may resolve to ::1), or every interface with --lan.
const hosts = lan ? ['::'] : ['127.0.0.1', '::1'];

const ROOTS: [string, string][] = [
  ['/dist/', join(here, 'dist')],
  ['/vectors/', join(here, '../protocol/vectors')],
  ['/', join(here, 'public')],
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.car': 'application/vnd.ipld.car',
  '.svg': 'image/svg+xml',
};

type Client = { res: ServerResponse; peer: string; name: string };
const rooms = new Map<string, Map<string, Client>>();

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

await build(true);

const handler = async (req: import('node:http').IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/signal/events') {
      const room = url.searchParams.get('room') ?? '';
      const peer = url.searchParams.get('peer') ?? '';
      const name = (url.searchParams.get('name') ?? peer).slice(0, 24);
      if (!ID_RE.test(room) || !ID_RE.test(peer)) return void res.writeHead(400).end();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const r = rooms.get(room) ?? new Map<string, Client>();
      rooms.set(room, r);
      for (const c of r.values()) {
        sse(c.res, 'hello', { peer, name });
        sse(res, 'hello', { peer: c.peer, name: c.name });
      }
      r.set(peer, { res, peer, name });
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        r.delete(peer);
        for (const c of r.values()) sse(c.res, 'bye', { peer });
        if (!r.size) rooms.delete(room);
      });
      return;
    }
    if (url.pathname === '/signal/send' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 64 * 1024) return void res.writeHead(413).end();
      }
      const { room, from, to, data } = JSON.parse(body);
      const target = rooms.get(room)?.get(to);
      if (!target || !rooms.get(room)?.has(from)) return void res.writeHead(404).end();
      sse(target.res, 'msg', { from, data });
      return void res.writeHead(204).end();
    }

    // Static files.
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const isSw = path === '/sw.js';
    if (isSw) path = '/dist/sw.js'; // served at the root so it may control /site/
    for (const [prefix, dir] of ROOTS) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(join(dir, path.slice(prefix.length)));
      if (!file.startsWith(dir)) break;
      try {
        if (!(await stat(file)).isFile()) continue;
      } catch {
        continue;
      }
      const headers: Record<string, string> = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
      if (isSw) headers['service-worker-allowed'] = '/site/';
      return void res.writeHead(200, headers).end(await readFile(file));
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e));
  }
};

for (const [i, host] of hosts.entries())
  createServer(handler)
    .on('error', (e) => console.error(`listen ${host}: ${(e as Error).message}`))
    .listen(port, host, () => {
      if (i > 0) return;
      console.log(`MeshSites testbed on http://localhost:${port}/`);
      if (lan)
        for (const list of Object.values(networkInterfaces()))
          for (const ifc of list ?? []) if (ifc.family === 'IPv4' && !ifc.internal) console.log(`  LAN: http://${ifc.address}:${port}/  (service workers need https or localhost; see web/README.md)`);
    });
