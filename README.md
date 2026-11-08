# MeshSites

**Websites that still open when the internet is down.** Phones pass small IPFS websites (optionally named with ENS, like `meshsites.eth`) to each other over a [bitchat](https://github.com/permissionlesstech/bitchat) Bluetooth mesh, with no cell signal, Wi-Fi router or server. Nothing trusts the phones in between: every block is checked against its content hash before a site opens, and names are checked by signature.

Website: [meshsites.eth.limo](https://meshsites.eth.limo) (also on the mesh itself, as `meshsites.eth`).

## Why

Connectivity fails often, and at the worst time:

- **Shutdowns:** at least 313 government internet shutdowns in 52 countries in 2025, the most on record; satellite internet was cut 14 times ([Access Now](https://www.accessnow.org/press-release/rising-and-resisting-in-the-darkness-internet-shutdowns-in-2025/)).
- **Storms:** during Hurricane Melissa, Jamaica's connectivity fell to about 30% of normal ([Decrypt](https://decrypt.co/346748/bitchat-tops-jamaica-app-charts-hurricane-melissa-cuts-connectivity)); ten days later 504 of Digicel's 925 mobile sites still had no power ([Digicel](https://www.psoj.org/wp-content/uploads/2025/11/Digicel-Jamaica-Update-HURRICANE-MELISSA-5.pdf)).
- **Blackouts:** the April 2025 Iberian blackout left about 60 million people without power for roughly 10 hours, and most mobile calls and texts failed ([AP](https://m.washingtontimes.com/news/2025/apr/28/exceptional-power-outage-spain-portugal-affects-millions-people/)).

People already turn to mesh messaging when this happens (bitchat's Nepal downloads went from about 3,300 to 48,781 in under a week during the 2025 social-media ban, [Decrypt](https://decrypt.co/339015/jack-dorseys-bitchat-surges-in-nepal-indonesia-amid-protest-crackdowns?amp=1)). But the information people need most (shelters, open clinics, passable roads) lives on websites. It is small and changes slowly, which is what a mesh can carry. MeshSites is a last-mile distribution layer for sites published *before* the crisis, by emergency agencies, cities, clinics, NGOs and local businesses. It complements satellite links and radio rather than replacing them.

It fits poorly for live data (balances, chat inside a site), large media, or people spread far apart: Bluetooth reaches tens of metres per hop.

## How it works

1. **Publish.** A static site is packaged as a CAR file in 16 KiB blocks; its CID is a hash of its content. An ENS name can point to it through a record signed by the publisher.
2. **Save while online.** Any phone with internet saves the site and can then share it.
3. **Discover.** Phones with sharing on announce the sites they hold over bitchat's BLE mesh; a phone asks its neighbours for a name or a CID.
4. **Transfer.** Blocks come from the nearest holder inside bitchat's Noise session.
5. **Verify, then open.** Every block is hash-checked; names show **Verified** (signed by the name's known publisher) or **Unverified** (unknown signer). Opened sites can't reach the network.

## Status

A working prototype, verified on two iPhones (15 Pro Max on iOS 26.6, XS on iOS 18.7) in Airplane Mode with Bluetooth on, one hop apart:

| Site | Size | Bluetooth transfer | Result |
|---|---|---|---|
| test site | 103 KB, 10 blocks | about 6 s | 3 passes in a row, both directions |
| `meshsites.eth` | 601 KB, 50 blocks | 34 s | opened by name, Verified |

Done: M0–M3 (protocol, publisher CLI, web testbed, on-device rendering, mesh discovery), M4's Bluetooth block transfer, and the address bar (open by name, CID, `ipfs://` or gateway link; copy a site's address). See `docs/decisions.md` (D1–D14) and `docs/benchmarks.md`.

Not yet: an App Store release, peer-to-peer Wi-Fi bulk transfer, 2- and 3-hop measurements (need more phones), fetching sites from the internet inside the app (M5), battery and cache policies (M6).

## Using it

**Before a crisis:** install the app while you have internet. In MeshSites, import the sites you'll want (a `.car` file from the Files app) and turn on **Share my sites with nearby devices** to help spread them.

**When the network is down:** keep Bluetooth on and the app open (iOS limits Bluetooth in the background). Type a name or link in **Open a site**: `yourcity.eth`, `ipfs://bafy…` (try the example sites below), `https://name.eth.limo/…` or a gateway link. A saved site opens at once; otherwise nearby phones are asked and it downloads. **Copy address** to send it on in a bitchat chat. Asking is visible to nearby phones, so they can see which site you asked for.

## Example sites

Two small sample sites (about 5 KB each, 3 blocks) in `examples/`, pinned to IPFS with the mesh CID as their real CID, so the same address works in the app and on any gateway. Both are marked as examples, with made-up places and `555-01xx` phone numbers.

| Site | Address |
|---|---|
| Emergency (Spanish): shelters, water, clinics, roads, numbers for a fictional town | `ipfs://bafybeigvgj6gkgunhyhvrjejx6tzhmox6qzmk3i3dup3h7qkykpsweb76a` ([web](https://ipfs.onchain-id.id/ipfs/bafybeigvgj6gkgunhyhvrjejx6tzhmox6qzmk3i3dup3h7qkykpsweb76a/)) |
| News: bulletin snapshot and a "staying safe offline" guide | `ipfs://bafybeigkmqxnazsh2e4dpejt6aw27vm7rvcurh7xod4jilw3gpnf2bcc2a` ([web](https://ipfs.onchain-id.id/ipfs/bafybeigkmqxnazsh2e4dpejt6aw27vm7rvcurh7xod4jilw3gpnf2bcc2a/)) |

Rebuild after editing: `node cli/src/main.ts verify` checks a CAR; pin the CAR itself (Pinata v3 upload with `car=true`) so the pinned CID equals the mesh CID. A site pinned as a folder gets a different CID (Kubo's default chunking), which only maps to the mesh copy through a signed name record.

## Publishing a site

Keep it small: aim for under 200 KB (1 MiB is the cap). Text first, compressed images, no web fonts or big frameworks, relative links only.

```sh
npm install
# Package and sign the name record with a local key (read from an env var, never argv)
MS_KEY=0x… node cli/src/main.ts publish ./site --name yourname.eth --key-env MS_KEY
# …or sign with a wallet: prints the exact message for personal_sign
node cli/src/main.ts publish ./site --name yourname.eth --signer 0xYourDelegate
node cli/src/main.ts sign-record site.record.json --sig 0x…
```

`publish` prints the mesh CID (16 KiB chunks), the original CID, and two ENS text records to set: `meshsites.signer` and `meshsites.record`. Pin the site to IPFS, point the name's contenthash at it and set both records; the site also works through any `.eth.limo` gateway. Get it onto phones *before* it's needed. To update, publish again: the record's higher sequence number replaces the old one on phones that hear it.

```sh
node cli/src/main.ts verify site.car
node cli/src/main.ts verify-record site.record.signed.json --signer 0x… --cached-seq 11
```

## Developing

| Path | What |
|---|---|
| `protocol/SPEC.md` | packaging, canonical JSON, signed name records, wire format |
| `protocol/vectors/` | normative test vectors shared by TypeScript and Swift |
| `protocol/ts/` | TypeScript implementation (`@meshsites/protocol`) |
| `cli/` | `meshsites` publisher CLI |
| `web/` | this website, the browser simulator and offline viewer (`npm run web`; `npm run build:static` for IPFS) |
| `MeshSitesCore/` | Swift protocol core (CIDs, CAR, records, gossip, fetch, addresses) |
| `MeshSitesKit/` | iOS/macOS app layer: site store, locked-down web view, mesh service, screens |
| `ios/` | the bitchat fork; MeshSites patches are listed in `docs/decisions.md` D11 |
| `docs/` | bitchat notes, design decisions, benchmarks |

```sh
npm test                                  # TypeScript (Node ≥ 22.18)
(cd MeshSitesCore && swift test)          # Swift core + shared vectors
(cd MeshSitesKit && swift test)           # app layer, incl. two services over an in-memory mesh
cd ios && xcodebuild -project bitchat.xcodeproj -scheme "bitchat (iOS)" \
  -configuration Debug -destination 'generic/platform=iOS' -allowProvisioningUpdates build
```

Debug builds use bitchat's testnet Bluetooth service, so they only see other Debug builds; Release builds join the public bitchat mesh. Signing needs a git-ignored `ios/Configs/Local.xcconfig` with your team ID.

## Support

MeshSites is built by one independent developer, unfunded. Donations pay for test phones, Apple's developer program for an App Store release, and a first pilot with a city or relief group.

Send to **`ensgiant.eth`**, or:

| Network | Address |
|---|---|
| Ethereum, Base and other EVM chains | `0x2D037f66b9e0EDE90c2080558a7d3FF7BE36E9A1` |
| Bitcoin | `bc1qmnqylca7dnsa96g2ykyhqyhgu5mmzse22davhf` |
| Solana | `4rZudqFF3ZSngGUTjHrwMmrEzdKLYU36bibBLj348P81` |

Check the address against `ensgiant.eth` in your wallet before sending. Updates on X: [@ensgianteth](https://x.com/ensgianteth).

## License

Not chosen yet. bitchat is public domain (Unlicense); the candidates are Unlicense, to match it, or MIT.
