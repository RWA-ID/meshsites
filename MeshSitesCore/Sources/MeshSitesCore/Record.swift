import Foundation
import libsecp256k1

/// Signed ENS → CID NAME_RECORD (SPEC §4). Mirrors record.ts, including the
/// order of checks and the rejection reasons.
public enum RecordStatus: String {
    /// Signature valid and the signer is the trusted one for this name.
    case verified
    /// Signature valid, but no trusted signer is known for this name.
    case unverified
}

public enum RecordRejection: String, Error {
    case malformed = "malformed"
    case badSignature = "bad-signature"
    case signerMismatch = "signer-mismatch"
    case notAuthorized = "not-authorized"
    case staleSeq = "stale-seq"
    case futureTs = "future-ts"
}

public struct NameRecord: Equatable {
    public let name: String
    public let cid: CID
    public let origCid: CID
    public let seq: Int64
    public let ts: Int64
    /// Lowercase 0x-hex.
    public let signer: String
}

public enum RecordVerification {
    case ok(status: RecordStatus, record: NameRecord, signer: String)
    case rejected(RecordRejection, detail: String)
}

public enum Records {
    // MARK: secp256k1 via the C library

    /// Created once; a NONE context supports recovery and key derivation.
    private static let ctx: OpaquePointer = secp256k1_context_create(UInt32(1))!

    /// secp256k1 group order n, halved (low-s bound), big-endian.
    private static let halfOrder: Bytes = Hex.decode("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0")!

    public static func address(fromUncompressedPublicKey pub: Bytes) -> String {
        "0x" + Hex.encode(Keccak.hash256(Array(pub.dropFirst()))[12...])
    }

    /// For gateways/publishers that hold a delegate key. Nil for an invalid key.
    public static func address(fromPrivateKey key: Bytes) -> String? {
        guard key.count == 32 else { return nil }
        var pubkey = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_create(ctx, &pubkey, key) == 1 else { return nil }
        return serialize(&pubkey).map(address(fromUncompressedPublicKey:))
    }

    private static func serialize(_ pubkey: inout secp256k1_pubkey) -> Bytes? {
        var out = Bytes(repeating: 0, count: 65)
        var len = 65
        guard secp256k1_ec_pubkey_serialize(ctx, &out, &len, &pubkey, UInt32(2)) == 1, len == 65 else { return nil }
        return out
    }

    /// keccak256("\x19Ethereum Signed Message:\n" + byteLength + message).
    public static func eip191Hash(_ message: Bytes) -> Bytes {
        Keccak.hash256(Array("\u{19}Ethereum Signed Message:\n\(message.count)".utf8) + message)
    }

    /// Recover the address behind an Ethereum personal_sign signature
    /// (0x + r + s + v). Every failure is a thrown rejection, never a crash.
    public static func recoverSigner(message: Bytes, signature sig: String) throws -> String {
        let hexPart = sig.hasPrefix("0x") ? String(sig.dropFirst(2)) : ""
        guard hexPart.utf8.count == 130, let b = Hex.decode(hexPart) else { throw RecordError("sig must be 65 bytes of hex") }
        var v = b[64]
        if v >= 27 { v -= 27 }
        guard v == 0 || v == 1 else { throw RecordError("bad recovery byte \(b[64])") }
        let s = Array(b[32..<64])
        // Low-s only: 0 < s <= n/2 (both 32-byte big-endian, so byte order = numeric order).
        guard s.contains(where: { $0 != 0 }), !halfOrder.lexicographicallyPrecedes(s) else {
            throw RecordError("signature s is not low-s")
        }
        var rsig = secp256k1_ecdsa_recoverable_signature()
        guard secp256k1_ecdsa_recoverable_signature_parse_compact(ctx, &rsig, Array(b[0..<64]), Int32(v)) == 1 else {
            throw RecordError("signature r/s out of range")
        }
        var pubkey = secp256k1_pubkey()
        guard secp256k1_ecdsa_recover(ctx, &pubkey, &rsig, eip191Hash(message)) == 1, let pub = serialize(&pubkey) else {
            throw RecordError("public key recovery failed")
        }
        return address(fromUncompressedPublicKey: pub)
    }

    struct RecordError: Error, CustomStringConvertible {
        let description: String
        init(_ d: String) { description = d }
    }

    // MARK: well-formedness

