# Decisions and changes to the plan (M0)

Status: **draft for Hector's review** (2026-11-06). Items marked **ASK** need a decision before the milestone that uses them.
Evidence for every claim about bitchat is in `docs/bitchat-notes.md`.

## D1. Corrections to the brief

| Brief says | Source says | Effect |
|---|---|---|
| bitchat uses LZ4 | zlib / raw DEFLATE (`CompressionUtil.swift`), automatic above 256 B | None for the design. CIDs are over uncompressed bytes. |
| Unknown types are "ignored or relayed per bitchat's rules" | Confirmed: unknown outer types are logged, deduped and **relayed as broadcast**; not shown, not synced | Gossip crosses unpatched nodes. Our TTL caps must be set by the originator. |
| Payload per BLE packet | 469 B fragments, 25 ms directed spacing → ~18 KB/s/hop ceiling | 1 MiB over BLE ≈ 1 min+ per hop. Bulk Wi-Fi is required for the 1 MB target. |
| Unknown types fit any size | Receivers cap unknown types at **128 KiB** decoded | Every gossip message must stay well under that (they do, < 2 KiB). |

## D2. Verified "Unverified" items

- **Berty BLE / Multipeer drivers:** exist in `berty/weshnet` (`pkg/ble-driver`, `pkg/multipeer-connectivity-driver`, `pkg/proximitytransport`), **MIT OR Apache-2.0**. They are libp2p transports behind a Go/cgo bridge. **Decision: reference only, not a dependency** (libp2p is a non-goal, and a Go runtime is too heavy).
- **Wi-Fi Aware (iOS 26):** real (`WiFiAware` framework), **iOS/iPadOS 26+ only, no native macOS**, and devices must be **paired first** through DeviceDiscoveryUI or AccessorySetupKit (a PIN flow, reportedly iPhone 12+). **Decision: not used in the MVP**: it can't do ad hoc discovery between strangers, and the Mac can't be a node. Revisit as an optional faster link between paired devices.
- **secp256k1 for Swift:** `21-DOT-DEV/swift-secp256k1` is **MIT**, active, and **already a bitchat dependency** (0.24.0, product `P256K`), with a `Recovery` module. **Decision: use it** in `MeshSitesCore`, pinned to the same version as bitchat.
- **Keccak-256:** not in bitchat. **Decision: implement Keccak-256 in `MeshSitesCore`** (~100 lines, no dependency) and check it against known vectors (`keccak256("")`, EIP-191 examples, viem output). Alternative if Hector prefers a package: CryptoSwift (permissive license, but a large dependency).

## D3. Build environment (blocker for M2+)

- This Mac has **Command Line Tools only** (Swift 6.2.3). `swift build` works, `swift test` does **not** (no XCTest, no swift-testing). Verified.
- **ASK: install full Xcode** (Mac App Store, ~15 GB download, more unpacked; slow on this HDD). It is needed for `swift test` (M2 acceptance), WKWebView/iOS builds, and installing to the iPhone.
- Until then: M1 (Node CLI) needs nothing new, and `MeshSitesCore` can be written and built, with vectors checked by a small `swift run` checker executable as a stopgap.

## D4. Wire format: one new outer type + sub-type byte, binary TLV (not CBOR)

- **One** new bitchat `MessageType`, `meshSites = 0x4D` ("M"), carrying a 1-byte sub-type and TLV fields. Rationale: one value to claim upstream, it sits far from upstream's forward allocation (0x29 → 0x2C), and 0x05 / 0x2A / 0x2B are avoided per the `MessageType.swift` comments. **ASK:** OK to use 0x4D, and should we ask bitchat upstream to reserve it?
- **Binary TLV** (`type u8 | len u16 | value`), matching bitchat's own announce/file TLVs. CBOR would add a dependency on both platforms for no gain. Unknown TLV tags are skipped, so fields can be added without a version bump.
- Payload header: `version u8 (=1) | subtype u8 | TLVs…`

