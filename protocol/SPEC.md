# MeshSites protocol spec

Version: draft 1 (M1). Covers content packaging (§2), canonical JSON (§3) and the signed name record (§4). Wire messages (§5) are specified at M3; their shape is decided in `docs/decisions.md` D4.

Normative vectors live in `protocol/vectors/`. **An implementation conforms only if it passes all of them.** Where this text and the vectors disagree, the vectors win and this text is a bug.

## 1. Conventions

- Byte sizes: KiB = 1024 bytes.
- "Reject" means: don't store, don't render, don't relay.

## 2. Content

### 2.1 Packaging (publisher / gateway)

A site is a directory packaged as **CARv1** with exactly **one root**: a UnixFS directory.

| Parameter | Value |
|---|---|
| CID version | 1 |
| Multihash | sha2-256 (0x12, 32-byte digest) |
| Codecs | `dag-pb` (0x70) for directory and file nodes, `raw` (0x55) for leaves |
| Chunker | fixed size, **16384 bytes** |
| Leaves | raw (no UnixFS wrapper) |
| A file that fits one chunk | the raw leaf *is* the file (no wrapper node) |
| File layout | balanced, max 174 children per node |
| Directories | plain UnixFS directories; **never HAMT-sharded** |
| Root | a directory wrapping the site's top-level entries |
| Excluded | entries whose name starts with `.`, plus `Thumbs.db` |
| Block order in the CAR | depth-first pre-order from the root, each block once |

This equals `ipfs add -r --cid-version=1 --chunker=size-16384 <dir>` (Kubo 0.43.1; confirmed against `vectors/car.json`). The CID a default `ipfs add -r` gives is recorded as a hint (`origCidHint`). The authoritative `origCid` is whatever the ENS contenthash holds.

### 2.2 Verification (every receiver)

Before a block is written to the store:

1. CID is v1, codec is `raw` or `dag-pb`, multihash is sha2-256 with a 32-byte digest.
2. Block length ≤ **32768** bytes.
3. `sha256(bytes) == digest`.

Before a site is rendered (whole DAG):

4. CAR header is version 1 with exactly one root, and the root is `dag-pb`.
5. Every block reachable from the root is present. A block that fails steps 1-3 counts as absent.
6. No block is unreachable from the root, and no block appears twice.
7. Every `dag-pb` node decodes, and its UnixFS type is `directory`, `file` or `raw`. The root is a `directory`. Every directory entry has a non-empty name.
8. Sum of unique block bytes ≤ **1 MiB** (also checked against `ANNOUNCE.sizeBytes` *before* downloading).
9. Expanded size ≤ **4 MiB**: each node's size is its inline UnixFS data plus the expanded size of each link, counted once per reference. Compute it with memoisation; this stops a small CAR that references one block many times (`vectors/dedupe-bomb.car`).

## 3. Canonical JSON

Used for anything signed. Output is UTF-8.

- Objects: keys match `[A-Za-z0-9_]+`, sorted ascending by byte. No whitespace anywhere.
- Numbers: integers in `[-(2^53-1), 2^53-1]` only, in decimal with no exponent or leading `+`. `-0` is written `0`. Anything else is rejected.
- Strings: the output of ECMAScript `JSON.stringify` on a well-formed string:
  - `"` → `\"`, `\` → `\\`
  - U+0008 `\b`, U+0009 `\t`, U+000A `\n`, U+000C `\f`, U+000D `\r`
  - other U+0000..U+001F → `\u00xx` (lowercase hex)
  - **everything else, including `/` and all non-ASCII, is emitted raw** (UTF-8)
  - lone surrogates are rejected
- `true`, `false`, `null` and arrays are allowed.

Swift note: `JSONSerialization` and `JSONEncoder` escape `/` and may reorder or reformat, so don't use them to produce signed bytes. Use a hand-written encoder checked against `vectors/canonical-json.json`.

## 4. NAME_RECORD

### 4.1 Record

```json
{"cid":"bafy…","name":"example.eth","origCid":"bafy…|Qm…","seq":12,"signer":"0x…","ts":1762470000,"v":1}
```

| Field | Rule |
|---|---|
| `v` | `1` |
| `name` | ENSIP-15 normalized, and equal to its own normalization; contains a `.` |
| `cid` | mesh root CID (§2), CIDv1, canonical string form (base32 `b…`) |
| `origCid` | ENS contenthash CID, any version, canonical string form (`Qm…` for v0) |
| `seq` | integer ≥ 0; higher replaces lower. The CLI defaults it to `ts`. |
| `ts` | Unix seconds, integer ≥ 0 |
| `signer` | **lowercase** `0x` + 40 hex |

Exactly these seven keys. Unknown keys are rejected in v1.

### 4.2 Signature

- Message `m` = canonical JSON (§3) of the record.
- Hash = `keccak256("\x19Ethereum Signed Message:\n" + decimal(byteLength(m)) + m)`, i.e. EIP-191 `personal_sign`. The length is in **UTF-8 bytes**, not characters (`vectors/records.json` has a `café.eth` case).
- `sig` = `0x` + r(32) + s(32) + v(1), with v ∈ {27, 28}. On verify, v ∈ {0, 1} is also accepted.
- **s must be low** (s ≤ n/2). High-s twins are rejected.

Signed form (wire, files and the `meshsites.record` text record):

```json
{"record":{…},"sig":"0x…"}
```

Exactly these two keys. The key order inside `record` doesn't matter on receipt, because verifiers rebuild the canonical message.

### 4.3 Verification order

1. Well-formed (§4.1), else **malformed**.
2. Recover the address from `sig`, else **bad-signature**. It must equal `record.signer`, else **signer-mismatch**.
3. `ts ≤ now + 300`, else **future-ts**.
4. If a seq is cached for `name`: `seq > cachedSeq`, else **stale-seq** (equal is a replay and is rejected).
5. If a trusted signer is known for `name`: it must equal `record.signer` → **verified**, else **not-authorized**. If none is known → **unverified** (show "Unverified name"; still openable by raw CID with a warning).

Trust anchors are listed in `docs/decisions.md` D7: the `meshsites.signer` text record (preferred), then the on-chain owner, then gateway attestations (TOFU, labelled as such).

### 4.4 ENS text records

| Key | Value |
|---|---|
| `meshsites.signer` | the delegate address (checksummed for display; compared case-insensitively) |
| `meshsites.record` | the signed form (§4.2), compact JSON |

## 5. Wire messages

M3. See `docs/decisions.md` D4 (outer bitchat type `0x4D`, TLV sub-types).
