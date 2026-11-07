/** Simulated fetch timings (NOT real radios). `node protocol/ts/scripts/bench-sim.ts` */
import { readFile } from 'node:fs/promises';
import { buildSiteCar } from '../src/index.ts';
import { FakeScheduler, SimWorld } from '../src/mesh/index.ts';

function noise(n: number) {
  const out = new Uint8Array(n);
  let x = 0x9e3779b9;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const sites = {
  'site-basic (41 KB)': new Uint8Array(await readFile(new URL('../../vectors/site-basic.car', import.meta.url))),
  '100 KB': (await buildSiteCar([{ path: 'index.html', content: new TextEncoder().encode('<h1>x</h1>') }, { path: 'a.bin', content: noise(100_000) }])).car,
  '1 MB': (await buildSiteCar([{ path: 'index.html', content: new TextEncoder().encode('<h1>x</h1>') }, { path: 'a.bin', content: noise(1_000_000) }])).car,
};
console.log('| Site | Link | Hops | Total (s) | Transfer after 3 s HAVE window (s) | Effective KB/s |');
console.log('|---|---|---|---|---|---|');
for (const [label, car] of Object.entries(sites)) {
  for (const [link, hops] of [['BLE', 1], ['BLE', 2], ['BLE', 3], ['Wi-Fi', 1]] as const) {
    const s = new FakeScheduler();
    const names = Array.from({ length: hops + 1 }, (_, i) => String.fromCharCode(65 + i));
    const w = new SimWorld(s, 7);
    for (const n of names) w.add(n);
    for (let i = 1; i < names.length; i++) w.link(names[i - 1], names[i], { bulk: link === 'Wi-Fi' });
    const holder = w.get(names[0]).node!;
    const site = await holder.importCar(car);
    await s.advance(500);
    const r = await s.runUntil(w.get(names.at(-1)!).node!.fetch(site.root), 3_600_000);
    const xfer = (r.ms - 3000) / 1000;
    console.log(`| ${label} | ${link} | ${hops} | ${(r.ms / 1000).toFixed(1)} | ${xfer.toFixed(1)} | ${((r.bytes / 1000) / xfer).toFixed(1)} |`);
  }
}
