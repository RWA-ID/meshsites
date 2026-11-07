# MeshSites

Open a static website pinned to IPFS (optionally addressed by an ENS name such as `example.eth`) on a phone with **no internet**. The site comes from nearby phones over a [bitchat](https://github.com/permissionlesstech/bitchat) Bluetooth LE mesh, with peer-to-peer Wi-Fi for bulk data.

Nothing trusts the relaying peers: every block is checked against its CID hash, and names are checked by signature.

**Status:** M1 (publisher CLI) and Phase W (web testbed, `web/`) done. The iOS/macOS app (M2) waits on Xcode. See `HANDOFF-meshsites.md` for the plan and `docs/decisions.md` for what changed after reading bitchat's source.

## Layout

| Path | What |
|---|---|
| `protocol/SPEC.md` | packaging, canonical JSON, signed name records |
| `protocol/vectors/` | normative test vectors (shared by TypeScript and Swift) |
| `protocol/ts/` | TypeScript implementation (`@meshsites/protocol`) |
| `cli/` | `meshsites` publisher CLI |
| `web/` | browser simulator, multi-tab WebRTC nodes, offline viewer (`npm run web`; `npm run build:static` for IPFS) |
| `docs/` | bitchat notes, design decisions, benchmarks |

## CLI

Needs Node ≥ 22.18 (it runs the TypeScript directly).

```sh
npm install
npm test

# Package a site and sign its name record with a local key (read from an env var, never argv)
MS_KEY=0x… node cli/src/main.ts publish ./site --name example.eth --key-env MS_KEY

# …or sign with a wallet: prints the exact message for personal_sign
node cli/src/main.ts publish ./site --name example.eth --signer 0xYourDelegate
node cli/src/main.ts sign-record site.record.json --sig 0x…

node cli/src/main.ts verify site.car
node cli/src/main.ts verify-record site.record.signed.json --signer 0x… --cached-seq 11
```

`publish` prints the mesh CID (16 KiB chunks), the original CID, and the two ENS text records to set (`meshsites.signer`, `meshsites.record`).

## License

Not chosen yet. bitchat is public domain (Unlicense); the candidates are Unlicense, to match it, or MIT.
