import Foundation

/// MeshSites wire messages, DRAFT (pre-M3). Mirrors wire.ts; vectors in
/// protocol/vectors/wire.json.
///
/// payload = version u8 (=1) | subtype u8 | (tag u8, length u16 BE, value)*
/// Outer bitchat MessageType 0x4D for gossip, NoisePayloadType 0x4D inside a
/// direct session.
public enum Wire {
    public static let version: UInt8 = 1
    public static let messageType: UInt8 = 0x4D
    public static let noisePayloadType: UInt8 = 0x4D

    public enum Sub {
        public static let announce: UInt8 = 0x01
        public static let nameRecord: UInt8 = 0x02
        public static let want: UInt8 = 0x03
        public static let have: UInt8 = 0x04
        public static let blockReq: UInt8 = 0x10
        public static let block: UInt8 = 0x11
        public static let blockNone: UInt8 = 0x12
    }

    public static let publicSubtypes: Set<UInt8> = [Sub.announce, Sub.nameRecord, Sub.want, Sub.have]
    public static let directSubtypes: Set<UInt8> = [Sub.blockReq, Sub.block, Sub.blockNone]
    /// Originator TTLs (bitchat relays while ttl > 1, so TTL N reaches N hops).
    public enum TTL {
        public static let announce: UInt8 = 3
        public static let nameRecord: UInt8 = 7
        public static let want: UInt8 = 5
        public static let have: UInt8 = 5
    }
    public static let maxAnnounceEntries = 8
    public static let maxBlockReq = 32

    enum Tag {
        static let reqId: UInt8 = 0x01, rootCid: UInt8 = 0x02, ensName: UInt8 = 0x03, origTtl: UInt8 = 0x04
        static let hops: UInt8 = 0x05, bulk: UInt8 = 0x06, sizeBytes: UInt8 = 0x07, blockCount: UInt8 = 0x08
        static let blockCid: UInt8 = 0x09, blockBytes: UInt8 = 0x0a, site: UInt8 = 0x0b, signedRecord: UInt8 = 0x0c
        static let known: Set<UInt8> = Set(0x01...0x0c)
        static let repeatable: Set<UInt8> = [site, blockCid]
    }

    public struct SiteEntry: Equatable {
        public let root: CID
        public let sizeBytes: UInt32
        public let blockCount: UInt16
        public init(root: CID, sizeBytes: UInt32, blockCount: UInt16) { self.root = root; self.sizeBytes = sizeBytes; self.blockCount = blockCount }
    }

    public struct Bulk: Equatable {
        public let p2pWifi: Bool
        public let ble: Bool
        public init(p2pWifi: Bool, ble: Bool) { self.p2pWifi = p2pWifi; self.ble = ble }
    }

    public enum Message: Equatable {
        case announce(sites: [SiteEntry])
        case nameRecord(signed: String)
        case want(reqId: Bytes, origTtl: UInt8, root: CID?, name: String?)
        case have(reqId: Bytes, root: CID, hops: UInt8, bulk: Bulk, sizeBytes: UInt32, blockCount: UInt16)
        case blockReq(root: CID, cids: [CID])
        case block(cid: CID, bytes: Bytes)
        case blockNone(cid: CID)
    }

    public struct WireError: Error, Equatable, CustomStringConvertible {
        public let description: String
        init(_ d: String) { description = d }
    }

    // MARK: encode

