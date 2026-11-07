// `swift run meshsites-vectors [path/to/protocol/vectors]`
// `swift run meshsites-vectors --fuzz [iterations]`
// Stopgap for `swift test` on machines with only the Command Line Tools
// (no XCTest/Testing). Exit code 0 only if every check passes.
import Foundation
import MeshSitesCore
import MeshSitesVectors

func fuzz(_ iterations: Int) -> Int32 {
    // Random and mutated inputs through every decoder that sees peer data.
    // Passing = the process is still alive at the end (a trap would kill it).
    var rng = SystemRandomNumberGenerator()
    func randomBytes(_ max: Int) -> Bytes { (0..<Int.random(in: 0...max, using: &rng)).map { _ in UInt8.random(in: 0...255, using: &rng) } }
    let seedCar = (try? Data(contentsOf: VectorRunner.defaultVectorsDir.appendingPathComponent("site-basic.car"))).map { Array($0) } ?? []
    var recovered = 0, rejected = 0
    for n in 0..<iterations {
        let b = randomBytes(400)
        _ = try? Wire.decode(b)
        _ = try? Wire.decode([1, UInt8.random(in: 0...0x12, using: &rng)] + b)
        _ = try? PBNode.decode(b)
        _ = try? UnixFSData.decode(b)
        _ = try? JSON.parse(b)
        _ = try? CID.decode(b)
        _ = Verify.verifyCar(b)
        if !seedCar.isEmpty, n % 10 == 0 {
            // Flip a few bytes of a real CAR: exercises the deeper parsing paths.
            var m = seedCar
            for _ in 0..<Int.random(in: 1...4, using: &rng) { m[Int.random(in: 0..<m.count, using: &rng)] ^= UInt8.random(in: 1...255, using: &rng) }
            _ = Verify.verifyCar(m)
        }
        // Signatures with random r (about half are not curve x-coordinates),
        // low s, and both recovery ids. P256K's wrapper would fatalError here.
        var sig = randomBytes(0) + (0..<32).map { _ in UInt8.random(in: 0...255, using: &rng) }
        sig += [0] + (0..<31).map { _ in UInt8.random(in: 0...255, using: &rng) }
        sig.append(UInt8.random(in: 27...28, using: &rng))
        if (try? Records.recoverSigner(message: b, signature: "0x" + Hex.encode(sig))) != nil { recovered += 1 } else { rejected += 1 }
    }
    print("fuzz: \(iterations) iterations, no crash. random signatures: \(recovered) recovered, \(rejected) rejected cleanly")
    return rejected > 0 && recovered > 0 ? 0 : 1
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "--fuzz" {
    exit(fuzz(args.count > 1 ? Int(args[1]) ?? 5000 : 5000))
}
let dir = args.first.map { URL(fileURLWithPath: $0) } ?? VectorRunner.defaultVectorsDir
let checks = VectorRunner.runAll(vectorsDir: dir)
for c in checks where !c.passed { print("FAIL  \(c.name)\n      \(c.detail)") }
let failed = checks.filter { !$0.passed }.count
print("\(checks.count - failed)/\(checks.count) vector checks passed")
exit(failed == 0 && !checks.isEmpty ? 0 : 1)
