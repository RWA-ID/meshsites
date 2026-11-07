/**
 * Offline viewer: stores verified CARs and renders them through the service
 * worker at /site/<cid>/. Includes the explicit "no network" probe (M2's
 * requirement, mirrored here for the web testbed).
 */
import { esc } from './esc.ts';
import { buildSiteCar, verifyCar } from '@meshsites/protocol';
import { deleteCar, getCar, listCars, putCar } from './store.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enc = new TextEncoder();

async function registerSw(): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable (needs https or localhost).');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/site/' });
  const sw = reg.installing ?? reg.waiting ?? reg.active;
  if (sw && sw.state !== 'activated')
    await new Promise<void>((resolve) => {
      sw.addEventListener('statechange', () => sw.state === 'activated' && resolve());
    });
}

function params() {
  const [root, q] = location.hash.slice(1).split('?');
  return { root: root || undefined, q: new URLSearchParams(q ?? '') };
}

async function refreshList() {
  const list = $('sites');
  const cars = (await listCars()).sort((a, b) => b.savedAt - a.savedAt);
  list.replaceChildren();
  if (!cars.length) list.innerHTML = '<p class="muted">Nothing stored yet. Fetch a site in the simulator, or import a .car file.</p>';
  for (const c of cars) {
    const row = document.createElement('div');
    row.className = 'peer';
    const who = document.createElement('div');
    who.innerHTML = `<div class="who"></div><div class="mono muted"></div>`;
    who.querySelector('.who')!.textContent = c.label;
    who.querySelector('.mono')!.textContent = `${c.root.slice(0, 24)}… · ${(c.car.length / 1024).toFixed(1)} KiB`;
    const actions = document.createElement('div');
    actions.className = 'row';
    const open = document.createElement('button');
    open.textContent = 'Open';
    open.onclick = () => (location.hash = c.root);
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.onclick = async () => {
      await deleteCar(c.root);
      if (params().root === c.root) location.hash = '';
      refreshList();
    };
    actions.append(open, del);
    row.append(who, actions);
    list.append(row);
  }
}

async function show() {
  const { root, q } = params();
  const frame = $('frame') as HTMLIFrameElement;
  const head = $('site-head');
  if (!root) {
    frame.hidden = true;
    head.innerHTML = '<p class="muted">Pick a stored site.</p>';
    return;
  }
  const stored = await getCar(root);
  const name = q.get('name') ?? (stored && stored.label !== 'site' ? stored.label : undefined);
  const status = q.get('status');
  const badge =
    status === 'verified'
      ? '<span class="badge ok">Verified name</span>'
      : status === 'unverified'
        ? '<span class="badge warn">Unverified name: the signer for this name is unknown</span>'
        : '<span class="badge neutral">Opened by CID</span>';
  head.innerHTML = `${badge}<div class="mono"></div>`;
  head.querySelector('.mono')!.textContent = `${name ? `${name} → ` : ''}${root}`;
  frame.hidden = false;
  frame.src = `/site/${root}/`;
}

async function importFile(f: File) {
  const car = new Uint8Array(await f.arrayBuffer());
  const v = await verifyCar(car);
  if (!v.ok) {
    $('import-msg').textContent = `Rejected: ${v.errors[0]}`;
    $('import-msg').className = 'badge bad';
    return;
  }
  await putCar({ root: v.root!, car, label: f.name.replace(/\.car$/, ''), savedAt: Date.now() });
  $('import-msg').textContent = `Verified ${v.blockCount} blocks · stored`;
  $('import-msg').className = 'badge ok';
  await refreshList();
  location.hash = v.root!;
}

// ---------- the no-network probe ----------

interface ProbeResult {
  id: string;
  what: string;
  expect: 'allowed' | 'blocked';
  got: 'allowed' | 'blocked' | 'gap';
  detail?: string;
}