| Sub | Message | Outer packet | TTL set by originator | Signed by |
|---|---|---|---|---|
| 0x01 | ANNOUNCE | broadcast | 3 | bitchat Ed25519 packet signature |
| 0x02 | NAME_RECORD | broadcast | 7 | EIP-191 inside (self-authenticating); packet unsigned |
| 0x03 | WANT | broadcast | 5 | packet signature (so rate limits key on a real peer) |
| 0x04 | HAVE | recipient = requester; v2 source route when the topology map has a path, else broadcast | ≤ 5 | packet signature |
| 0x05 | ATTESTATION | broadcast | 7 | gateway's bitchat Ed25519 key (TOFU per gateway fingerprint) |
| — | BLOCK_REQ / BLOCK | see D6 | — | Noise session |

- TTL semantics: bitchat relays while `ttl > 1`, so **TTL = N reaches N hops**. Old relays don't know our caps, so the originator's TTL *is* the cap. Patched relays drop (and count as spam) any packet arriving with TTL above the cap.
- `WANT` carries `origTtl` so a responder computes `hops = origTtl - ttl + 1` for `HAVE`.
- Dedupe: bitchat's seen-set already dedupes our packets by sender/timestamp/type/payload digest (1000 entries, 5 min). We add our own `reqId` (8 random bytes) dedupe for `WANT`, plus `(name, seq)` for `NAME_RECORD`.
- Known limit: in dense graphs (≥ 6 links), broadcast relays use ~log2(degree) fanout, so a `WANT` may not reach every node. Acceptable for the MVP (requesters retry). Noted for M3 tests.
- Canonical JSON for NAME_RECORD: keys sorted by byte order, no whitespace, integers only (no floats), strings ASCII after ENSIP-15 normalisation of `name`. EIP-191 message = `"\x19Ethereum Signed Message:\n" + decimal(len(json)) + json`. The wire carries the exact JSON bytes plus the 65-byte signature, never a re-serialisation.

## D5. Content format

- CARv1, UnixFS, CIDv1, sha2-256, **raw leaves**, fixed 16 KiB chunker. TS side: `@ipld/car`, `ipfs-unixfs-importer`, `multiformats` (all MIT OR Apache-2.0). **Check `@ipld/dag-pb` / importer defaults (rawLeaves, cidVersion, maxChildrenPerNode=174) and pin them explicitly in the CLI** so the mesh CID is reproducible. Recorded in the vectors.
- Swift side: no maintained Swift CAR/UnixFS library is known, so `MeshSitesCore` gets a minimal CARv1 reader, CID/multihash parser, and a dag-pb decoder (protobuf subset). Read-only: Swift never builds DAGs (gateways that re-chunk on-device are an M5 question).
- Block size cap on receive: reject any block > 32 KiB (16 KiB data + generous dag-pb overhead). Site cap 1 MiB, cache 64 MiB, checked **before** download via `ANNOUNCE.sizeBytes` / `blockCount`, and enforced again while receiving.

## D6. Block transfer paths

1. **Bulk (preferred): Network.framework, `includePeerToPeer = true`**, Bonjour service `_meshsites._tcp` over AWDL (no router). Chosen over Multipeer Connectivity because Apple steers new work to Network.framework, it runs on both iOS and macOS, and we control framing.
   - **Authentication (security checklist):** the TCP link is bound to the bitchat Noise session. Keys = HKDF(Noise handshake hash, "meshsites-bulk-v1"); every frame is ChaCha20-Poly1305 with those keys, and the first frame proves possession. Multipeer/AWDL encryption is not relied on. bitchat already exposes the handshake hash (`getHandshakeHash`).
   - Needs `NSLocalNetworkUsageDescription` and `NSBonjourServices` in Info.plist (a local-network permission prompt).
   - Bulk is single-hop only (nearest holder). A device that isn't adjacent to a holder pulls over BLE or waits until a closer peer has cached the site.
2. **BLE fallback: directed `noiseEncrypted`** with new **inner** payload types `meshBlockReq` / `meshBlock`. Directed Noise traffic already relays deterministically multi-hop, is padded and authenticated, and relays can't see the inner type, so unpatched relays are fine. **Never** a broadcast packet (its fragments would flood the mesh).
   - **ASK (working agreement: touching core):** this needs (a) two new `NoisePayloadType` cases and (b) a dispatch hook in `BLENoisePacketHandler` that hands them to our module. About 20 lines in core files, with no change to Noise itself. Alternative without touching Noise: a directed outer `meshSites` sub-type over a source route, which is unencrypted and not deterministic through old relays. I recommend the Noise path.

