import Foundation

/// Block transfer policy (M4). Mirrors protocol/ts/src/fetch.ts; both must pass
/// protocol/vectors/fetch.json.
///
///  - `Fetcher` pulls one site from the holders found by WANT/HAVE: batches of
///    ≤ 32 BLOCK_REQ CIDs from the DAG frontier, every block hash-checked on
///    arrival, the next holder on a corrupt block (blamed), BLOCK_NONE or a
///    timeout (not blamed).
///  - `BlockServer` answers BLOCK_REQ inside a direct session, only from the
///    requested site, rate-limited per peer.
public enum Fetch {
    public enum Via: String, Equatable { case ble, bulk }

    public struct Holder: Equatable {
        public let peer: String
        public let via: Via
        public let hops: Int
        public let sizeBytes: Int
        public let blockCount: Int
        public init(peer: String, via: Via, hops: Int, sizeBytes: Int, blockCount: Int) {
            self.peer = peer; self.via = via; self.hops = hops; self.sizeBytes = sizeBytes; self.blockCount = blockCount
        }
    }

    public enum Action: Equatable {
        case request(peer: String, via: Via, root: CID, cids: [CID], deadline: Double)
        case stored(cid: CID, bytes: Bytes)
        case blame(peer: String, reason: String)
        case next(from: String, reason: String)
        case done(totalBytes: Int, blockCount: Int)
        case failed(reason: String, detail: String?)
    }

    /// Extra time for the first batch to a holder: the direct session (Noise handshake) may not exist yet.
    public static let sessionSetupMs: Double = 10_000

    /// Per-batch time budget: BLE ~12 KB/s per hop (half duplex), bulk ~1 MB/s,
    /// plus 4 s slack, plus `sessionSetupMs` for the first batch to a holder.
    public static func batchDeadline(now: Double, via: Via, hops: Int, count n: Int, firstToHolder: Bool = false) -> Double {
        let est = via == .bulk ? Double(n * 16384) / 1000 : Double(n * 16384 * max(1, hops)) / 12
        return now + 4000 + est.rounded() + (firstToHolder ? sessionSetupMs : 0)
    }

    /// Usable holders, best first: an adjacent bulk link, then fewest hops; one entry per peer.
    public static func rank(_ holders: [Holder]) -> [Holder] {
        func score(_ h: Holder) -> Int { (h.via == .bulk && h.hops == 1 ? 0 : 100) + h.hops }
        var seen = Set<String>()
        return holders.enumerated()
            .filter { $0.element.sizeBytes <= Limits.maxSiteBytes && $0.element.hops >= 1 }
            .sorted { (score($0.element), $0.offset) < (score($1.element), $1.offset) }
            .map(\.element)
            .filter { seen.insert($0.peer).inserted }
    }
}

public final class Fetcher: BlockSource {
    public enum State: Equatable { case idle, running, done, failed }

    public let root: CID
    public let holders: [Fetch.Holder]
    public private(set) var state: State = .idle
    /// Blocks received and verified in this fetch.
    public private(set) var received: [CID: Bytes] = [:]
    public private(set) var blocks = 0, bytes = 0, corrupt = 0, switches = 0

    private let local: BlockSource?
    private var idx = 0
    private var batch: [CID] = []
    private var answered = Set<CID>()
    private var deadline: Double = 0
    /// Index of the holder that has already been sent a batch.
    private var asked = -1

    public init(root: CID, holders: [Fetch.Holder], local: BlockSource? = nil) {
        self.root = root
        self.holders = Fetch.rank(holders)
        self.local = local
    }

    public func block(_ cid: CID) -> Bytes? { received[cid] ?? local?.block(cid) }

    public var current: Fetch.Holder? { idx < holders.count ? holders[idx] : nil }

    public func start(now: Double) -> [Fetch.Action] {
        guard state == .idle else { return [] }
        state = .running
        return advance(now)
    }

    public func onBlock(peer: String, cid: CID, bytes b: Bytes, now: Double) -> [Fetch.Action] {
        guard expects(peer, cid) else { return [] } // unsolicited or late: ignore
        if Verify.checkBlock(cid, b) != nil {
            corrupt += 1
            return [.blame(peer: peer, reason: "corrupt-block")] + failover(now, "corrupt-block")
        }
        answered.insert(cid)
        received[cid] = b
        blocks += 1
        bytes += b.count
        var out: [Fetch.Action] = [.stored(cid: cid, bytes: b)]
        if answered.count == batch.count { out += advance(now) }
        return out
    }

