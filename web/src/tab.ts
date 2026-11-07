/**
 * Multi-tab mode: this tab is ONE mesh node. Tabs (or devices on the LAN)
 * find each other through the dev server's signalling relay, then talk
 * peer-to-peer over WebRTC data channels. BLE behaviour (fragment pacing,
 * loss, relay jitter, TTL) is imposed in software on top of each channel.
 * No ICE servers are configured: links use local host candidates only.
 */
import { esc } from './esc.ts';
import { CID } from 'multiformats/cid';
import { orderedBlocks, writeCar, type SignedNameRecord } from '@meshsites/protocol';
import {
  BitchatRadio,
  BLE_PROFILE,
  BULK_PROFILE,
  MeshSitesNode,
  peerIdFor,
  RealScheduler,
  rng,
  ShapedLink,
  type LinkKind,
  type SimPacket,
} from '@meshsites/protocol/mesh';
import { putCar } from './store.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const params = new URLSearchParams(location.search);
const myName = (params.get('name') ?? `N${Math.floor(Math.random() * 900 + 100)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'N';
const room = (params.get('room') ?? 'demo').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'demo';
const myId = peerIdFor(`${myName}:${Math.random()}`);

const sched = new RealScheduler(1);
const rand = rng(Date.now() & 0xffff);
const radio = new BitchatRadio(myId, myName, sched, rand, true);
const node = new MeshSitesNode(radio, sched, rand);

interface Peer {
  id: string;
  name: string;
  pc?: RTCPeerConnection;
  ble?: RTCDataChannel;
  bulk?: RTCDataChannel;
  bulkOn: boolean;
  state: string;
}
const peers = new Map<string, Peer>();

function log(msg: string, cls = '') {
  const box = $('log');
  const line = document.createElement('div');
  line.className = `line ${cls}`;
  line.innerHTML = `<span class="t">${(sched.now() / 1000).toFixed(2)}s</span> `;
  line.append(document.createTextNode(msg));
  box.append(line);
  while (box.childElementCount > 400) box.firstElementChild!.remove();
  box.scrollTop = box.scrollHeight;
}

const nameOf = (id: string) => (id === myId ? myName : (peers.get(id)?.name ?? id.slice(0, 6)));

radio.listeners.push((e) => {
  if (e.kind === 'tx') log(`→ ${nameOf(e.to)} ${e.label} ${e.bytes} B${e.link === 'bulk' ? ' (Wi-Fi)' : ''}${e.lost ? ' LOST' : ''}`, e.lost ? 'warn' : '');
  if (e.kind === 'relay') log(`relay ${e.label} ttl→${e.ttl}`);
  if (e.kind === 'drop') log(`drop ${e.label}: ${e.reason}`, 'warn');
});
node.listeners.push((e) => {
  if (e.kind === 'log') log(e.msg, /REJECT/.test(e.msg) ? 'bad' : '');
  if (e.kind === 'progress') $('progress-label').textContent = `${e.blocks}${e.expectedBlocks ? ` / ${e.expectedBlocks}` : ''} blocks · ${(e.bytes / 1024).toFixed(1)} KiB`;
  if (e.kind === 'site' || e.kind === 'name') renderState();
});

// ---------- frames over data channels ----------

function encodeFrame(frame: unknown): string {
  const f = frame as SimPacket & { direct?: boolean; from?: string };
  if (f.direct) return JSON.stringify({ k: 'direct', payload: b64(f.payload) });
  return JSON.stringify({ k: 'pkt', p: { ...f, payload: b64(f.payload) } });
}

function decodeFrame(s: string): unknown {
  const m = JSON.parse(s);
  if (m.k === 'direct') return { direct: true, payload: unb64(m.payload) };
  if (m.k === 'pkt') return { ...m.p, payload: unb64(m.p.payload) };
  return undefined;
}

function attachChannel(p: Peer, kind: LinkKind, dc: RTCDataChannel) {
  p[kind] = dc;
  dc.onopen = () => {
    const loss = Number(($('loss') as HTMLInputElement).value) / 100;
    if (kind === 'ble') {
      radio.attach(p.id, 'ble', new ShapedLink(myId, p.id, { ...BLE_PROFILE, loss }, sched, rand, (f) => dc.readyState === 'open' && dc.send(encodeFrame(f))));
      log(`BLE link up with ${p.name}`, 'good');
    } else if (p.bulkOn) {
      attachBulk(p);
    }
    renderPeers();
  };
  dc.onclose = () => {
    radio.detach(p.id, kind);
    if (kind === 'ble') log(`link with ${p.name} closed`, 'warn');
    renderPeers();
  };
  dc.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.k === 'ctl') {
      if (m.bulk !== undefined) {
        p.bulkOn = m.bulk;
        p.bulkOn ? attachBulk(p) : radio.detach(p.id, 'bulk');
        renderPeers();
      }
      return;
    }
    const f = decodeFrame(e.data);
    if (f) radio.receiveFrame(p.id, f);
  };
}

function attachBulk(p: Peer) {
  const dc = p.bulk;
  if (!dc || dc.readyState !== 'open') return;
  radio.attach(p.id, 'bulk', new ShapedLink(myId, p.id, BULK_PROFILE, sched, rand, (f) => dc.readyState === 'open' && dc.send(encodeFrame(f))));
  log(`peer-to-peer Wi-Fi (simulated) with ${p.name}`, 'good');
}

// ---------- signalling ----------

async function signal(to: string, data: unknown) {
  await fetch('/signal/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, from: myId, to, data }) });
}

function newPc(p: Peer) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  p.pc = pc;
  pc.onicecandidate = (e) => e.candidate && signal(p.id, { candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    p.state = pc.connectionState;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      radio.detach(p.id);
      p.pc = undefined;
    }
    renderPeers();
  };
  pc.ondatachannel = (e) => attachChannel(p, e.channel.label as LinkKind, e.channel);
  return pc;
}

async function link(p: Peer) {
  const pc = newPc(p);
  attachChannel(p, 'ble', pc.createDataChannel('ble'));
  attachChannel(p, 'bulk', pc.createDataChannel('bulk'));
  await pc.setLocalDescription(await pc.createOffer());
  await signal(p.id, { sdp: pc.localDescription });
  p.state = 'connecting';
  renderPeers();
}

function unlink(p: Peer) {
  p.pc?.close();
  p.pc = undefined;
  radio.detach(p.id);
  p.state = 'idle';
  renderPeers();
}

async function onSignal(from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
  const p = peers.get(from);
  if (!p) return;
  if (data.sdp?.type === 'offer') {
    if (p.pc && p.pc.signalingState === 'have-local-offer') {
      if (myId < from) return; // glare: lower ID keeps its offer
      p.pc.close();
    }
    const pc = newPc(p);
    await pc.setRemoteDescription(data.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    await signal(from, { sdp: pc.localDescription });
  } else if (data.sdp?.type === 'answer') {
    await p.pc?.setRemoteDescription(data.sdp);
  } else if (data.candidate) {
    try {
      await p.pc?.addIceCandidate(data.candidate);
    } catch {
      /* late candidate after close */
    }
  }
}

function connectSignalling() {
  const es = new EventSource(`/signal/events?room=${room}&peer=${myId}&name=${encodeURIComponent(myName)}`);
  es.addEventListener('hello', (e) => {
    const { peer, name } = JSON.parse((e as MessageEvent).data);
    if (!peers.has(peer)) peers.set(peer, { id: peer, name, bulkOn: false, state: 'idle' });
    log(`${name} joined room ${room}`);
    renderPeers();
  });
  es.addEventListener('bye', (e) => {
    const { peer } = JSON.parse((e as MessageEvent).data);
    const p = peers.get(peer);
    if (p) {
      unlink(p);
      peers.delete(peer);
      log(`${p.name} left`);
      renderPeers();
    }
  });
  es.addEventListener('msg', (e) => {
    const { from, data } = JSON.parse((e as MessageEvent).data);
    onSignal(from, data);
  });
  es.onerror = () => log('signalling connection lost; retrying…', 'warn');
}

// ---------- UI ----------

function renderPeers() {
  const box = $('peers');
  box.replaceChildren();
  if (!peers.size) box.innerHTML = `<p class="muted">No other tabs in room “${esc(room)}” yet. Open this page in another tab or device.</p>`;
  for (const p of peers.values()) {
    const row = document.createElement('div');
    row.className = 'peer';
    const linked = !!radio.links.get(p.id)?.ble;
    const blocked = radio.blocked.has(p.id);
    row.innerHTML = `<div><span class="who"></span> <span class="muted mono"></span></div><div class="row"></div>`;
    row.querySelector('.who')!.textContent = p.name;
    row.querySelector('.mono')!.textContent = linked ? `linked${p.bulkOn ? ' + Wi-Fi' : ''}${blocked ? ' · BLOCKED' : ''}` : p.state;
    const actions = row.querySelector('.row')!;
    const btn = (label: string, fn: () => void, primary = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.onclick = fn;
      actions.append(b);
    };
    if (!p.pc) btn('Link (BLE)', () => link(p), true);
    else {
      btn(p.bulkOn ? 'Wi-Fi off' : '+ Wi-Fi', () => {
        p.bulkOn = !p.bulkOn;
        p.ble?.readyState === 'open' && p.ble.send(JSON.stringify({ k: 'ctl', bulk: p.bulkOn }));
        p.bulkOn ? attachBulk(p) : radio.detach(p.id, 'bulk');
        renderPeers();
      });
      btn(blocked ? 'Unblock' : 'Block (debug)', () => {
        blocked ? radio.blocked.delete(p.id) : radio.blocked.add(p.id);
        renderPeers();
      });
      btn('Unlink', () => unlink(p));
    }
    box.append(row);
  }
}

function renderState() {
  const sites = [...node.sites.values()].filter((s) => s.complete);
  const names = [...node.names.entries()];
  $('state').innerHTML = `<dl><dt>Peer ID</dt><dd class="mono">${esc(myId)}</dd><dt>Sites</dt><dd class="mono">${sites.map((s) => esc(`${s.root.toString().slice(0, 16)}… (${s.blockCount} blocks)`)).join('<br>') || '-'}</dd><dt>Names</dt><dd>${esc(names.map(([n, r]) => `${n} (${r.status})`).join(', ') || '-')}</dd><dt>Trusted signers</dt><dd>${esc([...node.signers.keys()].join(', ') || '-')}</dd></dl>`;
}

let records: { cases: { id: string; input: SignedNameRecord }[]; testKeys: { address: string }[] };

async function loadGateway() {
  const [car, rec] = await Promise.all([fetch('vectors/site-basic.car').then((r) => r.arrayBuffer()), fetch('vectors/records.json').then((r) => r.json())]);
  records = rec;
  await node.importCar(new Uint8Array(car));
  node.trust('example.eth', records.testKeys[0].address);
  node.addRecord(records.cases.find((c) => c.id === 'valid-verified')!.input);
  log('gateway: pinned example.eth (site-basic), cached its signer and signed record', 'good');
  renderState();
}

async function trustSigner() {
  records ??= await fetch('vectors/records.json').then((r) => r.json());
  node.trust('example.eth', records.testKeys[0].address);
  log('trusting the test signer for example.eth (as if learned online)');
  renderState();
}

async function open() {
  const target = ($('target') as HTMLInputElement).value.trim();
  const btn = $('open') as HTMLButtonElement;
  btn.disabled = true;
  $('result').innerHTML = '<p class="muted">Fetching…</p>';
  try {
    const r = await node.open(target);
    const s = r.stats;
    const badge = r.status === 'verified' ? '<span class="badge ok">Verified name</span>' : r.status === 'unverified' ? '<span class="badge warn">Unverified name</span>' : '<span class="badge neutral">Raw CID</span>';
    $('result').innerHTML = `${badge}<dl><dt>Total</dt><dd>${s.local ? 'already local' : `${(s.ms / 1000).toFixed(2)} s`}</dd><dt>From</dt><dd>${esc(s.sources.map((x) => `${nameOf(x.peer)} (${x.hops} hop${x.hops > 1 ? 's' : ''}, ${x.via === 'bulk' ? 'Wi-Fi' : 'BLE'})`).join(' → ') || '-')}</dd><dt>Blocks</dt><dd>${s.blocks} · ${(s.bytes / 1024).toFixed(1)} KiB</dd><dt>Rejected</dt><dd>${s.corruptRejected}</dd></dl>`;
    const root = CID.parse(r.root);
    await putCar({ root: r.root, car: await writeCar([root], orderedBlocks(root, node)), label: r.name ?? 'site', savedAt: Date.now() });
    const a = document.createElement('a');
    a.className = 'button primary';
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = `viewer.html#${r.root}${r.name ? `?name=${encodeURIComponent(r.name)}&status=${r.status}` : ''}`;
    a.textContent = 'View the site offline →';
    $('result').append(a);
  } catch (e) {
    $('result').innerHTML = `<p class="badge bad">Failed</p><p></p>`;
    $('result').querySelector('p:last-child')!.textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
    renderState();
  }
}

$('me').textContent = `${myName} · room ${room}`;
$('gateway').onclick = loadGateway;
$('trust').onclick = trustSigner;
$('open').onclick = open;
$('loss').oninput = () => ($('loss-v').textContent = `${($('loss') as HTMLInputElement).value}%`);
$('rename').onclick = () => {
  const n = prompt('Node name', myName);
  if (n) location.search = `?name=${encodeURIComponent(n)}&room=${room}`;
};
renderPeers();
renderState();
connectSignalling();