## D7. Names and trust anchors

- **ENSv2 is live (2026-10-27).** The "on-chain owner/manager" anchor (4.3a) is now version-dependent (v1 registry/NameWrapper vs v2 registry), so the gateway resolves via the **Universal Resolver** for contenthash and text records. **Recommended anchor stays (b), the `meshsites.signer` text record**, which works the same on v1 and v2. (a) is implemented second.
- Gateways must check that a name hasn't expired before caching a signer: an expired ENS name can still resolve.
- Signer cache entry: `{name, signer, source: "text"|"owner"|"attestation", fetchedAt, blockNumber}`. The UI shows source and age.

## D8. Repo and process

- Repo at `~/meshsites` (git initialised, nothing pushed). The bitchat reference clone is at `~/meshsites-ref/bitchat`, outside the repo. The fork itself goes into `ios/` at M2. **ASK:** create `RWA-ID/meshsites` on GitHub, public or private? Commits signed per the usual SSH key.
- TS: one `protocol/ts` package shared by `cli/` and `web/`. Vectors in `protocol/vectors/*.json` are the contract both languages must pass.
- M1 done 2026-11-06: CLI + vectors + 56 tests. Answered: 0x4D approved; repo starts private (RWA-ID/meshsites).

## D9. Phase W outcomes (2026-11-06, draft wire format, still changeable before M3)

- **Direct-session messages use one NoisePayloadType, `0x4D`**, with the same `version | subtype | TLV` encoding as the outer `0x4D` gossip. Sub-types `0x01-0x0F` are public gossip only and `0x10-0x1F` are direct only; a receiver rejects either kind in the wrong context. Vectors: `protocol/vectors/wire.json`.
- **HAVE carries `sizeBytes` and `blockCount`**, so the requester enforces the 1 MiB cap *before* downloading (security checklist item 2).
- **CIDs travel as binary CID bytes**, not strings (36 vs 59 bytes). Every gossip message is ≤ 72 bytes, so one BLE frame each.
- **Expansion cap (4 MiB)** added to verification after the dedupe-bomb finding (SPEC §2.2 step 9).
- **Open questions found by the simulator, for M3/M4:**
  1. The fixed 3 s HAVE window is most of the time for small sites. Proposal: start pulling on the first adjacent bulk-capable HAVE.
  2. With per-fragment loss, 16 KiB blocks over BLE are fragile (35 fragments each). We need per-block retry or smaller BLE batches.
  3. Real relays are half-duplex, so multi-hop BLE is slower than simulated (`docs/benchmarks.md`).

## D10. MeshSitesCore (Swift), 2026-11-06

- **secp256k1 through the C library.** `P256K.Recovery.PublicKey` (0.24.0) calls `fatalError("secp256k1_ecdsa_recover failed…")` when recovery fails. Recovery does fail on well-formed signatures whose `r` isn't a curve x-coordinate (about half of random `r`), so one forged NAME_RECORD would crash every phone that receives it. MeshSitesCore links `libsecp256k1` (same package, same version) and treats every C failure as `bad-signature`. A shared vector (`unrecoverable-r`) and `meshsites-vectors --fuzz` (5,000 runs: 2,474 failed recoveries, 0 crashes) guard it. bitchat itself only uses P256K Schnorr/KeyAgreement, not Recovery. **ASK:** report the fatalError upstream?
- **ENSIP-15 is approximated in Swift.** The TS side uses `@adraffy/ens-normalize`. Swift checks NFC, lowercase, non-empty labels, ASCII `[a-z0-9_-]` with leading-only `_`, no `--` at positions 3-4, and no whitespace/control/format characters. Not covered: UTS-46 mapping, emoji sequences, confusables. Impact: Swift may accept a record name TS rejects. It can't impersonate a cached name, because trust is keyed by the exact string (signer cache). Revisit before a public release (port ens-normalize's tables, or have gateways only cache TS-normalised names).
- **Matching TS edge behaviour on purpose:** JSON numbers like `12.0`/`1.2e1` are integers (JS semantics), duplicate keys keep the last value, protobuf varints may be non-minimal (as @ipld/dag-pb), and a missing UnixFS Type means `file` (as ipfs-unixfs). Swift is **stricter** in a few places that can only affect crafted input: multiformats varints must be minimal, unknown UnixFS type values are errors, and lone `\u` surrogates fail at parse time rather than at canonicalisation.
- 81 vector checks pass, including the real `meshsites.eth` record and its mesh CAR. Mutation-checked: removing the block hash check or the low-s check each fails exactly one vector.

