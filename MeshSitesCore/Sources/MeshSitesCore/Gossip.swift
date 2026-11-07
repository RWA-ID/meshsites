import Foundation

/// Gossip policy (M3): what a node does with one public MeshSites packet
/// (bitchat outer type 0x4D). Pure and clock-injected: no timers, no radio.
/// Mirrors protocol/ts/src/gossip.ts; both must pass protocol/vectors/gossip.json.
///
/// Rules (decisions D4, SPEC §5):
///  - Unknown version/sub-type: relay untouched, as an unpatched bitchat node would.
///  - Malformed, a direct-only sub-type, or TTL above the sub-type's cap: drop, spam.
///  - ANNOUNCE: at most one per sender per half announce interval.
///  - WANT: deduped by reqId; per-sender token bucket. Packets whose bitchat
///    signature could not be checked share one bucket.
///  - NAME_RECORD: deduped by (name, seq); per-name token bucket; verified
///    before relay; a stale seq is dropped without blame.
///  - HAVE: consumed only by its recipient; relayed otherwise.
public final class Gossip {
    public struct Bucket: Equatable {
        public var burst: Double
        public var refillMs: Double
        public init(burst: Double, refillMs: Double) { self.burst = burst; self.refillMs = refillMs }
    }

    public struct Config: Equatable {
        public var seeding = true
        public var bulkCapable = true
        public var announceIntervalMs: Double = 60_000
        public var nameRebroadcastMs: Double = 5_000
        public var want = Bucket(burst: 8, refillMs: 2_000)
        public var nameRecord = Bucket(burst: 4, refillMs: 5_000)
        public var seenReqMs: Double = 300_000
        public var heardMs: Double = 180_000
        public init() {}
    }

    public struct Packet {
        /// 16 hex chars, the bitchat sender ID from the packet header.
        public let sender: String
        public let recipient: String?
        public let ttl: UInt8
        public let payload: Bytes
        /// The bitchat Ed25519 packet signature was checked against the sender's announced key.
        public let authenticated: Bool
        public init(sender: String, recipient: String?, ttl: UInt8, payload: Bytes, authenticated: Bool) {
            self.sender = sender; self.recipient = recipient; self.ttl = ttl; self.payload = payload; self.authenticated = authenticated
        }
    }

    public struct Outgoing: Equatable {
        public let message: Wire.Message
        public let ttl: UInt8
        public let recipient: String?
    }

    public struct Have: Equatable {
        public let from: String
        public let reqId: Bytes
        public let root: CID
        public let hops: UInt8
        public let bulk: Wire.Bulk
        public let sizeBytes: UInt32
        public let blockCount: UInt16
    }

    public struct AcceptedName: Equatable {
        public let name: String
        public let root: String
        public let status: RecordStatus
    }

    public struct Verdict: Equatable {
        public var relay = true
        /// Stable reason code when dropped (see the vectors).
        public var drop: String?
        /// Counts against the sender.
        public var spam = false
        public var send: [Outgoing] = []
        public var have: Have?
        public var name: AcceptedName?
    }

    public struct Site: Equatable {
        public let root: CID
        public var sizeBytes: UInt32
        public var blockCount: UInt16
        public var complete: Bool
        public init(root: CID, sizeBytes: UInt32, blockCount: UInt16, complete: Bool) {
            self.root = root; self.sizeBytes = sizeBytes; self.blockCount = blockCount; self.complete = complete
        }
    }

    public struct StoredName: Equatable {
        /// The exact signed JSON text, as received or published. Never re-serialised.
        public let signed: String
        public let seq: Int64
        public let root: String
        public let status: RecordStatus
    }

    public struct Sighting: Equatable {
        public let hops: UInt8
        public let at: Double
    }

    public static let ttlCap: [UInt8: UInt8] = [
        Wire.Sub.announce: Wire.TTL.announce, Wire.Sub.nameRecord: Wire.TTL.nameRecord,
        Wire.Sub.want: Wire.TTL.want, Wire.Sub.have: Wire.TTL.have,
    ]

