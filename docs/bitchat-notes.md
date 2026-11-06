# bitchat notes (M0)

Source read: `permissionlesstech/bitchat` @ `04995f68e470a18d1fc99f86fa326c2a87bab4f2` (2026-10-25), shallow clone at `~/meshsites-ref/bitchat`.
License: **Unlicense (public domain)**. File references below are relative to that repo.

## 1. Packet format

`localPackages/BitFoundation/Sources/BitFoundation/BinaryProtocol.swift`, `BitchatPacket.swift`

```
Header  v1 = 14 B, v2 = 16 B (big-endian)
| version 1 | type 1 | ttl 1 | timestamp 8 (ms) | flags 1 | payloadLength 2 (v1) / 4 (v2) |
Then:
| senderID 8 | recipientID 8 (flag 0x01) | route: count 1 + count*8 (flag 0x08, v2 only) |
| originalSize 2/4 (flag 0x04, compressed only) | payload | signature 64 (flag 0x02, Ed25519) |
```

Flags: `0x01` hasRecipient, `0x02` hasSignature, `0x04` isCompressed, `0x08` hasRoute (v2), `0x10` isRSR (sync response).

- `payloadLength` covers payload (+ originalSize field if compressed), **not** the route bytes.
- Signature is over the packet encoded with `ttl = 0`, signature removed, `isRSR = false` (`toBinaryDataForSigning`), so relays can decrement TTL.
- Padding: PKCS#7 toward 256/512/1024/2048 buckets, skipped if > 255 pad bytes are needed. The whitepaper says only Noise packets are padded in practice. The decoder tries unpadded first, then unpadded-after-strip.
- `senderID` is 8 bytes derived from the long-lived Noise static key, so it is a **persistent, linkable identifier** (rotation work exists in `docs/PEER-ID-ROTATION.md` and `announceV2 = 0x2C`, not yet shipping).
- Receive-side per-type payload caps: `PacketPayloadLimits.swift`. **Unknown types are capped at 128 KiB** decoded (twice a v1 frame). A future type that needs more must be added there or receivers drop it at decode.
- Timestamp skew check: packets more than **120 s** from local time are rejected at ingress (`BLEIngressPacketGuard`, `bleMaxTimestampSkewMs`). Note: this Mac's clock has run ~29 s slow before, which is inside the window but worth knowing.

### Message types (`MessageType.swift`)

| Value | Type | Value | Type |
|---|---|---|---|
| 0x01 | announce | 0x22 | fileTransfer |
| 0x02 | message | 0x23 | boardPost |
| 0x03 | leave | 0x24 | prekeyBundle |
| 0x04 | courierEnvelope | 0x25 | groupMessage |
| 0x10 | noiseHandshake | 0x26 / 0x27 | ping / pong |
| 0x11 | noiseEncrypted | 0x28 | nostrCarrier |
| 0x20 | fragment | 0x29 | voiceFrame |
| 0x21 | requestSync (link-local) | 0x2C | announceV2 (not shipping) |

The comments in `MessageType.swift` say `0x05` has been recycled three times and must not be reused, and that `0x2A`/`0x2B` are claimed by in-flight courier work. Upstream allocates **forward** from 0x29.

Inner Noise payload types (`bitchat/Protocols/BitchatProtocol.swift`, `NoisePayloadType`) are a separate namespace, first byte of the decrypted payload: 0x01-0x03, 0x06-0x08, 0x10-0x12, 0x20, 0x21 (0x09 is a legacy alias).

## 2. MTU, fragmentation, throughput

- `TransportConfig.bleDefaultFragmentSize = 469` (~512 MTU minus overhead).
- A frame larger than the link limit is split by `BLEOutboundFragmentPlanner`. The fragment payload is:
  `fragmentID 8 | index u16 | total u16 | originalType 1 | chunk`, sent as `type = 0x20`, with the **same** sender, timestamp, TTL, route and recipient as the original. Fragments are unsigned.
- Reassembly is per receiving node: 128 concurrent assemblies, 30 s timeout, 1 MiB cap, and the assembly is bounded by the cap of its claimed `originalType` (so ≤ 128 KiB for our unknown type).
- Spacing between fragments: 30 ms broadcast, **25 ms directed** (`bleFragmentSpacing*`).
- Throughput, back of envelope: 469 B / 25 ms ≈ **18 KB/s per hop at best**. 16 KiB block ≈ 35 fragments ≈ 0.9 s. 1 MiB site ≈ 1 min single hop, more with hops and loss. This is why bulk must use peer-to-peer Wi-Fi.
- **Trap:** a fragment of a *broadcast* packet floods mesh-wide (relay cap 7 sparse / 5 dense). Only *directed* fragments (recipientID set) relay deterministically point to point. Block bytes must never be broadcast.

## 3. TTL, relaying and dedupe

`bitchat/Services/RelayController.swift`, `bitchat/Services/BLE/BLEReceivePipeline.swift`, `BLEService.swift:5931`

- Originate at TTL 7 (`messageTTLDefault`). Incoming TTL is clamped to 7. A node relays only if `ttl > 1` and relays with `ttl - 1`, so **TTL = N reaches N hops**.
- Never relayed: TTL ≤ 1, own packets, packets addressed to self, `requestSync`.
- Directed traffic (handshake, directed noiseEncrypted / courier / ping / pong / nostrCarrier, directed fragments): always relayed, TTL - 1, 10-60 ms jitter, no fanout subsetting.
- Broadcast: TTL clamped to 5 in dense graphs (≥ 6 links), full depth in thin chains (≤ 2 links), else 6 (7 for announces). Jitter 10-220 ms by degree. Re-sent to a **message-ID-seeded subset of ~log2(degree) links** (announces, fragments and sync get full fanout). The ingress link is excluded.
- Source routing (v2 `hasRoute`): `forwardAlongRouteIfNeeded` forwards along an explicit route for **any type except requestSync**, and suppresses the flood. Routes come from the topology map built from announces (up to 10 neighbours each, 60 s freshness).
- Dedupe: LRU of 1000 IDs, 5 min expiry. ID = `senderID-timestamp-type-sha256(payload)[0..4]`. Applies to every type except fragments. A scheduled relay is cancelled when a duplicate arrives first (only when > 2 links).

