/**
 * Single-page mesh simulator: every node lives in this page, links are
 * in-memory with BLE-like shaping. Shows packets moving hop by hop and the
 * timing of a fetch.
 */
import { esc } from './esc.ts';
import { orderedBlocks, writeCar, type SignedNameRecord } from '@meshsites/protocol';
import { CID } from 'multiformats/cid';
import { RealScheduler, SimWorld, type RadioEvent, type NodeEvent, type OpenResult } from '@meshsites/protocol/mesh';
import { putCar } from './store.ts';

interface ScenarioNode {
  name: string;
  x: number;
  y: number;
  holder?: boolean;
  patched?: boolean;
  evil?: boolean;
  seeding?: boolean;
}

interface Scenario {
  id: string;
  title: string;
  blurb: string;
  nodes: ScenarioNode[];
  links: [string, string, { bulk?: boolean }?][];
  blocked?: [string, string][];
  opener: string;
  target: 'name' | 'cid';
  trusted: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'chain',
    title: 'Two hops: A → B → C',
    blurb: 'A was online and pinned example.eth. C is out of A\'s range and opens it by name through B. B only relays.',
    nodes: [
      { name: 'A', x: 90, y: 160, holder: true },
      { name: 'B', x: 300, y: 160 },
      { name: 'C', x: 510, y: 160 },
    ],
    links: [['A', 'B'], ['B', 'C']],
    opener: 'C',
    target: 'name',
    trusted: true,
  },
  {
    id: 'unverified',
    title: 'Unknown signer',
    blurb: 'Same chain, but C never learned who may sign for example.eth. The site still opens, labelled "Unverified name".',
    nodes: [
      { name: 'A', x: 90, y: 160, holder: true },
      { name: 'B', x: 300, y: 160 },
      { name: 'C', x: 510, y: 160 },
    ],
    links: [['A', 'B'], ['B', 'C']],
    opener: 'C',
    target: 'name',
    trusted: false,
  },
  {
    id: 'old',
    title: 'Through an old bitchat client',
    blurb: 'The middle phone runs unpatched bitchat. It relays MeshSites traffic as an unknown packet type without understanding it.',
    nodes: [
      { name: 'A', x: 90, y: 160, holder: true },
      { name: 'Old', x: 300, y: 160, patched: false },
      { name: 'C', x: 510, y: 160 },
    ],
    links: [['A', 'Old'], ['Old', 'C']],
    opener: 'C',
    target: 'name',
    trusted: true,
  },
  {
    id: 'evil',
    title: 'A lying peer',
    blurb: 'Evil is next to C and answers first, but it corrupts every block. C rejects the first bad block by hash and switches to A.',
    nodes: [
      { name: 'A', x: 90, y: 110, holder: true },
      { name: 'B', x: 300, y: 110 },
      { name: 'C', x: 510, y: 180 },
      { name: 'Evil', x: 300, y: 260, holder: true, evil: true },
    ],
    links: [['A', 'B'], ['B', 'C'], ['Evil', 'C']],
    opener: 'C',
    target: 'cid',
    trusted: true,
  },
  {
    id: 'bulk',
    title: 'Peer-to-peer Wi-Fi neighbour',
    blurb: 'A and C are side by side with peer-to-peer Wi-Fi (dashed). Discovery still uses BLE; the blocks go over Wi-Fi.',
    nodes: [
      { name: 'A', x: 160, y: 160, holder: true },
      { name: 'C', x: 440, y: 160 },
    ],
    links: [['A', 'C', { bulk: true }]],
    opener: 'C',
    target: 'name',
    trusted: true,
  },
  {
    id: 'grid',
    title: 'Grid, 4 hops',
    blurb: 'A 3×3 grid. Broadcast relays reach only a subset of neighbours (like bitchat), and the WANT still finds A four hops away.',
    nodes: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((name, i) => ({ name, x: 140 + (i % 3) * 160, y: 50 + Math.floor(i / 3) * 110, holder: name === 'A' })),
    links: [['A', 'B'], ['B', 'C'], ['D', 'E'], ['E', 'F'], ['G', 'H'], ['H', 'I'], ['A', 'D'], ['D', 'G'], ['B', 'E'], ['E', 'H'], ['C', 'F'], ['F', 'I']],
    opener: 'I',
    target: 'name',
    trusted: true,
  },
  {
    id: 'forced',
    title: 'Forced relay (debug setting)',
    blurb: 'A and C are in range, but the debug block list stops them talking directly, so traffic must go via B. This is how 2-hop behaviour gets tested with only a few devices.',
    nodes: [
      { name: 'A', x: 120, y: 220, holder: true },
      { name: 'B', x: 300, y: 70 },
      { name: 'C', x: 480, y: 220 },
    ],
    links: [['A', 'B'], ['B', 'C'], ['A', 'C']],
    blocked: [['A', 'C']],
    opener: 'C',
    target: 'name',
    trusted: true,
  },
];

