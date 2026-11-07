# Benchmarks

## Simulated (Phase W), not real radios

Generated with `node protocol/ts/scripts/bench-sim.ts` (virtual time, seed 7, 0% loss) on 2026-11-06. **These are not M4 results.** M4 needs real-device numbers for 1, 2 and 3 hops (BLE) and the direct peer-to-peer link.

Model: 469-byte fragments at one per 25 ms (directed), 8-20 ms per-hop latency, bitchat relay jitter, store-and-forward per packet, 32-block batches. "Wi-Fi" is a 2 MB/s single-hop link standing in for Network.framework peer-to-peer.

| Site | Link | Hops | Total (s) | Transfer after 3 s HAVE window (s) | Effective KB/s |
|---|---|---|---|---|---|
| site-basic (41 KB) | BLE | 1 | 5.4 | 2.4 | 17.0 |
| site-basic (41 KB) | BLE | 2 | 6.9 | 3.9 | 10.6 |
| site-basic (41 KB) | BLE | 3 | 8.3 | 5.3 | 7.7 |
| site-basic (41 KB) | Wi-Fi | 1 | 3.1 | 0.1 | 757.0 |
| 100 KB | BLE | 1 | 8.6 | 5.6 | 17.8 |
| 100 KB | BLE | 2 | 9.9 | 6.9 | 14.5 |
| 100 KB | BLE | 3 | 11.3 | 8.3 | 12.1 |
| 100 KB | Wi-Fi | 1 | 3.1 | 0.1 | 1315.1 |
| 1 MB | BLE | 1 | 58.4 | 55.4 | 18.1 |
| 1 MB | BLE | 2 | 61.0 | 58.0 | 17.3 |
| 1 MB | BLE | 3 | 63.7 | 60.7 | 16.5 |
| 1 MB | Wi-Fi | 1 | 3.5 | 0.5 | 1861.9 |

### What these numbers do and don't say

- **Optimistic for multi-hop BLE.** The model gives every link direction its own airtime queue. A real relay has one half-duplex radio shared by its incoming and outgoing links, so multi-hop throughput should fall towards ~1/hops of a single hop. Treat the 2- and 3-hop rows as a lower bound on time.
- **The fixed 3 s HAVE window dominates small sites.** For a 41 KB site, about 55% of the time is spent waiting for HAVEs. Worth revisiting at M3: start pulling as soon as an adjacent bulk-capable HAVE arrives, and keep listening in the background.
- **1 MB over BLE takes about a minute even at one hop.** This confirms the brief's split: BLE for discovery and small sites, peer-to-peer Wi-Fi for anything near the 1 MiB cap.
- Loss isn't measured here. With per-fragment loss, a 16 KiB block (~35 fragments) is lost whenever any fragment is: at 2% fragment loss that's ~50% of blocks. Losses show up as batch timeouts and peer fallback, so **block retransmission needs a design at M4** (smaller BLE batches, or per-block retry).

## Real devices (M4)

Not measured yet.
