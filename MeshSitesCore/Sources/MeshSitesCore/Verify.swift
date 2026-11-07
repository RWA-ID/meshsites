/// Block and DAG verification (SPEC §2.2). Error strings match the TypeScript
/// reference because the shared vectors assert on them.

public protocol BlockSource {
    func block(_ cid: CID) -> Bytes?
}

public struct DictBlockSource: BlockSource {
    public var blocks: [CID: Bytes]
    public init(_ blocks: [CID: Bytes]) { self.blocks = blocks }
    public func block(_ cid: CID) -> Bytes? { blocks[cid] }
}

public enum Verify {
    /// CID-only rules: CIDv1, raw or dag-pb, sha2-256 with a 32-byte digest.
    public static func checkCidRules(_ cid: CID) -> String? {
        let id = cid.description
        if cid.version != 1 { return "\(id): not CIDv1" }
        if cid.codec != Codec.raw && cid.codec != Codec.dagPB { return "\(id): codec 0x\(String(cid.codec, radix: 16)) not allowed" }
        if cid.hashCode != Codec.sha2_256 || cid.digest.count != 32 { return "\(id): hash must be sha2-256" }
        return nil
    }

    /// Steps 1-3: rules, size cap, hash. Nil means the block may be stored.
    public static func checkBlock(_ cid: CID, _ bytes: Bytes, maxBlockBytes: Int = Limits.maxBlockBytes) -> String? {
        if let e = checkCidRules(cid) { return e }
        if bytes.count > maxBlockBytes { return "\(cid): block is \(bytes.count) bytes (max \(maxBlockBytes))" }
        if sha256(bytes) != cid.digest { return "\(cid): hash mismatch" }
        return nil
    }

    public struct ReadCar {
        public let root: CID
        public let blocks: [CID: Bytes]
        public let order: [CID]
        public let totalBytes: Int
        public let errors: [String]
    }

    /// Parse a CAR and hash-check every block. Throws on a header problem.
    public static func readCar(_ car: Bytes, maxBlockBytes: Int = Limits.maxBlockBytes) throws -> ReadCar {
        let f = try CARFile.parse(car)
        guard f.roots.count == 1 else { throw DecodeError("CAR has \(f.roots.count) roots, need 1") }
        var blocks: [CID: Bytes] = [:]
        var order: [CID] = []
        var errors: [String] = []
        var total = 0
        for (cid, bytes) in f.blocks {
            if blocks[cid] != nil {
                errors.append("\(cid): duplicate block")
                continue
            }
            if let e = checkBlock(cid, bytes, maxBlockBytes: maxBlockBytes) {
                errors.append(e)
                continue
            }
            blocks[cid] = bytes
            order.append(cid)
            total += bytes.count
        }
        return ReadCar(root: f.roots[0], blocks: blocks, order: order, totalBytes: total, errors: errors)
    }

    public struct DagResult {
        public var ok: Bool { errors.isEmpty && missing.isEmpty }
        /// Blocks still to fetch, in DFS order.
        public var missing: [CID] = []
        public var reached: Set<CID> = []
        public var totalBytes = 0
        public var logicalBytes = 0
        public var errors: [String] = []
    }

    /// Steps 5-9 over blocks that are already hash-verified.
    public static func verifyDag(root: CID, source: BlockSource, maxSiteBytes: Int = Limits.maxSiteBytes, maxLogicalBytes: Int = Limits.maxLogicalBytes) -> DagResult {
        var r = DagResult()
        if root.codec != Codec.dagPB { r.errors.append("root \(root) must be a dag-pb directory") }
        var stack = [root]
        while let cid = stack.popLast() {
            if r.reached.contains(cid) { continue }
            r.reached.insert(cid)
            if let rule = checkCidRules(cid) {
                r.errors.append("link \(rule)")
                continue
            }
            guard let bytes = source.block(cid) else {
                r.missing.append(cid)
                continue
            }
            r.totalBytes += bytes.count
            if cid.codec == Codec.raw { continue }
            do {
                let node = try PBNode.decode(bytes)
                guard let data = node.data else { throw DecodeError("dag-pb node has no UnixFS data") }
                let fs = try UnixFSData.decode(data)
                guard fs.type == .file || fs.type == .directory || fs.type == .raw else {
                    throw DecodeError("UnixFS type \(fs.type.rawValue) not supported")
                }
                if fs.type == .directory && node.links.contains(where: { ($0.name ?? "").isEmpty }) {
                    throw DecodeError("directory entry without a name")
                }
                if cid == root && fs.type != .directory { throw DecodeError("root must be a directory") }
                for l in node.links.reversed() { stack.append(l.hash) }
            } catch {
                r.errors.append("\(cid): \(error)")
            }
        }
        if r.totalBytes > maxSiteBytes { r.errors.append("site is \(r.totalBytes) bytes (max \(maxSiteBytes))") }

        if r.errors.isEmpty && r.missing.isEmpty {
            // Memoised so a crafted DAG can't make this exponential.
            var memo: [CID: Int] = [:]
            func size(_ cid: CID) -> Int {
                if let m = memo[cid] { return m }
                let bytes = source.block(cid)!
                var n = bytes.count
                if cid.codec == Codec.dagPB, let node = try? PBNode.decode(bytes) {
                    n = (try? UnixFSData.decode(node.data ?? []))?.data?.count ?? 0
                    for l in node.links {
                        n += size(l.hash)
                        if n > Int.max / 4 { break }
                    }
                }
                memo[cid] = n
                return n
            }
            r.logicalBytes = size(root)
            if r.logicalBytes > maxLogicalBytes { r.errors.append("site expands to \(r.logicalBytes) bytes of files (max \(maxLogicalBytes))") }
        }
        return r
    }

    public struct CarResult {
        public let ok: Bool
        public let root: CID?
        public let blockCount: Int
        public let totalBytes: Int
        public let logicalBytes: Int
        public let errors: [String]
    }

    public static func verifyCar(_ car: Bytes, expectedRoot: String? = nil) -> CarResult {
        let parsed: ReadCar
        do {
            parsed = try readCar(car)
        } catch {
            let m = "\(error)"
            return CarResult(ok: false, root: nil, blockCount: 0, totalBytes: 0, logicalBytes: 0, errors: [m.hasPrefix("CAR ") ? m : "CAR parse error: \(m)"])
        }
        var errors = parsed.errors
        if let e = expectedRoot, parsed.root.description != e { errors.append("root is \(parsed.root), expected \(e)") }
        let dag = verifyDag(root: parsed.root, source: DictBlockSource(parsed.blocks))
        errors += dag.errors
        errors += dag.missing.map { "\($0): missing block" }
        for c in parsed.order where !dag.reached.contains(c) { errors.append("\(c): block not reachable from root") }
        return CarResult(ok: errors.isEmpty, root: parsed.root, blockCount: parsed.blocks.count, totalBytes: parsed.totalBytes, logicalBytes: dag.logicalBytes, errors: errors)
    }
}
