import XCTest
import MeshSitesCore

final class AddressTests: XCTestCase {
    let mesh = "bafybeid4yps7awrai7spe7wdnz6d5lvsgs2fa62xc3c2blsavaafryhj7u"
    let v0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"

    func cid(_ s: String, _ path: String = "/") -> SiteAddress { .cid(try! CID.parse(s), path: path) }

    func testCIDForms() {
        XCTAssertEqual(SiteAddress.parse(mesh), cid(mesh))
        XCTAssertEqual(SiteAddress.parse("  \(mesh)\n"), cid(mesh))
        XCTAssertEqual(SiteAddress.parse("ipfs://\(mesh)"), cid(mesh))
        XCTAssertEqual(SiteAddress.parse("ipfs://\(mesh)/docs/a.html"), cid(mesh, "/docs/a.html"))
        XCTAssertEqual(SiteAddress.parse("IPFS://\(mesh)/"), cid(mesh))
        XCTAssertEqual(SiteAddress.parse("meshsite://\(mesh)/x/"), cid(mesh, "/x/"))
        XCTAssertEqual(SiteAddress.parse("/ipfs/\(mesh)"), cid(mesh))
        XCTAssertEqual(SiteAddress.parse("/ipfs/\(mesh)/a/b.html"), cid(mesh, "/a/b.html"))
        XCTAssertEqual(SiteAddress.parse("\(mesh)/about.html"), cid(mesh, "/about.html"))
        XCTAssertEqual(SiteAddress.parse(v0), cid(v0))
    }

    func testGatewayURLs() {
        XCTAssertEqual(SiteAddress.parse("https://ipfs.io/ipfs/\(mesh)/a.html?x=1#top"), cid(mesh, "/a.html"))
        XCTAssertEqual(SiteAddress.parse("https://\(mesh).ipfs.dweb.link/a.html"), cid(mesh, "/a.html"))
        XCTAssertEqual(SiteAddress.parse("http://127.0.0.1:8080/ipfs/\(mesh)"), cid(mesh))
        XCTAssertEqual(SiteAddress.parse("https://example.com/ipns/meshsites.eth/a"), .name("meshsites.eth", path: "/a"))
        XCTAssertNil(SiteAddress.parse("https://example.com/"))
        XCTAssertNil(SiteAddress.parse("https://example.com/ipfs/notacid"))
    }

    func testNames() {
        XCTAssertEqual(SiteAddress.parse("meshsites.eth"), .name("meshsites.eth", path: "/"))
        XCTAssertEqual(SiteAddress.parse("MeshSites.ETH/page.html"), .name("meshsites.eth", path: "/page.html"))
        XCTAssertEqual(SiteAddress.parse("docs.meshsites.eth"), .name("docs.meshsites.eth", path: "/"))
        XCTAssertEqual(SiteAddress.parse("https://meshsites.eth.limo/page.html"), .name("meshsites.eth", path: "/page.html"))
        XCTAssertEqual(SiteAddress.parse("https://meshsites.eth.link"), .name("meshsites.eth", path: "/"))
        XCTAssertEqual(SiteAddress.parse("ipns://meshsites.eth"), .name("meshsites.eth", path: "/"))
        XCTAssertEqual(SiteAddress.parse("/ipns/meshsites.eth/"), .name("meshsites.eth", path: "/"))
        XCTAssertEqual(SiteAddress.parse("http://meshsites.eth/"), .name("meshsites.eth", path: "/"))
    }

    func testPathsCannotClimbOut() {
        XCTAssertEqual(SiteAddress.parse("meshsites.eth/../../etc"), .name("meshsites.eth", path: "/etc"))
        XCTAssertEqual(SiteAddress.parse("ipfs://\(mesh)//a/./b/../c"), cid(mesh, "/a/c"))
    }

    func testRejects() {
        for bad in ["", "   ", "hello", "example.com", "https://example.com", ".eth", "a..eth", "meshsites.eth extra",
                    "ftp://\(mesh)", "bafynotreallyacid", "ipfs://", "/ipfs/", "javascript:alert(1)", "file:///etc/passwd",
                    "ipns://example.com", "me$h.eth"] {
            XCTAssertNil(SiteAddress.parse(bad), bad)
        }
    }
}