    public let config: Config
    public let selfID: String
    /// Keyed by root CID string. Insertion order is kept for ANNOUNCE.
    public private(set) var sites: [String: Site] = [:]
    private var siteOrder: [String] = []
    public private(set) var names: [String: StoredName] = [:]
    /// name → trusted signer (lowercase), learned online.
    public private(set) var signers: [String: String] = [:]
    /// root → peer → sighting, from ANNOUNCEs.
    public private(set) var heard: [String: [String: Sighting]] = [:]
    /// peer → spam strikes.
    public private(set) var spam: [String: Int] = [:]

    private var seenReq: [String: Double] = [:]
    /// (reqId, time) in arrival order; an entry is stale once its reqId was evicted and seen again.
    private var seenReqOrder: [(key: String, at: Double)] = []
    private var seenReqHead = 0
    private var lastAnnounceFrom: [String: Double] = [:]
    private var lastNameBroadcast: [String: Double] = [:]
    private var buckets: [String: (tokens: Double, at: Double)] = [:]

    public init(selfID: String, config: Config = Config()) {
        self.selfID = selfID
        self.config = config
    }

    public func trust(name: String, signer: String) {
        signers[name] = signer.lowercased()
    }

    public func setSite(_ s: Site) {
        let k = s.root.description
        if sites[k] == nil { siteOrder.append(k) }
        sites[k] = s
    }

    public func removeSite(root: CID) {
        let k = root.description
        sites[k] = nil
        siteOrder.removeAll { $0 == k }
    }

    /// Add a record from a trusted source (publisher, gateway).
    @discardableResult
    public func addRecord(_ signedText: String, nowSec: Int64) throws -> RecordStatus {
        switch verify(signedText, nowSec: nowSec) {
        case .success(let a): return a.status
        case .failure(let e): throw e
        }
    }

    /// The ANNOUNCE to broadcast now, if any (the caller runs the timer).
    public func announce() -> Outgoing? {
        guard config.seeding else { return nil }
        let entries = siteOrder.compactMap { sites[$0] }.filter(\.complete).suffix(Wire.maxAnnounceEntries)
        guard !entries.isEmpty else { return nil }
        return Outgoing(message: .announce(sites: entries.map { Wire.SiteEntry(root: $0.root, sizeBytes: $0.sizeBytes, blockCount: $0.blockCount) }),
                        ttl: Wire.TTL.announce, recipient: nil)
    }

    public func receive(_ p: Packet, now: Double, nowSec: Int64) -> Verdict {
        var v = Verdict()
        func drop(_ why: String, _ isSpam: Bool) -> Verdict {
            v.relay = false
            v.drop = why
            v.spam = isSpam
            if isSpam { spam[p.sender, default: 0] += 1 }
            return v
        }

        let m: Wire.Message
        do {
            guard let decoded = try Wire.decode(p.payload) else { return v } // unknown: relay as bitchat would
            m = decoded
        } catch {
            return drop("malformed", true)
        }
        guard p.payload.count >= 2, let cap = Gossip.ttlCap[p.payload[1]] else { return drop("not-public", true) }
        if p.ttl > cap { return drop("ttl-over-cap", true) }
        prune(now)

        switch m {
        case .announce(let entries):
            if let last = lastAnnounceFrom[p.sender], now - last < config.announceIntervalMs * 0.5 {
                return drop("rate-limited", true)
            }
            lastAnnounceFrom[p.sender] = now
            let hops = Wire.TTL.announce &- p.ttl &+ 1
            for s in entries { heard[s.root.description, default: [:]][p.sender] = Sighting(hops: hops, at: now) }
            return v

        case .want(let reqId, let origTtl, let root, let name):
            let rk = Hex.encode(reqId)
            if seenReq[rk] != nil { return drop("duplicate", false) }
            if !take("want:\(p.authenticated ? p.sender : "*")", config.want, now) { return drop("rate-limited", true) }
            seenReq[rk] = now
            seenReqOrder.append((rk, now))
            // origTtl comes from the peer: clamp so a bogus value can't wrap the hop count.
            let hops = UInt8(clamping: max(1, Int(origTtl) - Int(p.ttl) + 1))
            if let root, config.seeding {
                if let s = sites[root.description], s.complete, Int(s.sizeBytes) <= Limits.maxSiteBytes {
                    v.send.append(Outgoing(
                        message: .have(reqId: reqId, root: s.root, hops: hops, bulk: Wire.Bulk(p2pWifi: config.bulkCapable, ble: true),
                                       sizeBytes: s.sizeBytes, blockCount: s.blockCount),
                        // One hop of slack: the answer may take a different path back.
                        ttl: min(Wire.TTL.have, hops &+ 1), recipient: p.sender))
                }
            } else if let name, let n = names[name] {
                if let last = lastNameBroadcast[name], now - last < config.nameRebroadcastMs { return v }
                lastNameBroadcast[name] = now
                v.send.append(Outgoing(message: .nameRecord(signed: n.signed), ttl: Wire.TTL.nameRecord, recipient: nil))
            }
            return v

        case .have(let reqId, let root, let hops, let bulk, let size, let count):
            guard p.recipient == selfID else { return v } // someone else's answer: relay
            v.relay = false
            v.have = Have(from: p.sender, reqId: reqId, root: root, hops: hops, bulk: bulk, sizeBytes: size, blockCount: count)
            return v

        case .nameRecord(let signed):
            guard let head = Gossip.peek(signed) else { return drop("record:malformed", true) }
            if let cached = names[head.name], cached.signed == signed, Double(cached.seq) == head.seq { return drop("duplicate", false) }
            if !take("name:\(head.name)", config.nameRecord, now) { return drop("rate-limited", false) }
            switch verify(signed, nowSec: nowSec) {
            case .success(let a):
                v.name = a
                return v
            case .failure(let e):
                return drop("record:\(e.rawValue)", e != .staleSeq)
            }

        case .blockReq, .block, .blockNone:
            return drop("not-public", true)
        }
    }

