# Web testbed (Phase W)

A simulator, not a real mesh: Web Bluetooth can't advertise or relay and isn't on iOS. Everything here runs the same `@meshsites/protocol` code as the CLI and the tests.

```sh
npm install
npm run web          # http://localhost:5173/  (rebuilds on change)
node web/server.ts --lan   # also listen on the LAN
```

| Page | What it does |
|---|---|
| `index.html` | **About page.** What MeshSites is, why, how to use and publish, what works today. Static, no scripts. |
| `simulator.html` | **Simulator.** All nodes in one page, in-memory links with bitchat-like BLE pacing. Scenarios: 2 hops, unknown signer, old bitchat client in the middle, a lying peer, a peer-to-peer Wi-Fi neighbour, 3×3 grid, forced relay. Packets are animated per hop, with timings. |
| `tab.html?name=A` | **Multi-tab.** Each tab is one node, linked to chosen tabs over WebRTC data channels (signalling through this server, no ICE servers). BLE pacing and loss are applied in software. |
| `viewer.html` | **Offline viewer.** Renders a stored site at `/site/<cid>/` through a service worker that re-verifies the CAR. Includes a **no-network probe**. |

## Static build (meshsites.eth)

```sh
npm run build:static   # → web/out/ (~584 KiB), prints its CIDv1
```

`web/out/` is pin-ready: simulator + viewer, minified, with `sw.js` at the root and the demo vectors. The multi-tab page is left out (it needs the signalling server). Serve it from the **root of an origin**, e.g. `https://meshsites.eth.limo/`. On a path gateway (`…/ipfs/<cid>/`) the simulator works, but the viewer can't register `/sw.js` and says so.

The printed CID matches `ipfs add -r --cid-version=1 web/out` (checked with Kubo 0.43.1). If your pinning service chunks differently, the CID it returns is the one to put in the contenthash.

## Viewer security model (testbed)

- The service worker is the trust boundary. It re-reads the CAR from IndexedDB and serves only after `readCar` + `verifyDag` pass.
- Site responses carry a CSP whose sources are **only** `<origin>/site/<cid>/`. A site can load its own files but not other paths on the origin, other sites or the internet. The service worker returns 403 for anything else a site page requests (a second layer).
- **Known gaps, testbed only:**
  - WebRTC isn't blockable by CSP. The probe reports it as a known gap.
  - Sites share the testbed's origin, so a site's JS could read the testbed's IndexedDB. Sandboxed (opaque-origin) iframes aren't controlled by service workers, so we can't isolate that way here.
  - The iOS app avoids both: `WKWebView` with a per-site custom scheme origin and `WKContentRuleList`.
- Service workers need a secure context: `localhost` works. For phones on the LAN over plain HTTP, the simulator and multi-tab pages work but the viewer doesn't.

## Not modelled

Ed25519 packet signatures, Noise encryption (direct-session payloads travel in clear in the sim), source routing, gossip sync, half-duplex radios (see `docs/benchmarks.md`).