const COLORS: Record<string, string> = {
  ANNOUNCE: 'var(--pk-announce)',
  NAME_RECORD: 'var(--pk-name)',
  WANT: 'var(--pk-want)',
  HAVE: 'var(--pk-have)',
  BLOCK_REQ: 'var(--pk-req)',
  BLOCK: 'var(--pk-block)',
  BLOCK_NONE: 'var(--pk-none)',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const svg = $('graph') as unknown as SVGSVGElement;
const SVGNS = 'http://www.w3.org/2000/svg';

let carBytes: Uint8Array;
let records: { cases: { id: string; input: SignedNameRecord }[]; testKeys: { address: string }[] };
let rootCid: string;

let current: { scenario: Scenario; world: SimWorld; sched: RealScheduler; speed: number } | undefined;
let runId = 0;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element = svg) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.appendChild(e);
  return e;
}

function log(msg: string, cls = '') {
  const box = $('log');
  const line = document.createElement('div');
  line.className = `line ${cls}`;
  const t = current ? (current.sched.now() / 1000).toFixed(2) : '0.00';
  line.innerHTML = `<span class="t">${t}s</span> `;
  line.append(document.createTextNode(msg));
  box.append(line);
  while (box.childElementCount > 400) box.firstElementChild!.remove();
  box.scrollTop = box.scrollHeight;
}

function nodeState(name: string, state: string) {
  const g = svg.querySelector(`[data-node="${name}"]`);
  if (g) g.setAttribute('data-state', state);
}

function drawScenario(sc: Scenario, world: SimWorld) {
  svg.replaceChildren();
  const pos = new Map(sc.nodes.map((n) => [n.name, n]));
  const blocked = new Set((sc.blocked ?? []).map(([a, b]) => [a, b].sort().join('|')));
  for (const [a, b, o] of sc.links) {
    const A = pos.get(a)!;
    const B = pos.get(b)!;
    const isBlocked = blocked.has([a, b].sort().join('|'));
    el('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, class: `edge${isBlocked ? ' blocked' : ''}` });
    if (o?.bulk) el('line', { x1: A.x, y1: A.y + 8, x2: B.x, y2: B.y + 8, class: 'edge bulk' });
    if (isBlocked) el('text', { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 - 8, class: 'edge-label' }).textContent = 'blocked (debug)';
  }
  el('g', { id: 'packets' });
  for (const n of sc.nodes) {
    const g = el('g', { 'data-node': n.name, class: 'node', 'data-state': n.holder ? (n.evil ? 'evil' : 'holder') : n.patched === false ? 'old' : 'idle', transform: `translate(${n.x},${n.y})` });
    el('circle', { r: 26 }, g);
    el('text', { class: 'name', y: 5 }, g).textContent = n.name;
    const sub = n.evil ? 'corrupts blocks' : n.patched === false ? 'old bitchat' : n.holder ? 'has the site' : n.name === sc.opener ? 'opens it' : 'relay';
    el('text', { class: 'sub', y: 44 }, g).textContent = sub;
  }
  void world;
}

function animatePacket(sc: Scenario, world: SimWorld, e: Extract<RadioEvent, { kind: 'tx' }>, speed: number) {
  const from = world.byPeer(e.from);
  const to = world.byPeer(e.to);
  if (!from || !to) return;
  const A = sc.nodes.find((n) => n.name === from.name)!;
  const B = sc.nodes.find((n) => n.name === to.name)!;
  const layer = svg.querySelector('#packets')!;
  const off = e.link === 'bulk' ? 8 : 0;
  const dot = el('circle', { r: e.label === 'BLOCK' ? 6 : 4.5, cx: A.x, cy: A.y + off, class: `pk${e.lost ? ' lost' : ''}`, fill: COLORS[e.label] ?? 'var(--muted)' }, layer);
  const ms = Math.max(220, (e.airtimeMs + 10) / speed);
  const t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    const kk = e.lost ? Math.min(k, 0.5) : k;
    dot.setAttribute('cx', String(A.x + (B.x - A.x) * kk));
    dot.setAttribute('cy', String(A.y + off + (B.y - A.y) * kk));
    if (e.lost && k >= 0.5) dot.setAttribute('opacity', String(Math.max(0, 1 - (k - 0.5) * 2)));
    if (k < 1) requestAnimationFrame(step);
    else dot.remove();
  };
  requestAnimationFrame(step);
}