## D11. bitchat fork and the M2 viewer (2026-11-06)

- **Fork = `git subtree` at `ios/`** (squashed, upstream `04995f6`), inside the private repo. Update: `git subtree pull --prefix=ios https://github.com/permissionlesstech/bitchat main --squash`. (A GitHub fork of a public repo must be public.)
- **Fork patches** (keep this list short, re-check on every upstream pull):
  1. `bitchat/Views/Globe/GlobeView.swift`: `Double(displayScale)`, because Swift 6.2 (Xcode 26.3, the newest Xcode on this Intel iMac) finds `/` ambiguous.
  2. `bitchat.xcodeproj/project.pbxproj`: local package `../MeshSitesKit` linked into both app targets (IDs `4D5E51A0…01-05`).
  3. `bitchat/Views/AppInfoView.swift`: a "MeshSites" row + sheet (+30 lines, UI only).
  4. `bitchat/Services/BLE/BLEService.swift` (M3, D12): `import MeshSitesKit`; in `handleReceivedPacketOnQueue`'s `case .none`, type `0x4D` goes to `handleMeshSitesPacket` and a drop verdict returns before the relay; an extension at the end of the file adds `attachMeshSites()`, `handleMeshSitesPacket` (checks the packet signature against the sender's announced signing key, like public voice frames) and `sendMeshSites` (signs, marks its own packet as seen, `broadcastPacket`, which source-routes and re-signs a directed packet when it can).
  5. `bitchat/ViewModels/ChatViewModel.swift` (M3): one line, `meshService.attachMeshSites()`, after the `BLEService` is created.
  6. `Configs/Release.xcconfig` (M3): `#include? "Local.xcconfig"` at the end, as `Debug.xcconfig` has, so a Release test build signs with the local team. No effect without a (git-ignored) `Local.xcconfig`.
  7. `bitchat/Services/BLE/BLENoisePacketHandler.swift` (M4, D13): `import MeshSitesKit`; in the "Unknown noise payload type" branch, payload type `0x4D` from a peer with routing data goes to `MeshSitesService.receiveDirect` (+6 lines). `BLEService.swift` (patch 4) gains `sendMeshSitesDirect`, which calls bitchat's own `sendNoisePayload([0x4D] + payload)`.
  8. `bitchat/Services/BLE/BLEService.swift` (M4, D13), **link choice**: in `sendOnAllLinks`, a directed packet whose only chosen link is a write link that is backed up (`!canSendWriteWithoutResponse`, or writes already queued for it) goes out on the recipient's notify link when that peer is subscribed; `sendEncrypted`'s direct-write shortcut applies the same rule. Helper `meshSitesWriteLinkBackedUp`. **And at write time** (`writeOrEnqueue` on `bleQueue`): a directed write whose link reports `!canSendWriteWithoutResponse` goes to the peer's notify link (passed in as `notifyFallback`) instead of the write queue. The first version decided only before dispatch, and a burst raced past it (block B's first fragment was dispatched before block A's write had filled the link, then sat in the stuck queue; the clean build failed twice, the slower traced build happened to pass). Not applied to strict (`requireDirectPeerLink` / authenticated-link) sends. **Fragment sizing** (the actual fix, 2026-11-07 evening): `sendEncrypted` sizes fragments from the *smaller* of the write and notify limits, and `sendOnAllLinks` shrinks the chunk to the notify fallback's limit, both minus `meshSitesRouteHeadroom` (16 B); a packet only moves to the notify link if it fits `maximumUpdateValueLength`. Candidate for an upstream issue/PR: bitchat's `fragmentFrameOverhead` (42 B) leaves out the source route that `broadcastPacket` adds to directed packets, so every routed fragment is 1 B over the link limit; that affects bitchat's own fragmented private media too.
