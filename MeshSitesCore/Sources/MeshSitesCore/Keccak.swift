/// Keccak-256 (the original Keccak padding used by Ethereum, not NIST SHA3-256).
public enum Keccak {
    private static let rc: [UInt64] = [
        0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
        0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
        0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
        0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
        0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
        0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    ]
    // Rotation offsets r[x + 5y].
    private static let rot: [UInt64] = [
        0, 1, 62, 28, 27,
        36, 44, 6, 55, 20,
        3, 10, 43, 25, 39,
        41, 45, 15, 21, 8,
        18, 2, 61, 56, 14,
    ]

    @inline(__always) private static func rotl(_ x: UInt64, _ n: UInt64) -> UInt64 {
        n == 0 ? x : (x << n) | (x >> (64 - n))
    }

    private static func f1600(_ a: inout [UInt64]) {
        var b = [UInt64](repeating: 0, count: 25)
        var c = [UInt64](repeating: 0, count: 5)
        for round in 0..<24 {
            for x in 0..<5 { c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] }
            for x in 0..<5 {
                let d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
                for y in 0..<5 { a[x + 5 * y] ^= d }
            }
            // rho + pi: B[y, 2x+3y] = rot(A[x, y], r[x, y])
            for x in 0..<5 {
                for y in 0..<5 {
                    b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], rot[x + 5 * y])
                }
            }
            for x in 0..<5 {
                for y in 0..<5 {
                    a[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & b[(x + 2) % 5 + 5 * y])
                }
            }
            a[0] ^= rc[round]
        }
    }

    public static func hash256(_ input: Bytes) -> Bytes {
        let rate = 136
        var state = [UInt64](repeating: 0, count: 25)
        var msg = input
        msg.append(0x01)
        while msg.count % rate != 0 { msg.append(0) }
        msg[msg.count - 1] |= 0x80
        var off = 0
        while off < msg.count {
            for i in 0..<(rate / 8) {
                var lane: UInt64 = 0
                for k in 0..<8 { lane |= UInt64(msg[off + 8 * i + k]) << (8 * UInt64(k)) }
                state[i] ^= lane
            }
            f1600(&state)
            off += rate
        }
        var out = Bytes()
        for i in 0..<4 {
            for k in 0..<8 { out.append(UInt8((state[i] >> (8 * UInt64(k))) & 0xff)) }
        }
        return out
    }
}
