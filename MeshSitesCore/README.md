# MeshSitesCore

The MeshSites protocol for Apple platforms (iOS 16+, macOS 13+): CIDs, CARv1, DAG-PB/UnixFS, strict DAG verification, path resolution, canonical JSON, Keccak-256, EIP-191 name records and the draft wire codec. No UIKit, no bitchat dependency.

One dependency: `libsecp256k1` from [21-DOT-DEV/swift-secp256k1](https://github.com/21-DOT-DEV/swift-secp256k1) 0.24.0 (MIT), the same package and version bitchat pins. It's used as the **C library**, not the `P256K` Swift wrapper: `P256K.Recovery.PublicKey` calls `fatalError` when recovery fails, and recovery input comes from untrusted peers.

```sh
swift build
swift run meshsites-vectors          # every protocol/vectors check (works with Command Line Tools)
swift run meshsites-vectors --fuzz   # random/hostile input through every decoder; must not crash
swift test                           # same checks under XCTest (needs Xcode)
```

The TypeScript implementation in `protocol/ts` generates the vectors; both must pass them.