- **Debug builds are on bitchat's TESTNET** (`BLEService.serviceUUID` is `…4B5A` under `#if DEBUG`, `…4B5C` otherwise), so a Debug build never sees the App Store app. Interop tests against the App Store app need `-configuration Release`. A Release build is on the real public mesh: keep "Share my sites" off unless public announces are intended.
- **MeshSitesKit** (`../MeshSitesKit`): verified `SiteStore` (re-verifies on load, 64 MiB cap), `meshsite://<cid>/` scheme handler (one origin per site), and a WKWebView locked down by: a content rule list (block all except `meshsite://`), a per-site CSP, a navigation policy, a non-persistent data store, Safe Browsing off, and a document-start script in all frames that removes WebRTC/media/geolocation APIs.
- **WebRTC:** no CSP directive or public WKWebView setting disables it, and WKWebView exposes `RTCPeerConnection` by default (macOS test confirmed). The lockdown script removes it in every frame, including blank iframes, and `window.open` is refused. It's a JS-level mitigation: a WebKit bug that let a page restore the constructor would reopen it. Revisit if Apple adds a public switch.
- **Explicit no-network test (M2):** `MeshSitesKit` `swift test` renders `protocol/vectors/probe-site` in the real configuration: 13 checks pass. Removing the lockdown script fails exactly the WebRTC/media checks.
- **M2 verified on a real iPhone (2026-11-07):** iPhone 15 Pro Max, iOS 26.6, Debug build from Xcode 26.3 signed with a free team (profile valid 7 days). In-app "Run the no-network test": all 13 checks pass. `release/meshsites.car` (589 KiB) imported via AirDrop/Files and opened fully in Airplane Mode (Wi-Fi + Bluetooth off). `protocol/vectors/site-basic.tampered-block.car` was rejected on import.

## D12. M3 gossip policy (2026-11-07)

- **One pure policy, two languages.** `protocol/ts/src/gossip.ts` and `MeshSitesCore/Sources/MeshSitesCore/Gossip.swift` take one public `0x4D` packet plus the clock and return a verdict: relay or not, a stable drop code, whether the sender is blamed, a consumed HAVE / accepted name, and the packets to send. No timers or radio inside. `protocol/vectors/gossip.json` (17 scenarios) is the contract; every expectation is hand-written and checked against the TS policy when the vectors are generated. The web simulator's `MeshSitesNode` now delegates to the TS policy.
- **Drop codes:** `malformed`, `not-public` (direct sub-type on gossip), `ttl-over-cap`, `rate-limited`, `duplicate`, `record:<rejection>`. Blamed (spam strike): everything except `duplicate`, `record:stale-seq` and a rate-limited NAME_RECORD.
- **Rate limits (new; the Phase W node had none for WANT / NAME_RECORD):** ANNOUNCE one per sender per half interval (30 s); WANT token bucket per sender, 8 burst, 1 per 2 s; **WANTs whose bitchat packet signature could not be checked share one bucket**, so rotating the claimed sender ID buys nothing; NAME_RECORD bucket **per name**, 4 burst, 1 per 5 s, applied before the signature check.
- **Dedupe:** WANT by `reqId` (5 min, 1000 entries); NAME_RECORD by exact `(name, seq, text)`, not relayed again by patched nodes.
- **Fixes vs the Phase W node:** NAME_RECORD answers now forward the **exact stored signed text** (D4), not a `JSON.stringify` re-serialisation; a WANT with a lying `origTtl` clamps the HAVE hop count to 1..255.
- **Core hook (Hector, 2026-11-07): minimal.** Only `BLEService.swift` changes: the existing `case .none` branch hands `type == 0x4D` to MeshSites (relay skipped on a drop verdict), plus one send function and app wiring. No new `MessageType` case, so no other bitchat file changes.
- **M3 step 1 (app side):** `MeshSitesKit/MeshSitesService` runs the policy over bitchat: it mirrors the `SiteStore` into the policy, announces every ~60 s (±10 %) when sharing is on, answers WANTs, and offers a "who has it?" probe (WANT, 3 s HAVE window). **Sharing is opt-in** (off by default, persisted in `UserDefaults` `meshsites.seeding`). `bulkCapable` is false until M4. NAME_RECORD is sent unsigned (self-authenticating); ANNOUNCE / WANT / HAVE carry the bitchat packet signature. The MeshSites screen has a "Share my sites" toggle and a Mesh screen (nearby sites, holders, activity log, rejected-packet count). `MeshSitesServiceTests` wires two services back to back (ANNOUNCE → nearby, WANT → 1-hop HAVE consumed not relayed, forged TTL not relayed, sharing off = silent).
- **Known flake:** `OfflineWebViewTests.testRenderedSiteCannotReachTheNetwork` timed out (`NSURLError -1001`, page never posted) twice right after heavy rebuilds on this HDD Mac, then passed 3/3 on the same code; it also passes with the M3 changes stashed. WKWebView start-up under load, not a code change. Rerun before treating it as a failure.
- **M3 verified on devices (2026-11-07):**
  - *Discovery* (Debug builds, testnet): iPhone 15 Pro Max (iOS 26.6) sharing `meshsites.car` → iPhone XS (iOS 18.7.11): ANNOUNCE listed the site at 1 hop within a minute; "Who has it?" (WANT) got a directed HAVE back from the 15 Pro Max at 1 hop.
  - *Interop* (Release build, mainnet, sharing off, Airplane Mode + Bluetooth only): our build on the XS ↔ App Store bitchat 1.8.0 on the 15 Pro Max: each sees 1 peer; public and private (Noise) messages arrive both ways.
  - Not yet tested on devices: relaying MeshSites gossip *through* an unpatched node (needs 3 devices; covered by the code reading in bitchat-notes §4 and the simulator), and an unpatched app receiving our ANNOUNCEs during chat (sharing was off).

