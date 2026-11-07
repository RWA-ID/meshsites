import CryptoKit
import Foundation

public typealias Bytes = [UInt8]

public enum Hex {
    public static func encode<S: Sequence>(_ b: S) -> String where S.Element == UInt8 {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        for x in b {
            out.append(digits[Int(x >> 4)])
            out.append(digits[Int(x & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Decode hex (no 0x prefix). Returns nil on odd length or a non-hex character.
    public static func decode(_ s: String) -> Bytes? {
        let u = Array(s.utf8)
        guard u.count % 2 == 0 else { return nil }
        func v(_ c: UInt8) -> UInt8? {
            switch c {
            case 0x30...0x39: return c - 0x30
            case 0x61...0x66: return c - 0x61 + 10
            case 0x41...0x46: return c - 0x41 + 10
            default: return nil
            }
        }
        var out = Bytes()
        out.reserveCapacity(u.count / 2)
        var i = 0
        while i < u.count {
            guard let hi = v(u[i]), let lo = v(u[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }
}

public func sha256(_ b: Bytes) -> Bytes { Array(SHA256.hash(data: b)) }

public struct DecodeError: Error, CustomStringConvertible, Equatable {
    public let description: String
    public init(_ d: String) { description = d }
}

/// Unsigned LEB128 varints, as used by multiformats, CAR and protobuf.
public enum Varint {
    public static func encode(_ v: UInt64) -> Bytes {
        var v = v
        var out = Bytes()
        repeat {
            var byte = UInt8(v & 0x7f)
            v >>= 7
            if v != 0 { byte |= 0x80 }
            out.append(byte)
        } while v != 0
        return out
    }

    /// Reads a minimally-encoded varint (max 9 bytes / 63 bits) at `i`, advancing it.
    public static func read(_ b: Bytes, _ i: inout Int) throws -> UInt64 {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        let start = i
        while true {
            guard i < b.count else { throw DecodeError("truncated varint") }
            let byte = b[i]
            i += 1
            if shift == 63 && byte > 0 { throw DecodeError("varint too large") }
            result |= UInt64(byte & 0x7f) << shift
            if byte & 0x80 == 0 {
                if byte == 0 && i - start > 1 { throw DecodeError("non-minimal varint") }
                return result
            }
            shift += 7
            if shift > 63 { throw DecodeError("varint too large") }
        }
    }
}

/// RFC 4648 base32, lowercase, no padding (multibase "b").
public enum Base32 {
    static let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567".utf8)

    public static func encode(_ b: Bytes) -> String {
        var out = [UInt8]()
        var buffer: UInt32 = 0
        var bits = 0
        for x in b {
            buffer = (buffer << 8) | UInt32(x)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[Int((buffer >> UInt32(bits - 5)) & 31)])
                bits -= 5
            }
        }
        if bits > 0 { out.append(alphabet[Int((buffer << UInt32(5 - bits)) & 31)]) }
        return String(decoding: out, as: UTF8.self)
    }

    /// Strict like multiformats: rejects foreign characters and non-zero leftover bits.
    public static func decode(_ s: String) throws -> Bytes {
        var lookup = [UInt8: UInt32]()
        for (i, c) in alphabet.enumerated() { lookup[c] = UInt32(i) }
        var out = Bytes()
        var buffer: UInt32 = 0
        var bits = 0
        for c in s.utf8 {
            guard let v = lookup[c] else { throw DecodeError("invalid base32 character") }
            buffer = (buffer << 5) | v
            bits += 5
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((buffer >> UInt32(bits)) & 0xff))
            }
            buffer &= (1 << UInt32(bits)) - 1
        }
        if bits >= 5 || buffer != 0 { throw DecodeError("unexpected end of base32 data") }
        return out
    }
}

/// Bitcoin base58 (multibase "z", and CIDv0 strings).
public enum Base58 {
    static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)

    public static func encode(_ b: Bytes) -> String {
        let zeros = b.prefix { $0 == 0 }.count
        var digits = [UInt8]() // base58 digits, little-endian
        for x in b {
            var carry = Int(x)
            for j in 0..<digits.count {
                carry += Int(digits[j]) << 8
                digits[j] = UInt8(carry % 58)
                carry /= 58
            }
            while carry > 0 {
                digits.append(UInt8(carry % 58))
                carry /= 58
            }
        }
        let out = [UInt8](repeating: alphabet[0], count: zeros) + digits.reversed().map { alphabet[Int($0)] }
        return String(decoding: out, as: UTF8.self)
    }

    public static func decode(_ s: String) throws -> Bytes {
        var lookup = [UInt8: Int]()
        for (i, c) in alphabet.enumerated() { lookup[c] = i }
        let chars = Array(s.utf8)
        let zeros = chars.prefix { $0 == alphabet[0] }.count
        var bytes = [UInt8]() // little-endian
        for c in chars {
            guard var carry = lookup[c] else { throw DecodeError("invalid base58 character") }
            for j in 0..<bytes.count {
                carry += Int(bytes[j]) * 58
                bytes[j] = UInt8(carry & 0xff)
                carry >>= 8
            }
            while carry > 0 {
                bytes.append(UInt8(carry & 0xff))
                carry >>= 8
            }
        }
        return [UInt8](repeating: 0, count: zeros) + bytes.reversed()
    }
}
