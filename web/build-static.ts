/**
 * Static build for IPFS / meshsites.eth: `npm run build:static` → web/out/
 *
 *   out/index.html, simulator.html,          pages (multi-tab page left out:
 *   viewer.html, style.css
 *                                            it needs the signalling server)
 *   out/sw.js                                service worker at the root, so it
 *                                            can control /site/
 *   out/dist/{sim,viewer}.js                 minified bundles, no source maps
 *   out/vectors/…                            the demo site + records the
 *                                            simulator loads
 *
 * Serve from the ROOT of an origin (https://meshsites.eth.limo/). Path
 * gateways (…/ipfs/<cid>/) can't host the viewer, which needs /sw.js and
 * /site/; the viewer detects that and says so.
 */
import * as esbuild from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importer } from 'ipfs-unixfs-importer';
import { buildOptions } from './build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
const vectors = join(here, '../protocol/vectors');

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'dist'), { recursive: true });
await mkdir(join(out, 'vectors'), { recursive: true });

await esbuild.build({
  ...buildOptions,
  entryPoints: { sim: join(here, 'src/sim.ts'), viewer: join(here, 'src/viewer.ts') },
  outdir: join(out, 'dist'),
  sourcemap: false,
  minify: true,
  logLevel: 'warning',
});
await esbuild.build({
  ...buildOptions,
  entryPoints: { sw: join(here, 'src/sw.ts') },
  outdir: out,
  sourcemap: false,
  minify: true,
  logLevel: 'warning',
});

// Pages: drop the multi-tab page and its nav links.
const TAB_LINK = /<a href="tab\.html"[^>]*>[^<]*<\/a>/g;
for (const f of await readdir(join(here, 'public'))) {
  if (f === 'tab.html') continue;
  const src = join(here, 'public', f);
  if (f.endsWith('.html')) {
    const html = (await readFile(src, 'utf8')).replace(TAB_LINK, '');
    if (/(href|src)="\/(?!\/)/.test(html)) throw new Error(`${f} has a root-absolute URL; use relative paths for IPFS`);
    await writeFile(join(out, f), html);
  } else await copyFile(src, join(out, f));
}

for (const f of ['site-basic.car', 'records.json', 'car.json']) await copyFile(join(vectors, f), join(out, 'vectors', f));

// Report size and the CID a default CIDv1 `ipfs add -r` would give (the pin's own CID is authoritative).
async function walk(dir: string, base = ''): Promise<{ path: string; content: Uint8Array }[]> {
  const files = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...(await walk(join(dir, e.name), rel)));
    else files.push({ path: rel, content: new Uint8Array(await readFile(join(dir, e.name))) });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
const files = await walk(out);
const blocks = { put: (c: unknown) => c };
let root;
for await (const e of importer(files, blocks as never, { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true })) root = e.cid;
let total = 0;
for (const f of files) {
  total += f.content.length;
  console.log(`  ${f.path.padEnd(28)} ${(f.content.length / 1024).toFixed(1).padStart(7)} KiB`);
}
console.log(`web/out: ${files.length} files, ${(total / 1024).toFixed(0)} KiB`);
console.log(`CIDv1 (ipfs add -r --cid-version=1): ${root}`);