## D13. M4 block transfer (2026-11-07)

- **Hector approved the minimal Noise hook (D6 ASK answered):** direct messages ride bitchat's Noise sessions as NoisePayloadType `0x4D` (patch 7). No Noise change and no new enum case; relays only see `noiseEncrypted`, so unpatched relays carry it. `sendNoisePayload` queues behind a handshake, so a first BLOCK_REQ to a new peer just waits for the session.
- **One pure policy, two languages** (as D12): `protocol/ts/src/fetch.ts` / `MeshSitesCore/Fetch.swift`. `Fetcher`: rank holders (adjacent bulk, then fewest hops; one per peer; > 1 MiB dropped), request ≤ 32 CIDs from the DAG frontier (DFS order, so both languages ask for the same CIDs), hash-check each block, and move to the next holder on a corrupt block (**blamed**), BLOCK_NONE or the batch deadline (not blamed). Blocks already verified are kept, so only the remainder comes from the next holder. Failure codes: `no-holder`, `invalid-dag` (detail separate), `too-many-blocks`. Deadline = 4 s + (BLE: n·16 KiB·hops / 12 KB/s; bulk: n·16 KiB / 1 MB/s). `BlockServer`: answers BLOCK_REQ only from the **requested, complete stored site** (no cross-site lookups), per-peer bucket 8 burst / 1 per 500 ms, blames public gossip or garbage inside a session. Contract: `protocol/vectors/fetch.json` (10 fetch + 5 server scenarios, hand-checked at generation). The simulator node now runs on it.
- **Storing a fetched site:** MeshSitesCore gained a CARv1 writer (`CARFile.write`), byte-identical to @ipld/car for site-basic.car and meshsites.car (vector check). The service writes the verified DAG in DFS order and imports it through `SiteStore.importCar`, which verifies everything again.
- **App:** `MeshSitesService.download(root:)` = WANT, 3 s of HAVEs, then the Fetcher over Noise; progress (blocks, bytes, peer, link, seconds) on the Mesh screen. Serving reads stored CARs off the main thread (`SiteStore.readVerifiedSource`, 3-site cache).
- **Test sites (not committed, rebuild with the script in the session notes):** `m4-100k` `bafybeic65wzf33yftp42nnwnfdhqfhbiol7nf5d3asyi5a7brlfo2lyxyq` (103,230 B), `m4-1m` `bafybeihvn424aojw6eoagorxthyk7im6gwshksn3z7rgbtuuh7t6pwvji4` (1,027,628 B); index.html + SHA-256-counter filler (incompressible).
- **The BLE stall and patch 8 (2026-11-07):** the first device test failed at 1/10 blocks. Our activity log (now also written to `Library/Application Support/MeshSites/activity.log` in the app container; copy it off with `xcrun devicectl device copy from --domain-type appDataContainer --domain-identifier chat.bitchat.<your team ID>`) showed single-frame replies arriving in ~60 ms but fragmented ones 15-30 s late. bitchat's own debug logs could not be read (debug-level `os_log` is dropped on device even with `OS_ACTIVITY_DT_MODE` and `BITCHAT_LOG_LEVEL=debug`), so temporary trace lines (removed again) were added along the send/receive path. They showed the 15 Pro Max's central write link to the XS stuck after one write (`canSendWriteWithoutResponse` false, no `peripheralIsReady`) until the XS transmitted, while the reverse link drained instantly. With patch 8: m4-100k, 10 blocks, 4.8 s block transfer, 7.8 s WANT → stored, renders offline (docs/benchmarks.md).
- **Session allowance:** the first batch sent to a holder gets +10 s (`SESSION_SETUP_MS` / `Fetch.sessionSetupMs`) for a Noise handshake that may not exist yet; vectors pin the deadlines.
- **The real cause of the fragment loss (2026-11-07 evening):** fragments 1 B over the link limit. bitchat sizes a fragment as link limit − 42 B, but `broadcastPacket` then adds a source route to each directed fragment (≥ 1 B), so frames came out at 513 B on a 512 B link and 291 B on a 290 B link (counter traces, run-fix6: `p8-big513`). An over-length write-without-response is not guaranteed by iOS: on 512 B connections the writes still arrived, on 290 B connections the write link stalled after the first write (run-fix5: ~410 fragments queued, ~10 sent, drained only when the XS transmitted), and patch 8 refused to move them to notify because they didn't fit. That's the stall from the morning and why every success was on a 512 B connection. Fix in patch 8 (16 B headroom, size for both links); with it all fragments of a 290 B run went by notify and the download passed.
- **Reply pacing:** `MeshSitesService` sends BLOCK replies to one peer at most 2 at a time, each held for its estimated airtime (fragments × 25 ms + 50 ms). bitchat starts every fragmented reply as its own train with no transfer ID, so its 2-train limit doesn't apply; even 2 trains kept the 128-entry notify retry queue busy (~75 re-queues/s on a 290 B link). Not proven necessary on its own (it went in before the sizing fix), kept as a margin.
- **Verified 2026-11-07:** after the fix, 2 traced passes (one 512 B, one 290 B connection) and 3 clean-build passes in a row with fresh connections (force-quit both apps), including the reverse direction (XS seeding its mesh-downloaded copy → 15). Every run 10/10 blocks, 103,230 B.

