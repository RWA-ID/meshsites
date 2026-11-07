import Combine
import Foundation
import MeshSitesCore

/// The mesh side of MeshSites (M3): runs the shared gossip policy
/// (MeshSitesCore `Gossip`, protocol/vectors/gossip.json) over bitchat.
///
/// bitchat stays ignorant of MeshSites types: it hands every public 0x4D
/// packet to `receive(...)` and relays it only if that returns true, and it
/// gives us a `Transport` to send packets with. Thread-safe: `receive` is
/// called on bitchat's BLE queue; the UI state is published on the main queue.
public final class MeshSitesService: ObservableObject {
    public static let shared = MeshSitesService()
    /// bitchat outer MessageType for public MeshSites gossip (decisions D4).
    public static let messageType: UInt8 = Wire.messageType

    /// How bitchat lets us send. All fields are called from our own queue.
    public struct Transport {
        /// The current 8-byte bitchat peer ID (it changes after a panic wipe).
        public var selfID: () -> Data
        /// Broadcast (recipient nil) or address a public 0x4D packet; `sign` adds bitchat's Ed25519 packet signature.
        public var send: (_ payload: Data, _ ttl: UInt8, _ recipient: Data?, _ sign: Bool) -> Void
        public init(selfID: @escaping () -> Data, send: @escaping (Data, UInt8, Data?, Bool) -> Void) {
            self.selfID = selfID
            self.send = send
        }
    }

    public struct NearbySite: Identifiable, Equatable {
        public var id: String { root }
        public let root: String
        public let peers: Int
        public let nearestHops: Int
        public let stored: Bool
    }

    public struct Holder: Identifiable, Equatable {
        public var id: String { peer }
        public let peer: String
        public let hops: Int
        public let sizeBytes: Int
        public let blockCount: Int
    }

    /// Share (announce + answer WANTs for) the sites stored on this device. Opt-in.
    @Published public var seeding: Bool {
        didSet {
            UserDefaults.standard.set(seeding, forKey: Self.seedingKey)
            let on = seeding
            queue.async { [weak self] in
                guard let self else { return }
                self.gossip.config.seeding = on
                if on { self.scheduleAnnounce(after: 1) }
            }
        }
    }
    @Published public private(set) var attached = false
    @Published public private(set) var nearby: [NearbySite] = []
    /// root → peers that answered our last WANT for it.
    @Published public private(set) var holders: [String: [Holder]] = [:]
    @Published public private(set) var probing: Set<String> = []
    @Published public private(set) var log: [String] = []
    @Published public private(set) var spamStrikes = 0

    public let store: SiteStore
    private let queue = DispatchQueue(label: "meshsites.service")
    private var transport: Transport?
    private var gossip: Gossip
    private var announceTimer: DispatchSourceTimer?
    private var pendingWants: [String: String] = [:] // reqId hex → root
    private var storeSink: AnyCancellable?
    /// Last value of `store.sites`, owned by `queue`.
    private var storedSites: [StoredSite] = []
    private let start = Date()
    private static let seedingKey = "meshsites.seeding"
    private static let haveWindow: TimeInterval = 3

    public init(store: SiteStore = .shared) {
        self.store = store
        let seeding = UserDefaults.standard.bool(forKey: Self.seedingKey)
        self.seeding = seeding
        var cfg = Gossip.Config()
        cfg.seeding = seeding
        cfg.bulkCapable = false // peer-to-peer Wi-Fi arrives in M4
        gossip = Gossip(selfID: "", config: cfg)
    }

