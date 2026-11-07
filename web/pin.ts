/**
 * Pin web/out/ to Pinata (the shared local pin key, from PINATA_JWT).
 *   node --env-file=.env.local web/pin.ts      (or: npm run pin)
 * Prints the CID to put in meshsites.eth's contenthash.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const JWT = process.env.PINATA_JWT;
if (!JWT) {
  console.error('PINATA_JWT not set (expected in .env.local)');
  process.exit(1);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'out');

function walk(dir: string, acc: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const files = walk(ROOT);
if (!files.some((f) => relative(ROOT, f) === 'index.html')) {
  console.error('web/out has no index.html: run `npm run build:static` first');
  process.exit(1);
}
const form = new FormData();
for (const f of files) form.append('file', new Blob([readFileSync(f)]), `meshsites/${relative(ROOT, f)}`);
form.append('pinataMetadata', JSON.stringify({ name: 'meshsites.eth' }));
form.append('pinataOptions', JSON.stringify({ cidVersion: 1, wrapWithDirectory: false }));

const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}` },
  body: form,
});
const text = await res.text();
if (!res.ok) {
  console.error('Pin failed:', res.status, text);
  process.exit(1);
}
const { IpfsHash, PinSize } = JSON.parse(text);
console.log(`pinned ${files.length} files, ${PinSize} bytes`);
console.log(`CID: ${IpfsHash}`);
console.log(`contenthash: ipfs://${IpfsHash}`);
