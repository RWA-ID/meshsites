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
        /// Peers whose BLOCK replies get one byte flipped (a hostile seeder).
        var corrupting: Set<Data> = []
        /// Extra delay for everything a peer sends (to order HAVEs deterministically).
        var delay: [Data: TimeInterval] = [:]
        func deliverDirect(_ payload: Data, to peer: Data, from sender: Data) {
            var p = payload
            if corrupting.contains(sender), Wire.decodeSubtype(p) == Wire.Sub.block, p.count > 8 { p[p.count - 1] ^= 0xff }
            nodes[peer]?.receiveDirect(payload: p, from: sender)
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
            let d = link?.delay[me] ?? 0
            DispatchQueue.global().asyncAfter(deadline: .now() + d) { link?.deliver(payload, ttl: ttl, recipient: recipient, from: me, sign: sign) }
        }, sendDirect: { [weak link] payload, peer in
            let d = link?.delay[me] ?? 0
            DispatchQueue.global().asyncAfter(deadline: .now() + d) { link?.deliverDirect(payload, to: peer, from: me) }
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

    func testDownloadsASiteFromANeighbour() throws {
        let link = Link()
        let a = try makeNode("a1a1a1a1a1a1a1a1", link: link, seeding: true, sites: ["site-basic.car"])
        let b = try makeNode("b2b2b2b2b2b2b2b2", link: link, seeding: false)
        let root = try XCTUnwrap(a.store.sites.first?.root)
        waitFor("attached") { a.attached && b.attached }
        b.download(root: root)
        waitFor("B finished", timeout: 15) { b.downloads[root]?.phase == .done }
        XCTAssertTrue(b.store.sites.contains { $0.root == root })
        let d = try XCTUnwrap(b.downloads[root])
        XCTAssertEqual(d.phase, .done)
        XCTAssertEqual(d.blocks, a.store.sites.first?.blockCount)
        XCTAssertEqual(d.peer, "a1a1a1a1a1a1a1a1")
        // The stored copy renders like an imported one.
        XCTAssertNoThrow(try b.store.source(for: root))
    }

    func testCorruptSeederIsSkipped() throws {
        let link = Link()
        let evil = try makeNode("e0e0e0e0e0e0e0e0", link: link, seeding: true, sites: ["site-basic.car"])
        let good = try makeNode("a1a1a1a1a1a1a1a1", link: link, seeding: true, sites: ["site-basic.car"])
        let b = try makeNode("b2b2b2b2b2b2b2b2", link: link, seeding: false)
        link.corrupting = [Data(Hex.decode("e0e0e0e0e0e0e0e0")!)]
        link.delay[Data(Hex.decode("a1a1a1a1a1a1a1a1")!)] = 0.3 // Evil's HAVE arrives first, so Evil is asked first
        let root = try XCTUnwrap(good.store.sites.first?.root)
        waitFor("attached") { evil.attached && good.attached && b.attached }
        b.download(root: root)
        waitFor("B stored the site", timeout: 20) { b.store.sites.contains { $0.root == root } }
        XCTAssertEqual(b.downloads[root]?.peer, "a1a1a1a1a1a1a1a1", "finished from the honest seeder")
        XCTAssertTrue(b.log.contains { $0.contains("rejected a block from e0e0e0") }, "the corrupt block was rejected: \(b.log)")
    }

    func testDownloadWithNoHolderFails() throws {
        let link = Link()
        let b = try makeNode("b2b2b2b2b2b2b2b2", link: link, seeding: false)
        waitFor("attached") { b.attached }
        let root = "bafybeid4yps7awrai7spe7wdnz6d5lvsgs2fa62xc3c2blsavaafryhj7u"
        b.download(root: root)
        waitFor("download gives up", timeout: 8) { b.downloads[root]?.phase == .failed }
        XCTAssertEqual(b.downloads[root]?.error, "nobody nearby has it")
    }

    func testUnattachedServiceBehavesLikeAnUnpatchedNode() {
        let svc = MeshSitesService(store: SiteStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
        XCTAssertTrue(svc.receive(payload: Data([0x01]), sender: Data(count: 8), recipient: nil, ttl: 9, authenticated: false))
    }
}
