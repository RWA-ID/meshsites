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