## 4. Adding message types without breaking old clients (confirmed)

`BLEService.handleReceivedPacketOnQueue` (line ~5978): the `switch` on `MessageType?` has `case .none:` which **logs "Unknown message type" and then falls through to `forwardAlongRouteIfNeeded` + `scheduleRelayIfNeeded`**. So an unpatched client:

- decodes our packet (payload ≤ 128 KiB),
- dedupes it,
- **relays it under the generic broadcast policy** (or along its source route),
- does not show anything in chat,
- does not store it in gossip sync (`GossipSyncManager.swift:274` ignores unknown types).

Consequences for us:
- Old clients will relay our gossip, which is good for reach. They do **not** know our TTL caps, so the caps must be enforced by the **originator** setting a low TTL. Patched relays can additionally drop packets that arrive with TTL above the cap.
- A directed unknown type (recipient set) is **not** in the deterministic directed-relay list, so old nodes treat it as broadcast (jitter, subset fanout). For reliable unicast use either a source route or wrap it in `noiseEncrypted`.
- Unknown inner Noise payload types are only seen by the recipient (old recipients log "Unknown noise payload type" and drop). Relays can't see inner types, so directed `noiseEncrypted` carrying a new inner type is fully compatible on the relay path.

## 5. Compression

`CompressionUtil.swift`: **zlib/raw DEFLATE, not LZ4** (the handoff brief is wrong here). Applied automatically by `BinaryProtocol.encode` when "beneficial" (> 256 B payloads). The decoder rejects declared ratios above 1032:1 and per-type size caps. For us: block bytes of HTML/CSS/JS compress well on BLE for free; CIDs are always computed over the *uncompressed* block bytes.

## 6. Crypto in bitchat

- Noise XX for live sessions (`bitchat/Noise/`), Noise X for offline seals. Sessions can be multi-hop (handshakes relay).
- `NoiseHandshakeState.getHandshakeHash()` and `getTransportCiphers(...)` return the final handshake hash, so a **channel binding value exists** for authenticating a side channel (Multipeer / Network.framework) to the same peer.
- Ed25519 packet signatures (announces, board posts, voice frames, …).
- Already depends on `21-DOT-DEV/swift-secp256k1` **0.24.0** (product `P256K`, MIT), which includes `Sources/P256K/Recovery/Recovery.swift`, so EIP-191 recovery needs no new package.
- No Keccak-256 anywhere in the tree.

## 7. Background behaviour (iOS)

- `Info.plist` `UIBackgroundModes`: `bluetooth-central`, `bluetooth-peripheral`. No other modes.
- `BLEService` checks `isAppActive`: when a packet arrives while backgrounded, it uses that radio wake to run the announce/flush/drain maintenance pass (the maintenance timer is suspended with the app). Scan duty cycling is in `BLEScanDutyPolicy.swift`.
- Under iOS rules, a background peripheral advertises only via the overflow area (service UUID in a hashed bitmask), so it is visible only to foreground iOS scanners that scan for that UUID. Background scanning is slower and coalesced. Practically: **background relaying of small packets works between devices with an existing link; discovery and bulk do not.** That matches the MVP assumption (foreground on fetching and seeding devices).
- bitchat has **no** Multipeer / Network.framework peer-to-peer transport. The only non-BLE transports are Nostr (internet) and Tor.

## 8. Existing pieces we may reuse

- `fileTransfer` (0x22): up to 1 MiB, MIME allow-list + magic-byte check. **Not usable** for blocks (MIME gate, public broadcast, flooded, synced into gossip).
- Directed `noiseEncrypted` + fragments: the right BLE path for `BLOCK_REQ`/`BLOCK` (authenticated, encrypted, padded, deterministic relay, 1 MiB cap).
- Courier / store-and-forward (`docs/SOURCE_ROUTING.md`, courier envelopes): not needed for the MVP.

## 9. Build and tests

- SwiftPM `Package.swift` (tools 5.9, iOS 16 / macOS 13) builds the app sources and runs `bitchatTests`. The real app targets live in `bitchat.xcodeproj`.
- A `Justfile` and `scripts/` exist for CI and perf gates.
- **On this Mac:** only Command Line Tools (Swift 6.2.3) are installed. `swift build` works, but **`swift test` fails: neither `XCTest` nor `Testing` is available without Xcode.** Verified with a probe package.

## 10. Berty / libp2p proximity transports (verified)

- `berty/weshnet` (MIT OR Apache-2.0, active 2026-10-30) has `pkg/ble-driver` (ObjC, `BleManager_darwin.m` …), `pkg/multipeer-connectivity-driver` (ObjC `MCManager.m` + cgo bridge) and `pkg/proximitytransport` (a libp2p transport over those drivers). `berty/berty` (same dual license) holds the Android BLE driver.
- They are libp2p transports driven from Go via gomobile/cgo. Full libp2p over the mesh is a non-goal, and pulling in a Go runtime is heavy, so this is **reference material only**. The `MCManager.m` session handling is worth reading when we build the bulk link.
