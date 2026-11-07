import XCTest
@testable import MeshSitesKit
import MeshSitesCore

/// Two services wired back to back through an in-memory "radio", the way
/// bitchat wires one: packets go out through `Transport.send` and come in
/// through `receive(...)`, whose return value is bitchat's relay decision.
@MainActor
final class MeshSitesServiceTests: XCTestCase {
    static var vectors: URL { OfflineWebViewTests.vectors }

    final class Link {
        var nodes: [Data: MeshSitesService] = [:]
        private let lock = NSLock()
        private var _relayed: [(from: Data, relay: Bool, sub: UInt8?)] = []
        var relayed: [(from: Data, relay: Bool, sub: UInt8?)] { lock.lock(); defer { lock.unlock() }; return _relayed }
        /// Deliver to every other node, one hop away.
        func deliver(_ payload: Data, ttl: UInt8, recipient: Data?, from sender: Data, sign: Bool) {
            for (id, node) in nodes where id != sender {
                let relay = node.receive(payload: payload, sender: sender, recipient: recipient, ttl: ttl, authenticated: sign)
                lock.lock(); _relayed.append((id, relay, Wire.decodeSubtype(payload))); lock.unlock()
            }
        }
    }

    func makeNode(_ id: String, link: Link, seeding: Bool, sites: [String] = []) throws -> MeshSitesService {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("meshsites-svc-\(id)-\(UUID().uuidString)")
        let store = SiteStore(directory: dir)
        for f in sites { _ = try store.importCar(at: Self.vectors.appendingPathComponent(f), label: f) }
        let svc = MeshSitesService(store: store)
        svc.seeding = seeding
        let me = Data(Hex.decode(id)!)
        link.nodes[me] = svc
        svc.attach(.init(selfID: { me }, send: { [weak link] payload, ttl, recipient, sign in
            // Async, like bitchat's message queue: never re-enters the sender's queue.
            DispatchQueue.global().async { link?.deliver(payload, ttl: ttl, recipient: recipient, from: me, sign: sign) }
        }))
        return svc
    }

    func waitFor(_ what: String, timeout: TimeInterval = 10, _ cond: @escaping () -> Bool) {
        let e = expectation(description: what)
        let t = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { t in if cond() { t.invalidate(); e.fulfill() } }
        wait(for: [e], timeout: timeout)
        t.invalidate()
    }

    override func setUp() {
        UserDefaults.standard.removeObject(forKey: "meshsites.seeding")
    }

    func testAnnounceThenProbeFindsTheHolder() throws {
        let link = Link()
        let a = try makeNode("a1a1a1a1a1a1a1a1", link: link, seeding: true, sites: ["site-basic.car"])
        let b = try makeNode("b2b2b2b2b2b2b2b2", link: link, seeding: false)
        let root = try XCTUnwrap(a.store.sites.first?.root)

        // A announces a few seconds after attaching; B lists the site as nearby.
        waitFor("B hears A's ANNOUNCE") { b.nearby.contains { $0.root == root && $0.nearestHops == 1 && !$0.stored } }

        // B asks who has it; A answers with a directed HAVE.
        b.probe(root: root)
        waitFor("B gets A's HAVE") { b.holders[root]?.first?.peer == "a1a1a1a1a1a1a1a1" }
        let h = try XCTUnwrap(b.holders[root]?.first)
        XCTAssertEqual(h.hops, 1)
        XCTAssertEqual(h.blockCount, a.store.sites.first?.blockCount)

        // The HAVE addressed to B is consumed by B, not relayed onwards.
        XCTAssertTrue(link.relayed.contains { $0.from == Data(Hex.decode("b2b2b2b2b2b2b2b2")!) && $0.sub == Wire.Sub.have && !$0.relay })
    }

    func testNotSeedingNeverAnswers() throws {
        let link = Link()
        let a = try makeNode("a1a1a1a1a1a1a1a1", link: link, seeding: false, sites: ["site-basic.car"])
        let b = try makeNode("b2b2b2b2b2b2b2b2", link: link, seeding: false)
        let root = try XCTUnwrap(a.store.sites.first?.root)
        b.probe(root: root)
        waitFor("probe window closes", timeout: 6) { !b.probing.contains(root) && b.holders[root] != nil }
        XCTAssertEqual(b.holders[root], [])
        XCTAssertTrue(b.nearby.isEmpty, "a node with seeding off must not announce")
    }

    func testForgedTtlIsNotRelayed() throws {
        let link = Link()
        let a = try makeNode("a1a1a1a1a1a1a1a1", link: link, seeding: false)
        waitFor("attached") { a.attached }
        let root = try CID.parse("bafkreihzaauexlawvjv5ieuwx6taubz5dsymgtnr6qteu2kxqtspn5rjfe")
        let announce = Data(try Wire.encode(.announce(sites: [.init(root: root, sizeBytes: 5, blockCount: 1)])))
        let evil = Data(Hex.decode("e0e0e0e0e0e0e0e0")!)
        XCTAssertFalse(a.receive(payload: announce, sender: evil, recipient: nil, ttl: 7, authenticated: true), "TTL above the ANNOUNCE cap must not be relayed")
        XCTAssertTrue(a.receive(payload: Data([0x01, 0x77]), sender: evil, recipient: nil, ttl: 5, authenticated: true), "unknown sub-types are relayed like bitchat does")
        waitFor("spam counted") { a.spamStrikes == 1 }
    }

    func testUnattachedServiceBehavesLikeAnUnpatchedNode() {
        let svc = MeshSitesService(store: SiteStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
        XCTAssertTrue(svc.receive(payload: Data([0x01]), sender: Data(count: 8), recipient: nil, ttl: 9, authenticated: false))
    }
}