    // MARK: internals

    private func verify(_ signedText: String, nowSec: Int64) -> Result<AcceptedName, RecordRejection> {
        guard let signed = try? JSON.parse(signedText) else { return .failure(.malformed) }
        let head = Gossip.peek(signedText)
        let res = Records.verify(signed,
                                 expectedSigner: head.flatMap { signers[$0.name] },
                                 cachedSeq: head.flatMap { names[$0.name]?.seq },
                                 now: nowSec)
        switch res {
        case .rejected(let reason, _):
            return .failure(reason)
        case .ok(let status, let r, _):
            names[r.name] = StoredName(signed: signedText, seq: r.seq, root: r.cid.description, status: status)
            return .success(AcceptedName(name: r.name, root: r.cid.description, status: status))
        }
    }

    private func take(_ key: String, _ b: Bucket, _ now: Double) -> Bool {
        let s = buckets[key] ?? (tokens: b.burst, at: now)
        let tokens = min(b.burst, s.tokens + (now - s.at) / b.refillMs)
        if tokens < 1 {
            buckets[key] = (tokens, now)
            return false
        }
        buckets[key] = (tokens - 1, now)
        return true
    }

    private func prune(_ now: Double) {
        // Oldest first; evict past the window or beyond 1000 entries.
        while seenReqHead < seenReqOrder.count {
            let e = seenReqOrder[seenReqHead]
            if seenReq[e.key] == e.at {
                if now - e.at < config.seenReqMs, seenReq.count <= 1000 { break }
                seenReq[e.key] = nil
            }
            seenReqHead += 1
        }
        if seenReqHead > 4096 {
            seenReqOrder.removeFirst(seenReqHead)
            seenReqHead = 0
        }
        for (root, peers) in heard {
            let fresh = peers.filter { now - $0.value.at <= config.heardMs }
            heard[root] = fresh.isEmpty ? nil : fresh
        }
        if buckets.count > 4096 { buckets.removeAll() } // memory bound; worst case grants a fresh burst
    }

    /// name + seq from a signed record's text, without verifying it (cheap dedupe / bucket key).
    static func peek(_ signedText: String) -> (name: String, seq: Double)? {
        guard let j = try? JSON.parse(signedText), let r = j["record"], let name = r["name"]?.string else { return nil }
        let seq: Double
        switch r["seq"] {
        case .int(let i)?: seq = Double(i)
        case .double(let d)?: seq = d
        default: return nil
        }
        guard !name.isEmpty, name.utf16.count <= 255 else { return nil }
        return (name, seq)
    }
}
