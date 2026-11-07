import Foundation
import MeshSitesCore
@testable import MeshSitesKit
import WebKit
import XCTest

@MainActor
final class OfflineWebViewTests: XCTestCase {
    var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("meshsites-test-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    static var vectors: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("protocol/vectors")
    }

    /// M2: "The WebView cannot make any network request (test this explicitly)."
    func testRenderedSiteCannotReachTheNetwork() async throws {
        let store = SiteStore(directory: dir)
        let results = try await NetworkProbe().run(store: store)
        for r in results { print("probe \(r.passed ? "PASS" : "FAIL") \(r.what): expect \(r.expect), got \(r.got) \(r.detail ?? "")") }
        XCTAssertGreaterThanOrEqual(results.count, 11, "probe did not report every check")
        for r in results { XCTAssertTrue(r.passed, "\(r.what): expected \(r.expect), got \(r.got) (\(r.detail ?? ""))") }
    }

    func testBundledProbeMatchesVectors() throws {
        let vec = try Data(contentsOf: Self.vectors.appendingPathComponent("probe-site.car"))
        XCTAssertEqual(Array(vec), NetworkProbe.probeCar, "Resources/probe-site.car is stale: copy protocol/vectors/probe-site.car")
    }

    func testStoreRejectsTamperedAndOversizedCars() throws {
        let store = SiteStore(directory: dir)
        let tampered = try Data(contentsOf: Self.vectors.appendingPathComponent("site-basic.tampered-block.car"))
        XCTAssertThrowsError(try store.importCar(Array(tampered), label: "x"))
        let bomb = try Data(contentsOf: Self.vectors.appendingPathComponent("dedupe-bomb.car"))
        XCTAssertThrowsError(try store.importCar(Array(bomb), label: "x"))
        XCTAssertTrue(store.sites.isEmpty)
        let good = try Data(contentsOf: Self.vectors.appendingPathComponent("site-basic.car"))
        let site = try store.importCar(Array(good), label: "example")
        XCTAssertEqual(site.root, "bafybeib5gg45er6y7rgo2hgisx7bj4issekvfyhu52k3em52a2bb2khvxy")
        XCTAssertEqual(store.sites.count, 1)
    }

    func testStoreReverifiesOnLoad() throws {
        let store = SiteStore(directory: dir)
        let good = try Data(contentsOf: Self.vectors.appendingPathComponent("site-basic.car"))
        let site = try store.importCar(Array(good), label: "example")
        // Corrupt the file on disk behind the store's back.
        let tampered = try Data(contentsOf: Self.vectors.appendingPathComponent("site-basic.tampered-block.car"))
        try tampered.write(to: store.carURL(site.root))
        let fresh = SiteStore(directory: dir)
        XCTAssertThrowsError(try fresh.source(for: site.root))
    }

    func testRendersSiteBasic() async throws {
        let store = SiteStore(directory: dir)
        let site = try store.importCar(Array(try Data(contentsOf: Self.vectors.appendingPathComponent("site-basic.car"))), label: "example")
        let config = try await SiteWebConfiguration.make(store: store)
        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 400), configuration: config)
        let policy = SiteNavigationPolicy(root: site.root)
        wv.navigationDelegate = policy
        wv.load(URLRequest(url: URL(string: "meshsite://\(site.root)/")!))
        var state: [String: Any] = [:]
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 500_000_000)
            if let s = try? await wv.evaluateJavaScript("({h1: document.querySelector('h1')?.textContent, ok: document.querySelector('h1')?.dataset.ok, color: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).color : null})") as? [String: Any],
               s["ok"] as? String == "1" {
                state = s
                break
            }
        }
        XCTAssertEqual(state["h1"] as? String, "Hello from the mesh")
        XCTAssertEqual(state["ok"] as? String, "1", "js/app.js (3 chunks) did not run")
        XCTAssertEqual(state["color"] as? String, "rgb(0, 170, 119)", "css/site.css did not apply")
        _ = policy
    }
}
