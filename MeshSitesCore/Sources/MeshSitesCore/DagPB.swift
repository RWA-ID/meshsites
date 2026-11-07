/// Minimal protobuf + DAG-PB + UnixFS decoding with the same strictness as
/// @ipld/dag-pb and ipfs-unixfs (the TypeScript reference), so both
/// implementations accept and reject the same blocks.

struct ProtoReader {
    let b: Bytes
    var i = 0
    init(_ b: Bytes) { self.b = b }
    var atEnd: Bool { i >= b.count }

    /// Protobuf varint: like @ipld/dag-pb, non-minimal encodings are accepted.
    mutating func varint() throws -> UInt64 {
        var v: UInt64 = 0
        var shift: UInt64 = 0
        while true {
            guard shift < 64 else { throw DecodeError("protobuf: varint overflow") }
            guard i < b.count else { throw DecodeError("protobuf: unexpected end of data") }
            let x = b[i]
            i += 1
            v |= UInt64(x & 0x7f) << shift
            if x & 0x80 == 0 { return v }
            shift += 7
        }
    }

    mutating func key() throws -> (wireType: UInt64, field: UInt64) {
        let k = try varint()
        return (k & 7, k >> 3)
    }

    mutating func lengthDelimited() throws -> Bytes {
        let n = try varint()
        guard n <= UInt64(b.count - i) else { throw DecodeError("protobuf: unexpected end of data") }
        let out = Array(b[i..<(i + Int(n))])
        i += Int(n)
        return out
    }

    mutating func skip(_ wireType: UInt64) throws {
        switch wireType {
        case 0: _ = try varint()
        case 1: guard i + 8 <= b.count else { throw DecodeError("protobuf: unexpected end of data") }; i += 8
        case 2: _ = try lengthDelimited()
        case 5: guard i + 4 <= b.count else { throw DecodeError("protobuf: unexpected end of data") }; i += 4
        default: throw DecodeError("protobuf: unsupported wire type \(wireType)")
        }
    }
}

public struct PBLink {
    public let hash: CID
    public let name: String?
    public let tsize: UInt64?
}

public struct PBNode {
    public let data: Bytes?
    public let links: [PBLink]

    public static func decode(_ bytes: Bytes) throws -> PBNode {
        var r = ProtoReader(bytes)
        var data: Bytes?
        var links: [PBLink]?
        var linksBeforeData = false
        while !r.atEnd {
            let (wt, field) = try r.key()
            guard wt == 2 else { throw DecodeError("protobuf: (PBNode) invalid wireType, expected 2, got \(wt)") }
            if field == 1 {
                if data != nil { throw DecodeError("protobuf: (PBNode) duplicate Data section") }
                data = try r.lengthDelimited()
                if links != nil { linksBeforeData = true }
            } else if field == 2 {
                if linksBeforeData { throw DecodeError("protobuf: (PBNode) duplicate Links section") }
                if links == nil { links = [] }
                links!.append(try decodeLink(r.lengthDelimited()))
            } else {
                throw DecodeError("protobuf: (PBNode) invalid fieldNumber, expected 1 or 2, got \(field)")
            }
        }
        return PBNode(data: data, links: links ?? [])
    }

    static func decodeLink(_ bytes: Bytes) throws -> PBLink {
        var r = ProtoReader(bytes)
        var hash: Bytes?
        var name: String?
        var tsize: UInt64?
        while !r.atEnd {
            let (wt, field) = try r.key()
            switch field {
            case 1:
                if hash != nil { throw DecodeError("protobuf: (PBLink) duplicate Hash section") }
                guard wt == 2 else { throw DecodeError("protobuf: (PBLink) wrong wireType (\(wt)) for Hash") }
                if name != nil { throw DecodeError("protobuf: (PBLink) invalid order, found Name before Hash") }
                if tsize != nil { throw DecodeError("protobuf: (PBLink) invalid order, found Tsize before Hash") }
                hash = try r.lengthDelimited()
            case 2:
                if name != nil { throw DecodeError("protobuf: (PBLink) duplicate Name section") }
                guard wt == 2 else { throw DecodeError("protobuf: (PBLink) wrong wireType (\(wt)) for Name") }
                if tsize != nil { throw DecodeError("protobuf: (PBLink) invalid order, found Tsize before Name") }
                name = String(decoding: try r.lengthDelimited(), as: UTF8.self)
            case 3:
                if tsize != nil { throw DecodeError("protobuf: (PBLink) duplicate Tsize section") }
                guard wt == 0 else { throw DecodeError("protobuf: (PBLink) wrong wireType (\(wt)) for Tsize") }
                tsize = try r.varint()
            default:
                throw DecodeError("protobuf: (PBLink) invalid fieldNumber, expected 1, 2 or 3, got \(field)")
            }
        }
        guard let h = hash, let c = try? CID.decode(h) else { throw DecodeError("Invalid Hash field found in link, expected CID") }
        return PBLink(hash: c, name: name, tsize: tsize)
    }
}

public enum UnixFSType: String {
    case raw, directory, file, metadata, symlink
    case hamtShardedDirectory = "hamt-sharded-directory"
}

public struct UnixFSData {
    public let type: UnixFSType
    public let data: Bytes?

    /// Like ipfs-unixfs `UnixFS.unmarshal`: a missing Type means "file";
    /// unknown fields are skipped.
    public static func decode(_ bytes: Bytes) throws -> UnixFSData {
        var r = ProtoReader(bytes)
        var type: UnixFSType = .file
        var data: Bytes?
        while !r.atEnd {
            let (wt, field) = try r.key()
            switch (field, wt) {
            case (1, 0):
                let v = try r.varint()
                let all: [UnixFSType] = [.raw, .directory, .file, .metadata, .symlink, .hamtShardedDirectory]
                guard v < UInt64(all.count) else { throw DecodeError("Type: \(v) is not valid") }
                type = all[Int(v)]
            case (2, 2):
                data = try r.lengthDelimited()
            default:
                try r.skip(wt)
            }
        }
        return UnixFSData(type: type, data: data)
    }
}
