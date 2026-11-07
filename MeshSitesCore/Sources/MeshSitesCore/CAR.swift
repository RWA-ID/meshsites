import Foundation

/// CARv1 reading (SPEC §2). The header is a tiny DAG-CBOR map
/// {"roots": [CID…], "version": 1}; only the CBOR needed for it is decoded.

indirect enum CBOR {
    case uint(UInt64), negint(UInt64), bytes(Bytes), text(String), array([CBOR]), map([(CBOR, CBOR)]), tag(UInt64, CBOR), simple(UInt8)

    static func decode(_ b: Bytes, _ i: inout Int, depth: Int = 0) throws -> CBOR {
        guard depth < 16 else { throw DecodeError("CBOR nested too deep") }
        guard i < b.count else { throw DecodeError("CBOR: unexpected end") }
        let ib = b[i]
        i += 1
        let major = ib >> 5
        let info = ib & 0x1f
        func arg() throws -> UInt64 {
            switch info {
            case 0..<24: return UInt64(info)
            case 24, 25, 26, 27:
                let n = 1 << Int(info - 24)
                guard i + n <= b.count else { throw DecodeError("CBOR: unexpected end") }
                var v: UInt64 = 0
                for k in 0..<n { v = v << 8 | UInt64(b[i + k]) }
                i += n
                return v
            default: throw DecodeError("CBOR: indefinite lengths are not allowed")
            }
        }
        switch major {
        case 0: return .uint(try arg())
        case 1: return .negint(try arg())
        case 2, 3:
            let n = try arg()
            guard n <= UInt64(b.count - i) else { throw DecodeError("CBOR: unexpected end") }
            let s = Array(b[i..<(i + Int(n))])
            i += Int(n)
            if major == 2 { return .bytes(s) }
            guard let t = String(bytes: s, encoding: .utf8) else { throw DecodeError("CBOR: invalid UTF-8") }
            return .text(t)
        case 4:
            let n = try arg()
            guard n <= 1024 else { throw DecodeError("CBOR: array too long") }
            return .array(try (0..<n).map { _ in try decode(b, &i, depth: depth + 1) })
        case 5:
            let n = try arg()
            guard n <= 64 else { throw DecodeError("CBOR: map too long") }
            return .map(try (0..<n).map { _ in (try decode(b, &i, depth: depth + 1), try decode(b, &i, depth: depth + 1)) })
        case 6: return .tag(try arg(), try decode(b, &i, depth: depth + 1))
        default:
            guard info < 24 else { throw DecodeError("CBOR: floats are not allowed in a CAR header") }
            return .simple(info)
        }
    }
}


public struct CARFile {
    public let version: UInt64
    public let roots: [CID]
    /// Blocks in file order, unverified.
    public let blocks: [(cid: CID, bytes: Bytes)]

    public static func parse(_ b: Bytes) throws -> CARFile {
        var i = 0
        let headerLen = try Varint.read(b, &i)
        guard headerLen > 0, headerLen <= UInt64(b.count - i) else { throw DecodeError("Invalid CAR header (bad length)") }
        let headerEnd = i + Int(headerLen)
        var hi = i
        let header = try CBOR.decode(Array(b[0..<headerEnd]), &hi)
        guard hi == headerEnd, case .map(let entries) = header else { throw DecodeError("Invalid CAR header format") }
        var version: UInt64?
        var roots: [CID]?
        for (k, v) in entries {
            guard case .text(let key) = k else { throw DecodeError("Invalid CAR header format") }
            switch (key, v) {
            case ("version", .uint(let n)): version = n
            case ("roots", .array(let items)):
                roots = try items.map { item in
                    guard case .tag(42, .bytes(let raw)) = item, raw.first == 0 else { throw DecodeError("Invalid CAR header format") }
                    return try CID.decode(Array(raw.dropFirst()))
                }
            default: break
            }
        }
        guard let ver = version else { throw DecodeError("Invalid CAR header format") }
        guard ver == 1 else { throw DecodeError("CAR version \(ver), need 1") }
        guard let rs = roots else { throw DecodeError("Invalid CAR header format") }

        i = headerEnd
        var blocks: [(CID, Bytes)] = []
        while i < b.count {
            let len = try Varint.read(b, &i)
            guard len > 0, len <= UInt64(b.count - i) else { throw DecodeError("Unexpected end of data") }
            let end = i + Int(len)
            var ci = i
            let cid = try CID.decodeFirst(b, &ci)
            guard ci <= end else { throw DecodeError("Unexpected end of data") }
            blocks.append((cid, Array(b[ci..<end])))
            i = end
        }
        return CARFile(version: ver, roots: rs, blocks: blocks)
    }

    /// CARv1 with one root, blocks in the given order (M4: storing a site
    /// fetched over the mesh). Same bytes as @ipld/car's writer: the header is
    /// dag-cbor {"roots": [CID], "version": 1} with keys in canonical order.
    public static func write(root: CID, blocks: [(cid: CID, bytes: Bytes)]) -> Bytes {
        func head(_ major: UInt8, _ n: Int) -> Bytes {
            switch n {
            case 0..<24: return [major << 5 | UInt8(n)]
            case 24..<256: return [major << 5 | 24, UInt8(n)]
            default: return [major << 5 | 25, UInt8(n >> 8), UInt8(n & 0xff)]
            }
        }
        let cidBytes: Bytes = [0] + root.bytes // CBOR tag 42 carries a 0x00 multibase prefix
        var header: Bytes = head(5, 2)
        header.append(contentsOf: head(3, 5))
        header.append(contentsOf: Array("roots".utf8))
        header.append(contentsOf: head(4, 1))
        header.append(contentsOf: [0xd8, 42])
        header.append(contentsOf: head(2, cidBytes.count))
        header.append(contentsOf: cidBytes)
        header.append(contentsOf: head(3, 7))
        header.append(contentsOf: Array("version".utf8))
        header.append(0x01)
        var out = Varint.encode(UInt64(header.count)) + header
        for b in blocks {
            let c = b.cid.bytes
            out += Varint.encode(UInt64(c.count + b.bytes.count)) + c + b.bytes
        }
        return out
    }
}
