# HANDOFF: MeshSites — IPFS websites over a Bluetooth mesh (bitchat fork)

> Build brief for Claude Code. Read this whole file before writing any code.
> Owner: Hector (@ensgianteth, GitHub org RWA-ID). Working name: **MeshSites**.

---

## 1. Goal

Let a phone with **no internet** open a static website pinned to IPFS (optionally addressed by an ENS name such as `example.eth`). The site comes from nearby phones over a Bluetooth LE mesh, with a fast local Wi-Fi link for bulk data. No step may trust the relaying peers: content is verified by its CID hash, and names are verified by signature.

The base is bitchat (https://github.com/permissionlesstech/bitchat, public domain). It already gives us a BLE mesh (up to 7 hops), peer discovery, Noise-encrypted sessions, a compact binary packet format and battery-adaptive duty cycling. We add a **content layer** on top of it. We do not replace the chat.

### Non-goals (MVP)
- Dynamic sites (APIs, RPC calls, server-side anything). Static HTML/CSS/JS/images only.
- Full IPFS/libp2p/Bitswap interoperability over the mesh. We use IPFS *formats* (CIDs, CAR), not the IPFS network stack, while offline.
- Payments. (Bitchat payment features are out of scope here.)
- Broadcasting site content across the mesh. Only small metadata is gossiped.

---

## 2. Step 0: research before coding (required)

1. Clone bitchat (`permissionlesstech/bitchat`, the Swift iOS/macOS app). This is the codebase we fork.
2. Read the whitepaper and the transport code. Write `docs/bitchat-notes.md` covering:
   - Packet format, header fields, max payload per BLE packet, and how fragmentation works
   - How TTL/hop count works and how relays deduplicate
   - Where new message types can be registered without breaking existing chat clients
   - Its LZ4 compression usage
3. Check whether a libp2p BLE / Multipeer transport (e.g. Berty's work) is reusable. **Unverified.** Confirm it exists and note its license before relying on it.
4. Write down your findings and any changes to this plan in `docs/decisions.md` before Milestone 1.

**Platform choice: iOS/macOS first (Swift).** Hector has no Android device. Bitchat's main app is Swift for iOS and macOS, so a Mac running the macOS build counts as a real mesh node alongside an iPhone.

iOS specifics to plan around:
- **Bulk transfer:** use **Multipeer Connectivity**, or Network.framework with `includePeerToPeer = true`. Both run over Bluetooth plus Apple's peer-to-peer Wi-Fi (AWDL) with no internet and no router, at Mbps speeds. Also check whether the Wi-Fi Aware framework (iOS 26+) is available and useful (**Unverified**).
- **Background limits:** iOS heavily restricts BLE advertising and scanning in the background, and Multipeer is effectively foreground-only. MVP assumption: the app is **in the foreground** on fetching and seeding devices. Document how bitchat handles background today, and what still works.
- **Renderer:** `WKWebView` with a `WKURLSchemeHandler` for `meshsite://`. Serve only verified blocks and block all network loads (`WKContentRuleList` + no remote fetches).
- **Crypto:** secp256k1 recovery for EIP-191 signatures through a maintained Swift package (e.g. a `swift-secp256k1` wrapper; confirm the package and its license), plus Keccak-256.
- **Build environment:** requires macOS + Xcode. The iOS Simulator has **no Bluetooth**, so mesh tests need real devices. A free Apple ID can install to Hector's own devices (the app expires after 7 days); a paid developer account allows TestFlight to more testers.

Keep the protocol code in a **standalone Swift package (`MeshSitesCore`)** with no UIKit/bitchat dependencies, so it is unit-testable on macOS and has shared JSON/hex test vectors that the TypeScript CLI must also pass.

---

## 3. Architecture

```
┌──────────────── Phone ────────────────┐
│  MeshSites browser (WebView)          │
│     ↑ serves verified files from      │
│  Local content store (CAR/blocks)     │
│     ↑                                 │
│  Content protocol (this project)      │
│   ├─ Gossip: ANNOUNCE / NAME_RECORD   │ ── over bitchat BLE mesh (small)
│   ├─ Query:  WANT / HAVE              │ ── over bitchat BLE mesh (small)
│   └─ Bulk:   block transfer           │ ── Multipeer / P2P Wi-Fi (fast), BLE fallback
│  bitchat transport (unchanged)        │
└───────────────────────────────────────┘
        Gateway node = any phone that is briefly online:
        resolves ENS, fetches CAR from IPFS gateway, pins it, seeds the mesh.
```

### Key design rules
- **Discovery is cheap and mesh-wide; bulk is direct and local.** Only `ANNOUNCE`, `WANT`, `HAVE` and `NAME_RECORD` travel multi-hop. Block bytes go peer-to-peer, preferably over Multipeer/peer-to-peer Wi-Fi with the nearest holder.
- **Verify everything.** Each block is hashed before storage. Nothing renders until the root CID's DAG is complete and verified.
- **Bounded resources.** Caps on site size, the cache and gossip rates. Default seeding is opt-in, with a battery threshold.

---

## 4. Data formats

### 4.1 Content
- Sites are packaged as **CARv1** files with a UnixFS DAG, using CIDv1, `sha2-256` and `dag-pb`/`raw` codecs.
- **Re-chunk to 16 KiB blocks** (`ipfs add --chunker=size-16384 --cid-version=1`, or the JS/Swift equivalent). The default 256 KiB chunks are too large for BLE. Note that re-chunking changes the root CID versus the default `ipfs add`. Gateways must re-chunk and record both CIDs (the original, as found on ENS, and the mesh CID).
- MVP limits: **≤ 1 MiB per site, ≤ 64 MiB total cache** (configurable).

### 4.2 Wire messages (new bitchat message types)
Encode them in bitchat's binary style (or CBOR inside a single new bitchat message type, whichever fits the codebase better; record the choice in `docs/decisions.md`). Fields:

| Type | Scope | Fields | Notes |
|---|---|---|---|
| `ANNOUNCE` | mesh, TTL ≤ 3 | `peerId`, `[rootCid, sizeBytes, blockCount]` (max 8 entries), `ts` | Rate limit: 1 per peer per 60 s |
| `NAME_RECORD` | mesh, TTL ≤ 7 | see 4.3 | Relayed only if valid and newer than the cached `seq` |
| `WANT` | mesh, TTL ≤ 5 | `reqId`, `rootCid` *or* `ensName` | Relays dedupe by `reqId` |
| `HAVE` | routed back to requester | `reqId`, `rootCid`, `peerId`, `hops`, `bulkCapable` (p2p-wifi/ble) | Requester picks the closest peer, preferring `bulkCapable` |
| `BLOCK_REQ` | direct session | `rootCid`, `[blockCid]` (batch ≤ 32) | |
| `BLOCK` | direct session | `blockCid`, `bytes` | The receiver MUST verify `hash(bytes) == blockCid` |

### 4.3 Signed ENS → CID record (offline name resolution)
The ENS owner (or the owner-approved key in a text record) signs:

```json
{
  "v": 1,
  "name": "example.eth",
  "cid": "bafy...",          // mesh (16 KiB re-chunked) root CID
  "origCid": "bafy...",      // contenthash CID as set on-chain
  "seq": 12,                 // monotonic; higher wins
  "ts": 1762470000,
  "signer": "0xOwnerOrDelegate"
}
```
- Signature: **EIP-191 `personal_sign`** over the canonical JSON (sorted keys, no whitespace). Verify with secp256k1 recovery on-device.
- **Trust anchor.** The device needs the `name → authorized signer` binding learned *while online*:
  - (a) on-chain ENS owner/manager, or
  - (b) an ENS text record `meshsites.signer` = delegate address (recommended, so owners don't need their cold wallet).
  - Online devices cache `{name, signer, fetchedAt, blockNumber}` in a **signer cache**.
- Offline verification: the signature is valid AND the signer matches the cached signer for that name. Otherwise show the site as **"Unverified name"**, still openable by raw CID with a clear warning.
- Gateways also re-broadcast `signer cache` entries as an `ATTESTATION` (signed by the gateway's key). Peers may accept these on a trust-on-first-use (TOFU) basis, which is shown in the UI. This is weaker than 4.3(a/b) and labelled as such.
- Stale data: show the record's `ts` in the UI.

---

## 5. Flows

**Open site by name (offline)**
1. User types `example.eth`.
2. Check the local name cache. On a miss, send `WANT{ensName}` and wait for a `NAME_RECORD`.
3. Verify the record (4.3). Get `cid`.
4. If the blocks are local, render. Otherwise send `WANT{rootCid}` and collect `HAVE`s for 3 s.
5. Pick the best peer: fewest hops, `bulkCapable` first. Open a Multipeer / peer-to-peer Wi-Fi session (fall back to direct BLE). Pull blocks in batches, verifying each one.
6. Once the DAG is complete, render it in a `WKWebView` served from a local verified store (custom scheme `meshsite://<cid>/path`). **No network access from the WebView.**

**Gateway (online) pinning**
1. Resolve the ENS contenthash through a public RPC. Fetch the content from an IPFS gateway as a CAR (or fetch and rebuild).
2. Re-chunk to 16 KiB and compute the mesh CID. Store it.
3. If the owner has published a signed `NAME_RECORD` (fetched from text record `meshsites.record` or an HTTP endpoint), cache and gossip it. Also cache the signer binding.
4. Start `ANNOUNCE`ing.

**Publisher tool (CLI, Node/TypeScript)**
`meshsites publish ./site --name example.eth` does the following: builds the CAR (16 KiB chunks), prints both CIDs, produces the `NAME_RECORD` JSON to sign, and optionally signs it with a local key or prints a payload for a wallet. It should also print the ENS text records to set (`meshsites.signer`, `meshsites.record`).

---

## 6. Repo layout (proposed)

```
meshsites/
  ios/                   # fork of bitchat (Swift, iOS + macOS) + MeshSites UI
  MeshSitesCore/         # Swift package: protocol, CAR, verification, records
  web/                   # Phase W browser testbed (TypeScript)
  protocol/              # platform-neutral spec + test vectors (JSON/hex)
    SPEC.md
    vectors/
  cli/                   # Node/TS publisher + gateway helpers
  docs/
    bitchat-notes.md
    decisions.md
  HANDOFF-meshsites.md   # this file
```
Keep the bitchat fork changes isolated (a new module/package) so we can rebase on upstream.

---

## 7. Milestones & acceptance criteria

**M0: Research** (Section 2). Deliverables: `docs/bitchat-notes.md`, `docs/decisions.md`.

**M1: Publisher CLI.**
- `publish` produces a CAR with 16 KiB blocks; `verify` re-hashes every block.
- `sign-record` / `verify-record` round-trips against test vectors in `protocol/vectors/`.
- Unit tests: tampered block fails; tampered record fails; lower `seq` is rejected.

**Phase W: Web testbed (optional but recommended, runs in parallel with M2).**
- TypeScript protocol package shared with the CLI, using the same test vectors.
- Mesh simulator: browser tabs/devices connected over WebRTC behind a fake transport that mimics BLE (low bandwidth, loss, per-hop delay, TTL ≤ 7). Visualise "A → B → C" and the transfer timing.
- Service-worker viewer that serves a site from a verified local CAR.
- Note: Web Bluetooth can't advertise or relay and isn't supported on iOS, so this is a simulator, not a real mesh.

**M2: Local store + offline renderer (iOS/macOS, no mesh yet).**
- `MeshSitesCore` passes all test vectors on macOS (`swift test`).
- Import a CAR (Files app / AirDrop) and open it in `WKWebView` via `meshsite://`.
- The WebView cannot make any network request (test this explicitly).

**M3: Mesh discovery.**
- `ANNOUNCE` / `WANT` / `HAVE` / `NAME_RECORD` as new message types. Existing bitchat chat keeps working between patched and unpatched clients (unknown types are ignored or relayed per bitchat's rules; confirm this in M0).
- Rate limits and TTL caps enforced. Tests for dedupe.

**M4: Block transfer.**
- BLE direct transfer works end to end for a 100 KB site between 2 devices (iPhone ↔ Mac is fine).
- Multipeer / peer-to-peer Wi-Fi bulk path works for a 1 MB site. Record timings in `docs/benchmarks.md` for 1, 2 and 3 hops (BLE) and the direct peer-to-peer link.
- Corrupted block is rejected and re-requested from another peer.

**M5: Names + gateway mode.**
- Online device resolves `*.eth`, pins it, caches the signer, and seeds.
- Offline device opens the site by name with a "Verified" badge, or "Unverified/TOFU" with a warning when the signer is unknown.

**M6: Hardening.**
- Battery threshold for seeding (default: seed only if > 30% or charging).
- Cache eviction (LRU, user pins exempt).
- Settings screen: seeding on/off, cache size, list of stored sites.

**Demo definition of done:** three Apple devices (e.g. iPhone + Mac + iPad or a second iPhone/Mac) with internet off and Bluetooth and Wi-Fi radios on, app in the foreground. Device A was online earlier and pinned `example.eth`. Device C, two hops from A (out of A's direct range, or with A blocked from C in a debug setting), opens `example.eth` and renders it verified, with no internet at any point on C. Minimum dev setup is 2 devices (iPhone + Mac); add the debug "forced relay" setting so 3-hop behaviour can be tested with fewer devices.

---

## 8. Security & privacy checklist
- [ ] Every block is hash-verified before being written to the store
- [ ] Rendering only after the full DAG is verified; size caps enforced *before* download
- [ ] WebView: no network, no file:// access outside the store, JS allowed but sandboxed
- [ ] `NAME_RECORD`: canonical JSON, signature check, signer binding, highest `seq` wins, replay of an old `seq` is rejected
- [ ] Rate limits on all gossip types; drop peers that spam
- [ ] `WANT` reveals what a user is browsing to nearby peers. Document this clearly in the UI and consider an option to only fetch already-announced CIDs
- [ ] Don't weaken bitchat's existing Noise sessions; the bulk Multipeer / peer-to-peer channel must be authenticated to the same peer identity (bind with the Noise session key; don't rely on Multipeer's own encryption alone)

---

## 9. Working agreement for Claude Code
- Take one milestone at a time. Finish its tests before starting the next.
- Ask Hector before: changing the wire format after M3, adding a dependency with a non-permissive license, or touching bitchat's core chat/crypto code.
- Facts in this brief marked **Unverified** must be confirmed from source and noted in `docs/decisions.md`.
- Commit messages: conventional commits (`feat(protocol): ...`).