## D14. Address bar (2026-11-07)

- **Mesh only (Hector's choice):** the "Open a site" field never touches the internet. Internet fetch (ENS lookup + gateway CAR, verified and seeded) stays M5's gateway mode.
- **Input** (`MeshSitesCore/Address.swift`, `SiteAddress.parse`, AddressTests): a bare CID, `ipfs://` / `meshsite://` links, `/ipfs/…` and `/ipns/…` paths, path gateways (`https://gw/ipfs/<cid>/…`), subdomain gateways (`https://<cid>.ipfs.gw/…`), `name.eth`, `ipns://name.eth`, `https://name.eth.limo` / `.eth.link`. Query and fragment are dropped; `.` / `..` segments are removed so a path can't climb out of the site. Names must end in `.eth` (lowercased; full ENS normalisation is the publisher's job, the record carries the normalised name). Swift only for now; the TS simulator doesn't need it yet.
- **Flow** (`MeshSitesService.open`): stored copy → open at once, no WANT. A name: a record we hold → its CID; else a stored site with that name; else WANT by name (existing wire message, root absent) and wait 3 s for a signed NAME_RECORD. Then WANT by CID → Fetcher → stored under the name with its badge → opened at the typed path. A gateway link carries the site's *original* CID; when a held record's `origCid` matches, the mesh CID is used instead.
- **Trust anchor:** nothing in the mesh originates name records yet (a device only knows records it received), so mesh-only name lookup would never succeed. The app ships meshsites.eth's signed record and signer (ENS text records `meshsites.record` / `meshsites.signer`, read 2026-11-07, signer `0x8e07…a410`) like the bundled probe site: every copy resolves meshsites.eth offline as Verified and answers nearby lookups for it. **Update `MeshSitesService.anchorRecord` after every re-pin of meshsites.eth.** `addNameRecord(_:signer:)` lets a publisher (and M5's gateway mode) add more.
- **Names for sites stored by CID (2026-11-15):** a site downloaded from the nearby list or imported from a file has no name, so it showed no badge even when the device held a signed record for it (seen on the XS: `meshsites.eth` fetched by CID, no badge). The service now names any unnamed stored site from a held record for that exact CID, Verified first: at start (the built-in anchor), after every store change, and when a record is added.
- **Privacy:** typing an address sends a WANT, so nearby devices see what was asked for (checklist item); the field's footer says so.
- **Sharing:** "Copy address" in the site viewer and on each stored site (long press, also "Copy CID") copies the name, or `ipfs://<mesh CID>` without one, for pasting into a chat or another device's address bar. Tappable links inside bitchat chat would touch bitchat's message view: not done, ASK first.
- **Verified 2026-11-07 on devices** (XS fetching, 15 Pro Max seeding): `meshsites.eth` resolved locally from the anchor, downloaded 50 blocks / 600,824 B over BLE in 34.1 s (~17.6 KB/s, no retries) and opened with the Verified badge; `https://meshsites.eth.limo/` opened the stored copy; the original gateway CID mapped to the mesh copy; an unknown name failed after 3 s; junk was rejected. Kit tests 18/18, core 7/7.

