// swift-tools-version: 5.9
// MeshSitesKit: the MeshSites viewer for the bitchat app (iOS + macOS):
// verified site store, meshsite:// scheme handler, locked-down WKWebView, UI.
import PackageDescription

let package = Package(
    name: "MeshSitesKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "MeshSitesKit", targets: ["MeshSitesKit"])],
    dependencies: [.package(path: "../MeshSitesCore")],
    targets: [
        .target(
            name: "MeshSitesKit",
            dependencies: [.product(name: "MeshSitesCore", package: "MeshSitesCore")],
            // Copy of protocol/vectors/probe-site.car (a test checks they match).
            resources: [.copy("Resources/probe-site.car")]
        ),
        .testTarget(name: "MeshSitesKitTests", dependencies: ["MeshSitesKit"]),
    ],
    swiftLanguageVersions: [.v5]
)