function buildWorld(sc: Scenario, speed: number, loss: number) {
  const sched = new RealScheduler(speed);
  const world = new SimWorld(sched, Date.now() & 0xffff);
  for (const n of sc.nodes) world.add(n.name, { patched: n.patched ?? true, corruptBlocks: !!n.evil, seeding: n.seeding ?? true });
  for (const [a, b, o] of sc.links) world.link(a, b, { ble: { loss }, bulk: o?.bulk });
  for (const [a, b] of sc.blocked ?? []) {
    world.get(a).radio.blocked.add(world.get(b).radio.peerId);
    world.get(b).radio.blocked.add(world.get(a).radio.peerId);
  }
  return { sched, world };
}

async function setup() {
  runId++;
  const id = runId;
  current?.world.nodes.forEach((n) => n.node?.stop());
  const sc = SCENARIOS.find((s) => s.id === ($('scenario') as HTMLSelectElement).value)!;
  const speed = Number(($('speed') as HTMLSelectElement).value);
  const loss = Number(($('loss') as HTMLInputElement).value) / 100;
  $('blurb').textContent = sc.blurb;
  $('log').replaceChildren();
  $('result').replaceChildren();
  $('view').setAttribute('hidden', '');
  const { sched, world } = buildWorld(sc, speed, loss);
  current = { scenario: sc, world, sched, speed };
  drawScenario(sc, world);

  for (const n of world.nodes.values()) {
    n.radio.listeners.push((e) => {
      if (id !== runId) return;
      if (e.kind === 'tx') animatePacket(sc, world, e, speed);
      if (e.kind === 'tx' && e.lost) log(`${n.name} → ${world.byPeer(e.to)?.name}: ${e.label} lost on air`, 'warn');
      if (e.kind === 'drop') log(`${n.name}: dropped ${e.label} (${e.reason})`, 'warn');
    });
    n.node?.listeners.push((e: NodeEvent) => {
      if (id !== runId) return;
      if (e.kind === 'log') log(`${e.node}: ${e.msg}`, /REJECT/.test(e.msg) ? 'bad' : '');
      if (e.kind === 'progress') {
        nodeState(e.node, 'fetching');
        const pct = e.expectedBlocks ? Math.min(100, Math.round((e.blocks / e.expectedBlocks) * 100)) : 0;
        $('progress').style.setProperty('--p', `${pct}%`);
        $('progress-label').textContent = `${e.blocks}${e.expectedBlocks ? ` / ${e.expectedBlocks}` : ''} blocks · ${(e.bytes / 1024).toFixed(1)} KiB`;
      }
      if (e.kind === 'site' && e.complete && !sc.nodes.find((x) => x.name === e.node)?.holder) nodeState(e.node, 'done');
    });
  }

  for (const n of sc.nodes.filter((x) => x.holder)) {
    const node = world.get(n.name).node!;
    await node.importCar(carBytes);
    if (!n.evil) node.addRecord(records.cases.find((c) => c.id === 'valid-verified')!.input);
  }
  const opener = world.get(sc.opener).node!;
  if (sc.trusted) opener.trust('example.eth', records.testKeys[0].address);
  $('target').textContent = sc.target === 'name' ? 'example.eth' : `${rootCid.slice(0, 16)}…`;
  $('progress').style.setProperty('--p', '0%');
  $('progress-label').textContent = 'idle';
  log(`scenario ready: ${sc.title}. ${sc.opener} ${sc.trusted ? 'trusts the signer for example.eth' : 'has no trusted signer'}.`);
}