    static func u16(_ v: UInt16) -> Bytes { [UInt8(v >> 8), UInt8(v & 0xff)] }
    static func u32(_ v: UInt32) -> Bytes { [UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)] }

    public static func encode(_ m: Message) throws -> Bytes {
        var out: Bytes = [version]
        func tlv(_ tag: UInt8, _ v: Bytes) throws {
            guard v.count <= 0xffff else { throw WireError("TLV \(tag) too long") }
            out += [tag] + u16(UInt16(v.count)) + v
        }
        switch m {
        case .announce(let sites):
            guard (1...maxAnnounceEntries).contains(sites.count) else { throw WireError("announce needs 1..8 sites") }
            out.append(Sub.announce)
            for s in sites { try tlv(Tag.site, u32(s.sizeBytes) + u16(s.blockCount) + s.root.bytes) }
        case .nameRecord(let signed):
            out.append(Sub.nameRecord)
            try tlv(Tag.signedRecord, Array(signed.utf8))
        case .want(let reqId, let origTtl, let root, let name):
            guard reqId.count == 8 else { throw WireError("reqId must be 8 bytes") }
            guard (root == nil) != (name == nil) else { throw WireError("want needs exactly one of root or name") }
            out.append(Sub.want)
            try tlv(Tag.reqId, reqId)
            try tlv(Tag.origTtl, [origTtl])
            if let r = root { try tlv(Tag.rootCid, r.bytes) } else { try tlv(Tag.ensName, Array(name!.utf8)) }
        case .have(let reqId, let root, let hops, let bulk, let size, let count):
            guard reqId.count == 8 else { throw WireError("reqId must be 8 bytes") }
            out.append(Sub.have)
            try tlv(Tag.reqId, reqId)
            try tlv(Tag.rootCid, root.bytes)
            try tlv(Tag.hops, [hops])
            try tlv(Tag.bulk, [(bulk.p2pWifi ? 1 : 0) | (bulk.ble ? 2 : 0)])
            try tlv(Tag.sizeBytes, u32(size))
            try tlv(Tag.blockCount, u16(count))
        case .blockReq(let root, let cids):
            guard (1...maxBlockReq).contains(cids.count) else { throw WireError("block-req needs 1..32 CIDs") }
            out.append(Sub.blockReq)
            try tlv(Tag.rootCid, root.bytes)
            for c in cids { try tlv(Tag.blockCid, c.bytes) }
        case .block(let cid, let bytes):
            out.append(Sub.block)
            try tlv(Tag.blockCid, cid.bytes)
            try tlv(Tag.blockBytes, bytes)
        case .blockNone(let cid):
            out.append(Sub.blockNone)
            try tlv(Tag.blockCid, cid.bytes)
        }
        return out
    }

    // MARK: decode

    /// nil = unknown version/sub-type (ignore, as bitchat does);
    /// throws = malformed message of a known kind (drop, count against the peer).
    public static func decode(_ b: Bytes) throws -> Message? {
        guard b.count >= 2 else { throw WireError("payload too short") }
        guard b[0] == version else { return nil }
        let sub = b[1]
        guard publicSubtypes.contains(sub) || directSubtypes.contains(sub) else { return nil }

        var t: [UInt8: [Bytes]] = [:]
        var i = 2
        while i < b.count {
            guard i + 3 <= b.count else { throw WireError("truncated TLV header") }
            let tag = b[i]
            let len = Int(b[i + 1]) << 8 | Int(b[i + 2])
            i += 3
            guard i + len <= b.count else { throw WireError("TLV \(tag) overruns payload") }
            t[tag, default: []].append(Array(b[i..<(i + len)]))
            i += len
        }
        for (tag, vals) in t where vals.count > 1 && !Tag.repeatable.contains(tag) && Tag.known.contains(tag) {
            throw WireError("tag \(tag) repeated")
        }

        func one(_ tag: UInt8, _ name: String, len: Int? = nil) throws -> Bytes {
            guard let v = t[tag] else { throw WireError("missing \(name)") }
            guard v.count == 1 else { throw WireError("\(name) repeated") }
            if let l = len, v[0].count != l { throw WireError("\(name) must be \(l) bytes") }
            return v[0]
        }
        func cid(_ bytes: Bytes, _ name: String) throws -> CID {
            guard let c = try? CID.decode(bytes) else { throw WireError("\(name) is not a CID") }
            if let rule = Verify.checkCidRules(c) { throw WireError("\(name): \(rule)") }
            return c
        }
        func utf8(_ bytes: Bytes, _ name: String) throws -> String {
            guard let s = String(bytes: bytes, encoding: .utf8) else { throw WireError("\(name) is not UTF-8") }
            return s
        }
        func rd16(_ v: Bytes, _ o: Int = 0) -> UInt16 { UInt16(v[o]) << 8 | UInt16(v[o + 1]) }
        func rd32(_ v: Bytes, _ o: Int = 0) -> UInt32 { UInt32(v[o]) << 24 | UInt32(v[o + 1]) << 16 | UInt32(v[o + 2]) << 8 | UInt32(v[o + 3]) }

        switch sub {
        case Sub.announce:
            let sites = t[Tag.site] ?? []
            guard (1...maxAnnounceEntries).contains(sites.count) else { throw WireError("announce needs 1..8 sites") }
            return .announce(sites: try sites.map { v in
                guard v.count >= 7 else { throw WireError("site entry too short") }
                return SiteEntry(root: try cid(Array(v[6...]), "site root"), sizeBytes: rd32(v), blockCount: rd16(v, 4))
            })
        case Sub.nameRecord:
            return .nameRecord(signed: try utf8(one(Tag.signedRecord, "signedRecord"), "signedRecord"))
        case Sub.want:
            let reqId = try one(Tag.reqId, "reqId", len: 8)
            let origTtl = try one(Tag.origTtl, "origTtl", len: 1)[0]
            let r = t[Tag.rootCid] != nil ? try one(Tag.rootCid, "rootCid") : nil
            let n = t[Tag.ensName] != nil ? try one(Tag.ensName, "ensName") : nil
            guard (r == nil) != (n == nil) else { throw WireError("want needs exactly one of rootCid or ensName") }
            if let n { return .want(reqId: reqId, origTtl: origTtl, root: nil, name: try utf8(n, "ensName")) }
            return .want(reqId: reqId, origTtl: origTtl, root: try cid(r!, "rootCid"), name: nil)
        case Sub.have:
            let bulk = try one(Tag.bulk, "bulk", len: 1)[0]
            return .have(
                reqId: try one(Tag.reqId, "reqId", len: 8),
                root: try cid(one(Tag.rootCid, "rootCid"), "rootCid"),
                hops: try one(Tag.hops, "hops", len: 1)[0],
                bulk: Bulk(p2pWifi: bulk & 1 != 0, ble: bulk & 2 != 0),
                sizeBytes: rd32(try one(Tag.sizeBytes, "sizeBytes", len: 4)),
                blockCount: rd16(try one(Tag.blockCount, "blockCount", len: 2)))
        case Sub.blockReq:
            let cids = t[Tag.blockCid] ?? []
            guard (1...maxBlockReq).contains(cids.count) else { throw WireError("block-req needs 1..32 CIDs") }
            return .blockReq(root: try cid(one(Tag.rootCid, "rootCid"), "rootCid"), cids: try cids.map { try cid($0, "blockCid") })
        case Sub.block:
            let cids = t[Tag.blockCid] ?? []
            guard cids.count == 1 else { throw WireError("block needs exactly one blockCid") }
            return .block(cid: try cid(cids[0], "blockCid"), bytes: try one(Tag.blockBytes, "blockBytes"))
        case Sub.blockNone:
            let cids = t[Tag.blockCid] ?? []
            guard cids.count == 1 else { throw WireError("block-none needs exactly one blockCid") }
            return .blockNone(cid: try cid(cids[0], "blockCid"))
        default:
            return nil
        }
    }
}