    /// Called once by bitchat at startup.
    public func attach(_ t: Transport) {
        queue.async { [self] in
            transport = t
            rebuildPolicy()
            DispatchQueue.main.async { self.attached = true }
            appendLog("attached as \(Self.short(t.selfID().hex))")
            scheduleAnnounce(after: 3 + Double.random(in: 0...2))
        }
        // SiteStore is main-actor isolated; its changes are handled on `queue`.
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.storeSink = self.store.$sites.receive(on: self.queue).sink { [weak self] sites in
                guard let self else { return }
                self.storedSites = sites
                self.syncSites()
                self.publish()
                if self.gossip.config.seeding { self.scheduleAnnounce(after: 0.5 + Double.random(in: 0...1)) }
            }
        }
    }

    /// bitchat hook: one public 0x4D packet. Returns false when bitchat must not relay it.
    public func receive(payload: Data, sender: Data, recipient: Data?, ttl: UInt8, authenticated: Bool) -> Bool {
        queue.sync {
            guard transport != nil else { return true } // not attached yet: behave like an unpatched node
            ensureSelfID()
            let now = Date().timeIntervalSince(start) * 1000
            let p = Gossip.Packet(sender: sender.hex, recipient: recipient?.hex, ttl: ttl, payload: Array(payload), authenticated: authenticated)
            let v = gossip.receive(p, now: now, nowSec: Int64(Date().timeIntervalSince1970))
            if let d = v.drop, d != "duplicate" {
                appendLog("dropped \(Self.label(payload)) from \(Self.short(p.sender)): \(d)")
            }
            for o in v.send { send(o) }
            if let h = v.have, let root = pendingWants[Hex.encode(h.reqId)] {
                appendLog("HAVE from \(Self.short(h.from)): \(Self.short(root)) at \(h.hops) hop(s)")
                let holder = Holder(peer: h.from, hops: Int(h.hops), sizeBytes: Int(h.sizeBytes), blockCount: Int(h.blockCount))
                DispatchQueue.main.async {
                    var list = self.holders[root] ?? []
                    list.removeAll { $0.peer == holder.peer }
                    list.append(holder)
                    self.holders[root] = list.sorted { $0.hops < $1.hops }
                }
            }
            if let n = v.name { appendLog("name \(n.name) → \(Self.short(n.root)) (\(n.status.rawValue))") }
            if v.drop == nil, Wire.decodeSubtype(payload) == Wire.Sub.announce { appendLog("ANNOUNCE from \(Self.short(p.sender)), TTL \(ttl)") }
            publish()
            return v.relay
        }
    }

    /// Ask the mesh who holds `root`; answers appear in `holders[root]` for a few seconds.
    public func probe(root: String) {
        guard let cid = try? CID.parse(root) else { return }
        queue.async { [self] in
            guard transport != nil else { return }
            var reqId = Bytes(repeating: 0, count: 8)
            for i in reqId.indices { reqId[i] = UInt8.random(in: 0...255) }
            pendingWants[Hex.encode(reqId)] = root
            DispatchQueue.main.async { self.holders[root] = []; self.probing.insert(root) }
            appendLog("WANT \(Self.short(root))")
            send(Gossip.Outgoing(message: .want(reqId: reqId, origTtl: Wire.TTL.want, root: cid, name: nil), ttl: Wire.TTL.want, recipient: nil))
            queue.asyncAfter(deadline: .now() + Self.haveWindow) { [self] in
                pendingWants[Hex.encode(reqId)] = nil
                DispatchQueue.main.async { self.probing.remove(root) }
            }
        }
    }

    // MARK: internals (on `queue`)

    private func send(_ o: Gossip.Outgoing) {
        guard let t = transport, let payload = try? Wire.encode(o.message) else { return }
        let recipient = o.recipient.flatMap { Hex.decode($0) }.map { Data($0) }
        // NAME_RECORD is self-authenticating (EIP-191); everything else carries bitchat's packet signature (D4).
        let sign: Bool
        if case .nameRecord = o.message { sign = false } else { sign = true }
        t.send(Data(payload), o.ttl, recipient, sign)
    }

    private func ensureSelfID() {
        guard let t = transport else { return }
        if gossip.selfID != t.selfID().hex { rebuildPolicy() }
    }

    /// A fresh policy for a (new) identity: nothing learned under the old peer ID carries over.
    private func rebuildPolicy() {
        gossip = Gossip(selfID: transport?.selfID().hex ?? "", config: gossip.config)
        syncSites()
    }

    private func syncSites() {
        let stored = storedSites
        let keep = Set(stored.map(\.root))
        for root in gossip.sites.keys where !keep.contains(root) {
            if let cid = try? CID.parse(root) { gossip.removeSite(root: cid) }
        }
        for s in stored where s.sizeBytes <= Limits.maxSiteBytes && s.blockCount <= Int(UInt16.max) {
            guard let cid = try? CID.parse(s.root) else { continue }
            gossip.setSite(.init(root: cid, sizeBytes: UInt32(s.sizeBytes), blockCount: UInt16(s.blockCount), complete: true))
        }
    }

    private func scheduleAnnounce(after delay: TimeInterval) {
        announceTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + delay)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            if let o = self.gossip.announce() {
                self.send(o)
                self.appendLog("announced \(self.gossip.sites.count) site(s)")
            }
            // Next one at the interval, with jitter so neighbours don't sync up.
            self.scheduleAnnounce(after: self.gossip.config.announceIntervalMs / 1000 * Double.random(in: 0.9...1.1))
        }
        t.resume()
        announceTimer = t
    }

    private func publish() {
        let storedRoots = Set(storedSites.map(\.root))
        let list = gossip.heard.map { root, peers in
            NearbySite(root: root, peers: peers.count, nearestHops: Int(peers.values.map(\.hops).min() ?? 0), stored: storedRoots.contains(root))
        }.sorted { ($0.nearestHops, $0.root) < ($1.nearestHops, $1.root) }
        let strikes = gossip.spam.values.reduce(0, +)
        DispatchQueue.main.async {
            if self.nearby != list { self.nearby = list }
            if self.spamStrikes != strikes { self.spamStrikes = strikes }
        }
    }

    private func appendLog(_ line: String) {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        let entry = "\(f.string(from: Date())) \(line)"
        DispatchQueue.main.async {
            self.log.append(entry)
            if self.log.count > 40 { self.log.removeFirst(self.log.count - 40) }
        }
    }

    static func short(_ s: String) -> String { s.count > 12 ? "\(s.prefix(6))…\(s.suffix(4))" : s }

    static func label(_ payload: Data) -> String {
        switch Wire.decodeSubtype(payload) {
        case Wire.Sub.announce: return "ANNOUNCE"
        case Wire.Sub.nameRecord: return "NAME_RECORD"
        case Wire.Sub.want: return "WANT"
        case Wire.Sub.have: return "HAVE"
        case let s?: return String(format: "sub 0x%02x", s)
        case nil: return "?"
        }
    }
}

extension Wire {
    /// The sub-type byte of a v1 payload, without decoding it.
    static func decodeSubtype(_ payload: Data) -> UInt8? {
        payload.count >= 2 && payload[payload.startIndex] == Wire.version ? payload[payload.startIndex + 1] : nil
    }
}

extension Data {
    var hex: String { Hex.encode(self) }
}