async function run() {
  // A second run on the same world would be a cache hit; start fresh instead.
  if (!current || current.world.get(current.scenario.opener).node!.sites.get(rootCid)?.complete) await setup();
  const { scenario: sc, world, sched } = current!;
  const id = runId;
  const btn = $('run') as HTMLButtonElement;
  btn.disabled = true;
  const opener = world.get(sc.opener).node!;
  const target = sc.target === 'name' ? 'example.eth' : rootCid;
  log(`${sc.opener}: open ${target}`);
  const t0 = sched.now();
  try {
    const r: OpenResult = await opener.open(target);
    if (id !== runId) return;
    showResult(r, sched.now() - t0, world);
    const blocks = orderedBlocks(CID.parse(r.root), opener);
    await putCar({ root: r.root, car: await writeCar([CID.parse(r.root)], blocks), label: r.name ?? 'site', savedAt: Date.now() });
    const view = $('view') as HTMLAnchorElement;
    view.href = `viewer.html#${r.root}${r.name ? `?name=${encodeURIComponent(r.name)}&status=${r.status}` : ''}`;
    view.removeAttribute('hidden');
  } catch (e) {
    log(`${sc.opener}: ${(e as Error).message}`, 'bad');
    $('result').innerHTML = `<p class="badge bad">Failed</p><p>${esc((e as Error).message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function showResult(r: OpenResult, ms: number, world: SimWorld) {
  const s = r.stats;
  const badge =
    r.status === 'verified'
      ? '<span class="badge ok">Verified name</span>'
      : r.status === 'unverified'
        ? '<span class="badge warn">Unverified name</span>'
        : '<span class="badge neutral">Raw CID</span>';
  const rows: [string, string][] = [
    ['Total', `${(ms / 1000).toFixed(2)} s (simulated)`],
    ['First HAVE', s.firstHaveMs !== undefined ? `${(s.firstHaveMs / 1000).toFixed(2)} s` : '-'],
    ['HAVE window', '3.00 s (fixed, per brief)'],
    ['Transfer', `${s.blocks} blocks, ${(s.bytes / 1024).toFixed(1)} KiB`],
    ['From', s.sources.map((x) => `${world.byPeer(x.peer)?.name} (${x.hops} hop${x.hops > 1 ? 's' : ''}, ${x.via === 'bulk' ? 'Wi-Fi' : 'BLE'}, ${x.blocks} blocks)`).join(' → ') || '-'],
    ['Rejected blocks', String(s.corruptRejected)],
  ];
  $('result').innerHTML = `${badge}<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  log(`done: ${r.status} in ${(ms / 1000).toFixed(2)} s`, 'good');
}

async function main() {
  const sel = $('scenario') as HTMLSelectElement;
  for (const s of SCENARIOS) sel.add(new Option(s.title, s.id));
  const [car, rec, carJson] = await Promise.all([
    fetch('vectors/site-basic.car').then((r) => r.arrayBuffer()),
    fetch('vectors/records.json').then((r) => r.json()),
    fetch('vectors/car.json').then((r) => r.json()),
  ]);
  carBytes = new Uint8Array(car);
  records = rec;
  rootCid = carJson.rootCid;
  sel.onchange = setup;
  $('speed').onchange = setup;
  $('loss').oninput = () => ($('loss-v').textContent = `${($('loss') as HTMLInputElement).value}%`);
  $('loss').onchange = setup;
  $('reset').onclick = setup;
  $('run').onclick = run;
  await setup();
}

main().catch((e) => log(String(e), 'bad'));
