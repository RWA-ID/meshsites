// swift-tools-version: 5.9
// MeshSitesCore: the MeshSites protocol for Apple platforms. No UIKit, no
// bitchat dependency, so it is testable on macOS and shared by the iOS app.
import PackageDescription

let package = Package(
    name: "MeshSitesCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "MeshSitesCore", targets: ["MeshSitesCore"]),
        .executable(name: "meshsites-vectors", targets: ["meshsites-vectors"]),
    ],
    dependencies: [
        // Same package and version bitchat already pins (MIT).
        .package(url: "https://github.com/21-DOT-DEV/swift-secp256k1", exact: "0.24.0"),
    ],
    targets: [
        // The C library directly: P256K.Recovery.PublicKey calls fatalError when
        // recovery fails, and recovery input comes from untrusted peers.
        .target(name: "MeshSitesCore", dependencies: [.product(name: "libsecp256k1", package: "swift-secp256k1")]),
        // Runs protocol/vectors/*.json against MeshSitesCore. Shared by the
        // CLI checker (works with Command Line Tools) and the XCTest target.
        .target(name: "MeshSitesVectors", dependencies: ["MeshSitesCore"]),
        .executableTarget(name: "meshsites-vectors", dependencies: ["MeshSitesVectors"]),
        .testTarget(name: "MeshSitesCoreTests", dependencies: ["MeshSitesCore", "MeshSitesVectors"]),
    ],
    swiftLanguageVersions: [.v5]
)