    /// An approximation of ENSIP-15 normalization: lowercase, NFC, non-empty
    /// labels, ASCII limited to [a-z0-9_-] with "_" only leading and no "--"
    /// at positions 3-4. Full ENSIP-15 (UTS-46 mapping, emoji sequences,
    /// confusables) is not implemented in Swift yet; see docs/decisions.md D10.
    public static func isNormalizedName(_ name: String) -> Bool {
        guard name == name.precomposedStringWithCanonicalMapping, name == name.lowercased(), name.contains(".") else { return false }
        for label in name.split(separator: ".", omittingEmptySubsequences: false) {
            guard !label.isEmpty else { return false }
            let scalars = Array(label.unicodeScalars)
            for (i, u) in scalars.enumerated() {
                if u.value < 0x80 {
                    let ok = (u >= "a" && u <= "z") || (u >= "0" && u <= "9") || u == "-" || (u == "_" && scalars[0..<i].allSatisfy { $0 == "_" })
                    if !ok { return false }
                } else if u.properties.isWhitespace || u.properties.generalCategory == .control || u.properties.generalCategory == .format {
                    return false
                }
            }
            if scalars.count >= 4, scalars[2] == "-", scalars[3] == "-", scalars.allSatisfy({ $0.isASCII }) { return false }
        }
        return true
    }

    static let keys = ["cid", "name", "origCid", "seq", "signer", "ts", "v"]

    /// Parse and check a record object (SPEC §4.1). Throws RecordError with the reason.
    public static func wellFormed(_ r: JSON) throws -> NameRecord {
        guard let o = r.object else { throw RecordError("record is not an object") }
        guard o.keys.sorted() == keys else { throw RecordError("record keys must be exactly \(keys.joined(separator: ","))") }
        guard o["v"] == .int(1) else { throw RecordError("v must be 1") }
        guard let name = o["name"]?.string else { throw RecordError("name must be a string") }
        guard isNormalizedName(name) else { throw RecordError("name must be ENSIP-15 normalized") }
        func cid(_ k: String) throws -> CID {
            guard let s = o[k]?.string else { throw RecordError("\(k) must be a string") }
            guard let c = try? CID.parse(s) else { throw RecordError("\(k) is not a CID") }
            guard c.description == s else { throw RecordError("\(k) must be in canonical string form (\(c))") }
            return c
        }
        let c = try cid("cid")
        let orig = try cid("origCid")
        guard c.version == 1 else { throw RecordError("cid must be CIDv1") }
        func nonNeg(_ k: String) throws -> Int64 {
            guard let n = o[k]?.int, n >= 0, n <= maxSafeInteger else { throw RecordError("\(k) must be a non-negative integer") }
            return n
        }
        let seq = try nonNeg("seq")
        let ts = try nonNeg("ts")
        guard let signer = o["signer"]?.string, signer.utf8.count == 42, signer.hasPrefix("0x"),
              signer.dropFirst(2).utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }) else {
            throw RecordError("signer must be a lowercase 0x address")
        }
        return NameRecord(name: name, cid: c, origCid: orig, seq: seq, ts: ts, signer: signer)
    }

    /// The exact bytes that are signed (before the EIP-191 prefix).
    public static func message(_ record: JSON) throws -> Bytes {
        _ = try wellFormed(record)
        return Array(try record.canonical().utf8)
    }

    // MARK: verification (SPEC §4.3)

    public static func verify(_ signed: JSON, expectedSigner: String? = nil, cachedSeq: Int64? = nil, now: Int64 = Int64(Date().timeIntervalSince1970)) -> RecordVerification {
        guard let o = signed.object else { return .rejected(.malformed, detail: "not an object") }
        guard o.keys.sorted() == ["record", "sig"], let rec = o["record"] else { return .rejected(.malformed, detail: "keys must be exactly record,sig") }
        let record: NameRecord
        do { record = try wellFormed(rec) } catch { return .rejected(.malformed, detail: "\(error)") }
        guard let sig = o["sig"]?.string else { return .rejected(.malformed, detail: "sig must be a string") }
        let recovered: String
        do {
            recovered = try recoverSigner(message: message(rec), signature: sig)
        } catch {
            return .rejected(.badSignature, detail: "\(error)")
        }
        guard recovered == record.signer else { return .rejected(.signerMismatch, detail: "signature is from \(recovered), record says \(record.signer)") }
        if record.ts > now + Limits.maxFutureSkewSec { return .rejected(.futureTs, detail: "ts \(record.ts) is ahead of now \(now)") }
        if let c = cachedSeq, record.seq <= c { return .rejected(.staleSeq, detail: "seq \(record.seq) is not newer than cached \(c)") }
        if let e = expectedSigner {
            guard e.lowercased() == record.signer else { return .rejected(.notAuthorized, detail: "\(record.signer) is not the trusted signer \(e.lowercased())") }
            return .ok(status: .verified, record: record, signer: recovered)
        }
        return .ok(status: .unverified, record: record, signer: recovered)
    }
}