    public func onBlockNone(peer: String, cid: CID, now: Double) -> [Fetch.Action] {
        guard expects(peer, cid) else { return [] }
        return failover(now, "block-none")
    }

    /// Call when the clock passes the last request's deadline (or periodically).
    public func tick(now: Double) -> [Fetch.Action] {
        guard state == .running, !batch.isEmpty, now >= deadline else { return [] }
        return failover(now, "timeout")
    }

    private func expects(_ peer: String, _ cid: CID) -> Bool {
        state == .running && current?.peer == peer && batch.contains(cid) && !answered.contains(cid)
    }

    private func advance(_ now: Double) -> [Fetch.Action] {
        let dag = Verify.verifyDag(root: root, source: self)
        if let e = dag.errors.first { return fail("invalid-dag", e) }
        if dag.reached.count > 0xffff { return fail("too-many-blocks") }
        if dag.ok {
            state = .done
            batch = []
            return [.done(totalBytes: dag.totalBytes, blockCount: dag.reached.count)]
        }
        guard let h = current else { return fail("no-holder") }
        let cids = Array(dag.missing.prefix(Wire.maxBlockReq))
        batch = cids
        answered = []
        deadline = Fetch.batchDeadline(now: now, via: h.via, hops: h.hops, count: cids.count, firstToHolder: asked != idx)
        asked = idx
        return [.request(peer: h.peer, via: h.via, root: root, cids: cids, deadline: deadline)]
    }

    private func failover(_ now: Double, _ reason: String) -> [Fetch.Action] {
        let from = current!.peer
        idx += 1
        switches += 1
        batch = []
        return [.next(from: from, reason: reason)] + advance(now)
    }

    private func fail(_ reason: String, _ detail: String? = nil) -> [Fetch.Action] {
        state = .failed
        batch = []
        return [.failed(reason: reason, detail: detail)]
    }
}

/// Answers BLOCK_REQ in a direct session and classifies other direct messages.
public final class BlockServer {
    public struct Config: Equatable {
        public var seeding = true
        /// BLOCK_REQ messages per peer.
        public var requests = Gossip.Bucket(burst: 8, refillMs: 500)
        public init() {}
    }

    public enum Verdict: Equatable {
        case reply([Wire.Message])
        case block(cid: CID, bytes: Bytes)
        case blockNone(cid: CID)
        case drop(reason: String, spam: Bool)
    }

    public var config: Config
    public private(set) var spam: [String: Int] = [:]
    private var buckets: [String: (tokens: Double, at: Double)] = [:]

    public init(config: Config = Config()) { self.config = config }

    /// One decrypted direct message from `peer`. `lookup(root, cid)` must only
    /// return blocks of the stored, complete site `root`.
    public func handle(peer: String, payload: Bytes, now: Double, lookup: (CID, CID) -> Bytes?) -> Verdict {
        func drop(_ reason: String, _ isSpam: Bool) -> Verdict {
            if isSpam { spam[peer, default: 0] += 1 }
            return .drop(reason: reason, spam: isSpam)
        }
        let m: Wire.Message
        do {
            guard let d = try Wire.decode(payload) else { return drop("unknown", false) }
            m = d
        } catch {
            return drop("malformed", true)
        }
        switch m {
        case .block(let cid, let b): return .block(cid: cid, bytes: b)
        case .blockNone(let cid): return .blockNone(cid: cid)
        case .blockReq(let root, let cids):
            guard config.seeding else { return drop("not-seeding", false) }
            guard take(peer, now) else { return drop("rate-limited", true) }
            return .reply(cids.map { cid in
                if let b = lookup(root, cid) { return .block(cid: cid, bytes: b) }
                return .blockNone(cid: cid)
            })
        case .announce, .nameRecord, .want, .have:
            return drop("not-direct", true)
        }
    }

    private func take(_ peer: String, _ now: Double) -> Bool {
        let b = config.requests
        let s = buckets[peer] ?? (tokens: b.burst, at: now)
        let tokens = min(b.burst, s.tokens + (now - s.at) / b.refillMs)
        if tokens < 1 {
            buckets[peer] = (tokens, now)
            return false
        }
        buckets[peer] = (tokens - 1, now)
        if buckets.count > 4096 { buckets.removeAll() }
        return true
    }
}
