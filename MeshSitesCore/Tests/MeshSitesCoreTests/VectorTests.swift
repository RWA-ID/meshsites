import XCTest
import MeshSitesCore
import MeshSitesVectors

/// Runs once Xcode is installed (`swift test`). Same checks as `meshsites-vectors`.
final class VectorTests: XCTestCase {
    func testAllSharedVectors() {
        let checks = VectorRunner.runAll()
        XCTAssertGreaterThan(checks.count, 50)
        for c in checks { XCTAssertTrue(c.passed, "\(c.name): \(c.detail)") }
    }

    func testGarbageNeverCrashes() {
        // Random bytes through every untrusted decoder: must throw or reject, never trap.
        var rng = SystemRandomNumberGenerator()
        for _ in 0..<2000 {
            let b = (0..<Int.random(in: 0..<300, using: &rng)).map { _ in UInt8.random(in: 0...255, using: &rng) }
            _ = try? Wire.decode(b)
            _ = Verify.verifyCar(b)
            _ = try? PBNode.decode(b)
            _ = try? JSON.parse(b)
            _ = try? Records.recoverSigner(message: b, signature: "0x" + Hex.encode((b + Bytes(repeating: 1, count: 65)).prefix(65)))
        }
    }
}
