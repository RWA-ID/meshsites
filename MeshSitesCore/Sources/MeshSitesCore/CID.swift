/// Mirrors protocol/ts/src/limits.ts. SPEC §2.
public enum Limits {
    public static let chunkSize = 16 * 1024
    public static let maxBlockBytes = 32 * 1024
    public static let maxSiteBytes = 1024 * 1024
    public static let maxLogicalBytes = 4 * 1024 * 1024
    public static let maxFutureSkewSec: Int64 = 300
}

public enum Codec {
    public static let raw: UInt64 = 0x55
    public static let dagPB: UInt64 = 0x70
    public static let sha2_256: UInt64 = 0x12
}

/// A content identifier. Only the parts MeshSites needs: v0 (implicit dag-pb +
/// sha2-256, base58 "Qm…") and v1 (base32 "b…" string form).
public struct CID: Hashable, CustomStringConvertible {
    public let version: Int
    public let codec: UInt64
    public let hashCode: UInt64
    public let digest: Bytes

    public init(version: Int, codec: UInt64, hashCode: UInt64, digest: Bytes) {
        self.version = version
        self.codec = codec
        self.hashCode = hashCode
        self.digest = digest
    }

    public var multihash: Bytes { Varint.encode(hashCode) + Varint.encode(UInt64(digest.count)) + digest }

    public var bytes: Bytes {
        version == 0 ? multihash : Varint.encode(1) + Varint.encode(codec) + multihash
    }

    /// Canonical string: base58btc for v0, "b" + base32 for v1 (what multiformats prints).
    public var description: String {
        version == 0 ? Base58.encode(multihash) : "b" + Base32.encode(bytes)
    }

    /// Decode a CID at the start of `b`, advancing `i`.
    public static func decodeFirst(_ b: Bytes, _ i: inout Int) throws -> CID {
        if i + 1 < b.count && b[i] == 0x12 && b[i + 1] == 0x20 {
            guard i + 34 <= b.count else { throw DecodeError("truncated CIDv0") }
            let d = Array(b[(i + 2)..<(i + 34)])
            i += 34
            return CID(version: 0, codec: Codec.dagPB, hashCode: Codec.sha2_256, digest: d)
        }
        let version = try Varint.read(b, &i)
        guard version == 1 else { throw DecodeError("unsupported CID version \(version)") }
        let codec = try Varint.read(b, &i)
        let code = try Varint.read(b, &i)
        let len = try Varint.read(b, &i)
        guard len <= 128, i + Int(len) <= b.count else { throw DecodeError("truncated multihash") }
        let d = Array(b[i..<(i + Int(len))])
        i += Int(len)
        return CID(version: 1, codec: codec, hashCode: code, digest: d)
    }

    /// Decode a CID that must occupy all of `b`.
    public static func decode(_ b: Bytes) throws -> CID {
        var i = 0
        let c = try decodeFirst(b, &i)
        guard i == b.count else { throw DecodeError("trailing bytes after CID") }
        return c
    }

    /// Parse the canonical string forms ("Qm…" v0, "b…" v1).
    public static func parse(_ s: String) throws -> CID {
        if s.hasPrefix("Qm") {
            let b = try Base58.decode(s)
            guard b.count == 34, b[0] == 0x12, b[1] == 0x20 else { throw DecodeError("not a CIDv0") }
            return CID(version: 0, codec: Codec.dagPB, hashCode: Codec.sha2_256, digest: Array(b[2...]))
        }
        guard s.hasPrefix("b") else { throw DecodeError("unsupported multibase") }
        let c = try decode(Base32.decode(String(s.dropFirst())))
        guard c.version == 1 else { throw DecodeError("not a CIDv1") }
        return c
    }
}