const PROBE_JS = `
const results = [];
const add = (id, what, expect, got, detail) => results.push({ id, what, expect, got, detail });
const tryFetch = async (id, what, url, expect) => {
  try { const r = await fetch(url); add(id, what, expect, r.ok ? 'allowed' : 'blocked', 'HTTP ' + r.status); }
  catch (e) { add(id, what, expect, 'blocked', String(e.message || e)); }
};
const tryImg = (id, what, url, expect) => new Promise((res) => {
  const i = new Image();
  i.onload = () => { add(id, what, expect, 'allowed'); res(); };
  i.onerror = () => { add(id, what, expect, 'blocked'); res(); };
  i.src = url;
  setTimeout(() => { add(id, what, expect, 'blocked', 'timeout'); res(); }, 3000);
});
(async () => {
  await tryFetch('own-file', "fetch() of the site's own file", 'probe.json', 'allowed');
  await tryImg('own-img', "an <img> from the site itself", 'pixel.svg', 'allowed');
  await tryFetch('same-origin', 'fetch() of a same-origin path outside the site', '/index.html', 'blocked');
  await tryFetch('other-site', 'fetch() of another stored site', '/site/bafybeib5gg45er6y7rgo2hgisx7bj4issekvfyhu52k3em52a2bb2khvxy/', 'blocked');
  await tryFetch('remote', 'fetch() of https://example.com', 'https://example.com/', 'blocked');
  await tryImg('remote-img', 'an <img> from https://example.com', 'https://example.com/favicon.ico', 'blocked');
  await tryImg('same-origin-img', 'an <img> from a same-origin path outside the site', '/style.css', 'blocked');
  try { const ws = new WebSocket('wss://example.com/'); await new Promise((r) => { ws.onerror = r; ws.onopen = r; setTimeout(r, 3000); });
        add('ws', 'WebSocket to wss://example.com', 'blocked', ws.readyState === 1 ? 'allowed' : 'blocked'); }
  catch (e) { add('ws', 'WebSocket to wss://example.com', 'blocked', 'blocked', String(e.message || e)); }
  // sendBeacon() returns true when it QUEUES the beacon; CSP blocks the send
  // afterwards. The evidence is a securitypolicyviolation event for that URL.
  {
    const url = 'https://example.com/beacon-probe';
    const violated = new Promise((r) => {
      const on = (ev) => { if (String(ev.blockedURI).startsWith('https://example.com')) { document.removeEventListener('securitypolicyviolation', on); r(ev.effectiveDirective); } };
      document.addEventListener('securitypolicyviolation', on);
      setTimeout(() => r(null), 2000);
    });
    let queued; try { queued = navigator.sendBeacon(url, 'x'); } catch (e) { queued = false; }
    const directive = await violated;
    add('beacon', 'navigator.sendBeacon to example.com', 'blocked', !queued || directive ? 'blocked' : 'allowed',
        directive ? 'CSP violation: ' + directive + ' (sendBeacon returned ' + queued + ')' : 'no CSP violation seen; returned ' + queued);
  }
  add('webrtc', 'RTCPeerConnection exists', 'blocked', typeof RTCPeerConnection === 'function' ? 'gap' : 'blocked',
      'CSP cannot block WebRTC. WKWebView also has it (iOS 14.3+), so M2 must disable or block it explicitly');
  parent.postMessage({ meshsitesProbe: results }, '*');
})();
`;

async function runProbe() {
  $('probe-out').innerHTML = '<p class="muted">Building the probe site…</p>';
  const built = await buildSiteCar([
    { path: 'index.html', content: enc.encode(`<!doctype html><meta charset="utf-8"><title>probe</title><p>MeshSites network probe</p><script>${PROBE_JS}</script>`) },
    { path: 'probe.json', content: enc.encode('{"ok":true}') },
    { path: 'pixel.svg', content: enc.encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') },
  ]);
  const root = built.root.toString();
  await putCar({ root, car: built.car, label: 'network probe', savedAt: Date.now() });
  const frame = $('probe-frame') as HTMLIFrameElement;
  const results = await new Promise<ProbeResult[]>((resolve) => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || !e.data?.meshsitesProbe) return;
      window.removeEventListener('message', on);
      resolve(e.data.meshsitesProbe);
    };
    window.addEventListener('message', on);
    frame.src = `/site/${root}/`;
  });
  await deleteCar(root);
  refreshList();
  const pass = (r: ProbeResult) => r.got === r.expect;
  const failures = results.filter((r) => r.got !== 'gap' && !pass(r)).length;
  // Results come from the probe site: render as text only, never as HTML.
  const out = $('probe-out');
  out.replaceChildren();
  const summary = document.createElement('p');
  summary.className = `badge ${failures ? 'bad' : 'ok'}`;
  summary.textContent = failures ? `${failures} check(s) failed` : 'All network checks behave as expected';
  const list = document.createElement('div');
  list.className = 'peers';
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'peer';
    const text = document.createElement('div');
    const what = document.createElement('div');
    what.textContent = String(r.what);
    const detail = document.createElement('div');
    detail.className = 'mono muted';
    detail.textContent = `expect ${r.expect}, got ${r.got}${r.detail ? ` · ${String(r.detail).slice(0, 120)}` : ''}`;
    text.append(what, detail);
    const badge = document.createElement('span');
    badge.className = `badge ${r.got === 'gap' ? 'warn' : pass(r) ? 'ok' : 'bad'}`;
    badge.textContent = r.got === 'gap' ? 'known gap' : pass(r) ? 'pass' : 'FAIL';
    row.append(text, badge);
    list.append(row);
  }
  out.append(summary, list);
  (window as unknown as { probeResults: ProbeResult[] }).probeResults = results;
}

async function main() {
  try {
    await registerSw();
  } catch (e) {
    $('site-head').innerHTML = `<p class="badge bad">${esc((e as Error).message)}</p>`;
    return;
  }
  $('file').onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) importFile(f);
  };
  $('probe').onclick = runProbe;
  window.onhashchange = show;
  await refreshList();
  await show();
}

main();