## D15. Wi-Fi box: sites for browsers with no app (2026-11-15)

- **What:** `meshsites serve <dir>` (`cli/src/serve.ts`) turns a computer on a Wi-Fi network with no internet into a box that serves verified sites to plain browsers. Setup and the HTTP surface are in `docs/box.md`.
- **Trust is weaker than the app's, and labelled.** The box verifies every CAR (the same `openCar` rules, re-run each time a site is loaded from disk) and every record signature. The browser can't: in-browser verification needs a service worker, which needs HTTPS, and a box can't hold a certificate browsers accept offline. Verifying in page script instead would prove nothing, since the box supplies the script. So a browser visitor trusts the operator; the list page says so. Raw CARs and signed records are served too (`/car/<cid>.car`, `/record/<name>.json`), so the app can use a box as a fast holder and stay trustless. That may be a simpler Wi-Fi bulk path than AWDL (D6): not built.
- **Names offline:** no lookup. A name resolves from a signed NAME_RECORD file in the folder (§4). `signers.json` pins the signer per name, copied from ENS while online: pinned → *verified*; not pinned → served as *unverified*, and refused if two signers claim the name. Highest `seq` whose CAR is present wins, so a record that arrives before its CAR doesn't take the name down.
- **One origin per site** when the box's DNS answers for it: `<cid>.<domain>`, `<name>.eth`, `<name>.eth.<domain>`. By IP there are no subdomains, so sites share the origin under `/ipfs/<cid>/` and `/ipns/<name>/`, each held to its own path by CSP (same policy as the web viewer's service worker). Shared storage between sites is a known gap of the by-IP mode.
- **Captive portal:** any host the box doesn't know gets a 302 to `http://<domain>/`. With catch-all DNS that is what makes phones show the sign-in sheet. `--dns <ip>` runs that catch-all DNS in the same process (A → the box, everything else empty, TTL 10 s) for routers that can't do it themselves.
- **Box tier (SPEC §2.3):** 64 MiB of blocks, 256 MiB expanded; `publish --box` / `verify --box`. Mesh caps are unchanged and the Swift side knows nothing of the box tier: the app still refuses anything over 1 MiB.
- **Not done:** online sync (resolve ENS, fetch from IPFS, re-chunk: M5's gateway mode, in Node), a static export for routers that can't run Node, the app fetching from a box. **Untested on hardware:** captive-portal behaviour on iOS and Android, phones leaving a network with no internet, the Raspberry Pi recipe.

