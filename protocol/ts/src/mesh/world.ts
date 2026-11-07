/** An in-memory mesh: nodes, BLE/bulk links, one shared scheduler. */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BitchatRadio, BLE_PROFILE, BULK_PROFILE, type LinkProfile, ShapedLink } from './radio.ts';
import { MeshSitesNode, type NodeOptions } from './node.ts';
import { rng, type Scheduler } from './scheduler.ts';

export interface WorldNode {
  name: string;
  radio: BitchatRadio;
  /** Undefined for an unpatched (old bitchat) node. */
  node?: MeshSitesNode;
}

export function peerIdFor(name: string) {
  return bytesToHex(sha256(new TextEncoder().encode(`peer:${name}`)).subarray(0, 8));
}

export class SimWorld {
  readonly nodes = new Map<string, WorldNode>();
  readonly rand: () => number;
  readonly sched: Scheduler;
  constructor(sched: Scheduler, seed = 1) {
    this.sched = sched;
    this.rand = rng(seed);
  }

  add(name: string, opts: { patched?: boolean } & Partial<NodeOptions> = {}): WorldNode {
    const radio = new BitchatRadio(peerIdFor(name), name, this.sched, this.rand, opts.patched ?? true);
    const wn: WorldNode = { name, radio };
    if (opts.patched ?? true) wn.node = new MeshSitesNode(radio, this.sched, this.rand, opts);
    this.nodes.set(name, wn);
    return wn;
  }

  get(name: string) {
    const n = this.nodes.get(name);
    if (!n) throw new Error(`no node ${name}`);
    return n;
  }

  byPeer(peerId: string) {
    for (const n of this.nodes.values()) if (n.radio.peerId === peerId) return n;
    return undefined;
  }

  /** Connect two nodes over BLE (and optionally peer-to-peer Wi-Fi). */
  link(a: string, b: string, opts: { ble?: Partial<LinkProfile> | false; bulk?: Partial<LinkProfile> | boolean } = {}) {
    const A = this.get(a);
    const B = this.get(b);
    const pair = (profile: LinkProfile) => {
      A.radio.attach(B.radio.peerId, profile.kind, new ShapedLink(A.radio.peerId, B.radio.peerId, profile, this.sched, this.rand, (f) => B.radio.receiveFrame(A.radio.peerId, f)));
      B.radio.attach(A.radio.peerId, profile.kind, new ShapedLink(B.radio.peerId, A.radio.peerId, profile, this.sched, this.rand, (f) => A.radio.receiveFrame(B.radio.peerId, f)));
    };
    if (opts.ble !== false) pair({ ...BLE_PROFILE, ...(opts.ble || {}) });
    if (opts.bulk) pair({ ...BULK_PROFILE, ...(typeof opts.bulk === 'object' ? opts.bulk : {}) });
  }

  unlink(a: string, b: string) {
    const A = this.get(a);
    const B = this.get(b);
    A.radio.detach(B.radio.peerId);
    B.radio.detach(A.radio.peerId);
  }

  /** Build a line A–B–C… */
  static chain(sched: Scheduler, names: string[], seed = 1) {
    const w = new SimWorld(sched, seed);
    for (const n of names) w.add(n);
    for (let i = 1; i < names.length; i++) w.link(names[i - 1], names[i]);
    return w;
  }
}
