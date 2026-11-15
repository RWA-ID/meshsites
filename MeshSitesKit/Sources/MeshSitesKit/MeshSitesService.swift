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
/// `@unchecked Sendable`: mutable state is only touched on `queue`, `@Published` values only on the main queue.
public final class MeshSitesService: ObservableObject, @unchecked Sendable {
    public static let shared = MeshSitesService()
    /// bitchat outer MessageType for public MeshSites gossip (decisions D4).
    public static let messageType: UInt8 = Wire.messageType
    /// bitchat NoisePayloadType for direct MeshSites messages inside a session (decisions D9).
    public static let noisePayloadType: UInt8 = Wire.noisePayloadType

    /// How bitchat lets us send. All fields are called from our own queue.
    public struct Transport {
        /// The current 8-byte bitchat peer ID (it changes after a panic wipe).
        public var selfID: () -> Data
        /// Broadcast (recipient nil) or address a public 0x4D packet; `sign` adds bitchat's Ed25519 packet signature.
        public var send: (_ payload: Data, _ ttl: UInt8, _ recipient: Data?, _ sign: Bool) -> Void
        /// A direct message (BLOCK_REQ / BLOCK / BLOCK_NONE) to one peer inside its Noise session
        /// (Noise payload type 0x4D; bitchat handshakes first if needed).
        public var sendDirect: (_ payload: Data, _ peer: Data) -> Void
        public init(selfID: @escaping () -> Data, send: @escaping (Data, UInt8, Data?, Bool) -> Void,
                    sendDirect: @escaping (Data, Data) -> Void = { _, _ in }) {
            self.selfID = selfID
            self.send = send
            self.sendDirect = sendDirect
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

    /// One site being pulled from the mesh (M4).
    public struct Download: Equatable {
        public enum Phase: String { case asking, downloading, done, failed }
        public var phase: Phase
        public var blocks = 0
        public var bytes = 0
        public var expectedBlocks = 0
        public var peer: String?
        public var via: String?
        public var seconds: Double?
        public var error: String?
    }

    /// Share (announce + answer WANTs for) the sites stored on this device. Opt-in.
    @Published public var seeding: Bool {
        didSet {
            UserDefaults.standard.set(seeding, forKey: Self.seedingKey)
            let on = seeding
            queue.async { [weak self] in
                guard let self else { return }
                self.gossip.config.seeding = on
                self.server.config.seeding = on
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
    @Published public private(set) var downloads: [String: Download] = [:]
    /// The address bar's current lookup (D14).
    @Published public private(set) var lookup: Lookup?

    /// One address typed into the address bar, from parsing to "ready to open".
    public struct Lookup: Equatable {
        public enum Phase: Equatable { case resolvingName, findingSite, ready, failed(String) }
        public let input: String
        public var phase: Phase
        public var name: String?
        public var root: String?
        public var path = "/"
    }

    public let store: SiteStore
    private let queue = DispatchQueue(label: "meshsites.service")
    private var transport: Transport?
    private var gossip: Gossip
    private var announceTimer: DispatchSourceTimer?
    private var pendingWants: [String: String] = [:] // reqId hex → root
    /// HAVEs collected per root while a WANT is open (on `queue`).
    private var haveCollect: [String: [Fetch.Holder]] = [:]
    private let server: BlockServer
    private var fetchers: [String: Fetcher] = [:]
    private var fetchTimers: [String: DispatchSourceTimer] = [:]
    private var fetchStarted: [String: Date] = [:]
    /// root → ENS name (and status) to store a downloaded site under. Owned by `queue`.
    private var downloadNames: [String: (name: String, status: String?)] = [:]
    /// Recently served sites (root → blocks), so a batch doesn't re-read the CAR per request.
    private var sourceCache: [(root: String, blocks: DictBlockSource)] = []
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
        Self.addTrustAnchors(&gossip)
        var scfg = BlockServer.Config()
        scfg.seeding = seeding
        server = BlockServer(config: scfg)
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
                self.sourceCache.removeAll { c in !sites.contains { $0.root == c.root } }
                self.nameUnnamedSites()
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
                haveCollect[root, default: []].append(Fetch.Holder(peer: h.from, via: .ble, hops: Int(h.hops),
                                                                   sizeBytes: Int(h.sizeBytes), blockCount: Int(h.blockCount)))
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



    // MARK: block transfer (M4)

    /// bitchat hook: one decrypted direct message (Noise payload type 0x4D) from `peer`.
    public func receiveDirect(payload: Data, from peer: Data) {
        queue.async { [self] in
            guard let t = transport else { return }
            let p = peer.hex
            let now = Date().timeIntervalSince(start) * 1000
            appendLog("direct \(Self.label(payload)) from \(Self.short(p)), \(payload.count) B")
            let v = server.handle(peer: p, payload: Array(payload), now: now) { [self] root, cid in self.lookup(root: root, cid: cid) }
            switch v {
            case .reply(let messages):
                appendLog("BLOCK_REQ from \(Self.short(p)): serving \(messages.filter { if case .block = $0 { return true }; return false }.count)/\(messages.count)")
                for m in messages { if let b = try? Wire.encode(m) { sendPaced(Data(b), to: peer, via: t) } }
            case .block(let cid, let bytes):
                for (root, f) in fetchers { drive(root, f.onBlock(peer: p, cid: cid, bytes: bytes, now: now)) }
            case .blockNone(let cid):
                for (root, f) in fetchers { drive(root, f.onBlockNone(peer: p, cid: cid, now: now)) }
            case .drop(let reason, let spam):
                if spam || reason == "not-seeding" { appendLog("direct message from \(Self.short(p)) dropped: \(reason)") }
            }
            publish()
        }
    }

    /// Replies to one peer go out at most `paceLanes` at a time, each lane held for the reply's
    /// estimated airtime. bitchat starts every fragmented reply as its own train (one fragment per
    /// 25 ms, no transfer ID, so its 2-train limit doesn't apply). Measured 2026-11-07 on a 290 B
    /// link: even 2 trains keep bitchat's 128-entry notify retry queue busy (~75 re-queues/s), so 7
    /// at once risk overflowing it. (The block loss itself was oversized fragments, fork patch 8.)
    private static let paceLanes = 2
    private static let paceChunkBytes = 232.0     // fragment chunk on a 290 B link (patch 8 headroom)
    private static let paceFragmentSeconds = 0.025 // bitchat's directed fragment spacing
    private static let paceMarginSeconds = 0.05
    /// peer hex → when each lane is free again (seconds since `start`). Owned by `queue`.
    private var paceLaneFree: [String: [TimeInterval]] = [:]

    private func sendPaced(_ payload: Data, to peer: Data, via t: Transport) {
        let key = peer.hex
        let now = Date().timeIntervalSince(start)
        var lanes = paceLaneFree[key] ?? Array(repeating: 0, count: Self.paceLanes)
        let lane = lanes.indices.min { lanes[$0] < lanes[$1] }!
        let sendAt = max(now, lanes[lane])
        let fragments = (Double(payload.count) / Self.paceChunkBytes).rounded(.up)
        lanes[lane] = sendAt + fragments * Self.paceFragmentSeconds + Self.paceMarginSeconds
        paceLaneFree[key] = lanes
        let delay = sendAt - now
        if delay <= 0 { t.sendDirect(payload, peer); return }
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let t = self?.transport else { return }
            t.sendDirect(payload, peer)
        }
    }

    // MARK: address bar (D14)

    /// meshsites.eth's signed record and signer, as published on ENS (text records
    /// `meshsites.record` / `meshsites.signer`, read 2026-11-07). A built-in trust anchor like the
    /// probe site: every copy of the app resolves meshsites.eth offline as Verified and can answer
    /// nearby name lookups for it. Update after every re-pin of meshsites.eth.
    static let anchorName = "meshsites.eth"
    static let anchorSigner = "0x8e0783451d07ba750f201ae9bf6d93385e6da410"
    static let anchorRecord = #"{"record":{"v":1,"name":"meshsites.eth","cid":"bafybeiavlfc4pq7nk4zbyiai35p56l5uvgyvzl5jq4uoq6g3hyormilx4m","origCid":"bafybeiac2sgltcqclwhe7w5pvhmo3ymd2jpdsn3xmlpeexozbr3n45w4na","seq":1794098330,"ts":1794098330,"signer":"0x8e0783451d07ba750f201ae9bf6d93385e6da410"},"sig":"0x74fd09650dc4a9a513878cf1b7d08c15ece6559237f09f862bb87aa1bd858c6e3b54514e6415e65b6beac8bad39fe15f1422c5f0c3cf660baad5233aeb8e24951c"}"#

    static func addTrustAnchors(_ g: inout Gossip) {
        g.trust(name: anchorName, signer: anchorSigner)
        _ = try? g.addRecord(anchorRecord, nowSec: Int64(Date().timeIntervalSince1970))
    }

    private static let nameWait: TimeInterval = 3

    /// Open whatever was typed: a stored copy right away, otherwise resolve the name over the mesh
    /// (WANT by name → a signed NAME_RECORD), find the site (WANT by CID) and download it.
    /// Never touches the internet. `lookup` tracks progress; `.ready` means stored and openable.
    public func open(_ input: String) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let address = SiteAddress.parse(text) else {
            setLookup(Lookup(input: text, phase: .failed("Not a site address. Try a name like meshsites.eth or an ipfs:// link.")))
            return
        }
        queue.async { [self] in
            switch address {
            case .cid(let cid, let path):
                openRoot(meshRoot(for: cid.description), name: nil, status: nil, path: path, input: text)
            case .name(let name, let path):
                if let n = gossip.names[name] {
                    openRoot(n.root, name: name, status: n.status.rawValue, path: path, input: text)
                } else if let site = storedSites.first(where: { $0.name == name }) {
                    openRoot(site.root, name: name, status: site.nameStatus, path: path, input: text)
                } else {
                    resolveName(name, path: path, input: text)
                }
            }
        }
    }

    public func clearLookup() { setLookup(nil) }

    /// Hold a signed NAME_RECORD (from a publisher, or the gateway mode of M5) so this device
    /// resolves the name and answers nearby lookups for it. `signer`, when known from ENS, marks it Verified.
    /// Lost when bitchat's identity changes (panic wipe), like everything else the policy learned.
    public func addNameRecord(_ signedText: String, signer: String? = nil, done: ((Result<String, Error>) -> Void)? = nil) {
        queue.async { [self] in
            do {
                if let signer, let name = (try? JSON.parse(signedText))?["record"]?["name"]?.string { gossip.trust(name: name, signer: signer) }
                let status = try gossip.addRecord(signedText, nowSec: Int64(Date().timeIntervalSince1970))
                nameUnnamedSites()
                done?(.success(status.rawValue))
            } catch {
                done?(.failure(error))
            }
        }
    }

    /// A site stored without a name (downloaded from the nearby list, imported from a file) takes the
    /// name of a signed record this device holds for that exact CID, Verified first. Runs on `queue`.
    private func nameUnnamedSites() {
        let pending: [(root: String, name: String, status: String)] = storedSites.compactMap { site in
            guard site.name == nil else { return nil }
            let matches = gossip.names.filter { $0.value.root == site.root }.sorted { $0.key < $1.key }
            guard let best = matches.first(where: { $0.value.status == .verified }) ?? matches.first else { return nil }
            return (site.root, best.key, best.value.status.rawValue)
        }
        guard !pending.isEmpty else { return }
        Task { @MainActor [weak self] in
            for p in pending { self?.store.setName(p.root, name: p.name, status: p.status) }
        }
    }

    /// A gateway link carries the site's original CID; the mesh knows it by the 16 KiB-chunk CID.
    /// Map one to the other when a name record we hold says so.
    private func meshRoot(for root: String) -> String {
        gossip.names.values.first { n in
            let record = (try? JSON.parse(n.signed))?["record"]
            return (record.flatMap { try? Records.wellFormed($0) })?.origCid.description == root
        }?.root ?? root
    }

    private func resolveName(_ name: String, path: String, input: String) {
        guard transport != nil else {
            setLookup(Lookup(input: input, phase: .failed("The mesh is not connected yet."), name: name, path: path))
            return
        }
        setLookup(Lookup(input: input, phase: .resolvingName, name: name, path: path))
        var reqId = Bytes(repeating: 0, count: 8)
        for i in reqId.indices { reqId[i] = UInt8.random(in: 0...255) }
        appendLog("WANT name \(name)")
        send(Gossip.Outgoing(message: .want(reqId: reqId, origTtl: Wire.TTL.want, root: nil, name: name), ttl: Wire.TTL.want, recipient: nil))
        pollName(name, path: path, input: input, until: Date().addingTimeInterval(Self.nameWait))
    }

    private func pollName(_ name: String, path: String, input: String, until: Date) {
        if let n = gossip.names[name] {
            openRoot(n.root, name: name, status: n.status.rawValue, path: path, input: input)
        } else if Date() >= until {
            setLookup(Lookup(input: input, phase: .failed("Nobody nearby has a signed record for \(name)."), name: name, path: path))
        } else {
            queue.asyncAfter(deadline: .now() + 0.25) { [self] in pollName(name, path: path, input: input, until: until) }
        }
    }

    private func openRoot(_ root: String, name: String?, status: String?, path: String, input: String) {
        let base = Lookup(input: input, phase: .findingSite, name: name, root: root, path: path)
        if storedSites.contains(where: { $0.root == root }) {
            var l = base; l.phase = .ready
            setLookup(l)
            return
        }
        guard transport != nil else {
            var l = base; l.phase = .failed("Not stored here, and the mesh is not connected yet.")
            setLookup(l)
            return
        }
        setLookup(base)
        download(root: root, name: name, nameStatus: status)
    }

    private func setLookup(_ l: Lookup?) {
        DispatchQueue.main.async { self.lookup = l }
    }

    private func updateLookup(root: String, _ change: @escaping (inout Lookup) -> Void) {
        DispatchQueue.main.async {
            guard var l = self.lookup, l.root == root, l.phase == .findingSite else { return }
            change(&l)
            self.lookup = l
        }
    }

    /// Find holders of `root` (WANT, 3 s), then pull it block by block and store it.
    public func download(root: String, name: String? = nil, nameStatus: String? = nil) {
        guard let cid = try? CID.parse(root) else { return }
        queue.async { [self] in
            guard transport != nil, fetchers[root] == nil else { return }
            if let name { downloadNames[root] = (name, nameStatus) }
            setDownload(root, Download(phase: .asking))
            fetchStarted[root] = Date()
            haveCollect[root] = []
            sendWant(root: root, cid: cid)
            queue.asyncAfter(deadline: .now() + Self.haveWindow) { [self] in
                let holders = haveCollect[root] ?? []
                haveCollect[root] = nil
                guard !holders.isEmpty else {
                    finishDownload(root, error: "nobody nearby has it")
                    return
                }
                let local = DictBlockSource([:])
                let f = Fetcher(root: cid, holders: holders, local: local)
                fetchers[root] = f
                appendLog("downloading \(Self.short(root)) from \(f.holders.map { "\(Self.short($0.peer)) (\($0.hops) hop)" }.joined(separator: ", "))")
                drive(root, f.start(now: Date().timeIntervalSince(start) * 1000))
            }
        }
    }

    private func drive(_ root: String, _ actions: [Fetch.Action]) {
        guard let t = transport, let f = fetchers[root] else { return }
        for a in actions {
            switch a {
            case .request(let peer, let via, let r, let cids, let deadline):
                if let msg = try? Wire.encode(.blockReq(root: r, cids: cids)), let to = Hex.decode(peer) {
                    let budget = (deadline - Date().timeIntervalSince(start) * 1000) / 1000
                    appendLog("BLOCK_REQ \(cids.count) block(s) → \(Self.short(peer)) over \(via.rawValue), \(String(format: "%.1f", budget)) s budget")
                    t.sendDirect(Data(msg), Data(to))
                }
                updateDownload(root) { $0.phase = .downloading; $0.peer = peer; $0.via = via.rawValue; $0.expectedBlocks = f.current?.blockCount ?? 0 }
                scheduleFetchTick(root, at: deadline)
            case .stored(_, let b):
                updateDownload(root) { $0.blocks += 1; $0.bytes += b.count }
            case .blame(let peer, let reason):
                appendLog("rejected a block from \(Self.short(peer)): \(reason)")
            case .next(let from, let reason):
                appendLog("\(Self.short(from)): \(reason), trying the next holder")
            case .done(let total, let count):
                appendLog("downloaded \(Self.short(root)): \(count) blocks, \(total) B")
                storeFetched(root, f)
            case .failed(let reason, let detail):
                finishDownload(root, error: detail.map { "\(reason): \($0)" } ?? reason)
            }
        }
    }

    private func scheduleFetchTick(_ root: String, at deadline: Double) {
        fetchTimers[root]?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        let delay = max(0, deadline - Date().timeIntervalSince(start) * 1000) / 1000 + 0.05
        t.schedule(deadline: .now() + delay)
        t.setEventHandler { [weak self] in
            guard let self, let f = self.fetchers[root] else { return }
            self.drive(root, f.tick(now: Date().timeIntervalSince(self.start) * 1000))
        }
        t.resume()
        fetchTimers[root] = t
    }

    /// Write the verified DAG as a CAR (DFS order) and import it; the store verifies it again.
    private func storeFetched(_ root: String, _ f: Fetcher) {
        guard let cid = try? CID.parse(root) else { return }
        var ordered: [(cid: CID, bytes: Bytes)] = []
        var seen = Set<CID>()
        var stack = [cid]
        while let c = stack.popLast() {
            guard seen.insert(c).inserted, let b = f.block(c) else { continue }
            ordered.append((c, b))
            if c.codec == Codec.dagPB, let node = try? PBNode.decode(b) { for l in node.links.reversed() { stack.append(l.hash) } }
        }
        let car = CARFile.write(root: cid, blocks: ordered)
        let seconds = fetchStarted[root].map { Date().timeIntervalSince($0) }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let named = self.queue.sync { self.downloadNames.removeValue(forKey: root) }
                _ = try self.store.importCar(car, label: "from mesh", name: named?.name, nameStatus: named?.status)
                self.queue.async { self.finishDownload(root, error: nil, seconds: seconds) }
            } catch {
                self.queue.async { self.finishDownload(root, error: error.localizedDescription) }
            }
        }
    }

    private func finishDownload(_ root: String, error: String?, seconds: Double? = nil) {
        fetchers[root] = nil
        fetchTimers[root]?.cancel()
        fetchTimers[root] = nil
        let secs = seconds ?? fetchStarted[root].map { Date().timeIntervalSince($0) }
        fetchStarted[root] = nil
        if let error { appendLog("download \(Self.short(root)) failed: \(error)"); downloadNames[root] = nil }
        updateLookup(root: root) { $0.phase = error.map { .failed("Download failed: \($0)") } ?? .ready }
        updateDownload(root) { $0.phase = error == nil ? .done : .failed; $0.error = error; $0.seconds = secs }
    }

    private func setDownload(_ root: String, _ d: Download) {
        DispatchQueue.main.async { self.downloads[root] = d }
    }

    private func updateDownload(_ root: String, _ change: @escaping (inout Download) -> Void) {
        DispatchQueue.main.async {
            var d = self.downloads[root] ?? Download(phase: .asking)
            change(&d)
            self.downloads[root] = d
        }
    }

    /// Blocks are only served from the complete stored site the request names.
    private func lookup(root: CID, cid: CID) -> Bytes? {
        let key = root.description
        guard storedSites.contains(where: { $0.root == key }) else { return nil }
        if let hit = sourceCache.first(where: { $0.root == key }) { return hit.blocks.block(cid) }
        guard let (_, src) = store.readVerifiedSource(key) else { return nil }
        sourceCache.insert((key, src), at: 0)
        if sourceCache.count > 3 { sourceCache.removeLast() }
        return src.block(cid)
    }

    private func sendWant(root: String, cid: CID) {
        var reqId = Bytes(repeating: 0, count: 8)
        for i in reqId.indices { reqId[i] = UInt8.random(in: 0...255) }
        pendingWants[Hex.encode(reqId)] = root
        appendLog("WANT \(Self.short(root))")
        send(Gossip.Outgoing(message: .want(reqId: reqId, origTtl: Wire.TTL.want, root: cid, name: nil), ttl: Wire.TTL.want, recipient: nil))
        queue.asyncAfter(deadline: .now() + Self.haveWindow + 0.5) { [self] in pendingWants[Hex.encode(reqId)] = nil }
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
        Self.addTrustAnchors(&gossip)
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
        f.dateFormat = "HH:mm:ss.SSS"
        let entry = "\(f.string(from: Date())) \(line)"
        DispatchQueue.main.async {
            self.log.append(entry)
            if self.log.count > 40 { self.log.removeFirst(self.log.count - 40) }
        }
        Self.logQueue.async { Self.writeLogFile(entry) }
    }

    /// Activity log on disk, for test sessions: Library/Application Support/MeshSites/activity.log
    /// (copy it off a device with `xcrun devicectl device copy from --domain-type appDataContainer`).
    /// Capped at ~256 KB, keeping the newest half when it fills.
    private static let logQueue = DispatchQueue(label: "meshsites.log")
    private static let logURL: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("MeshSites/activity.log")

    private static func writeLogFile(_ entry: String) {
        let line = Data((entry + "\n").utf8)
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let size = (try? fm.attributesOfItem(atPath: logURL.path)[.size] as? Int), size > 256 * 1024,
           let old = try? Data(contentsOf: logURL) {
            try? old.suffix(128 * 1024).write(to: logURL, options: .atomic)
        }
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile()
            h.write(line)
            try? h.close()
        } else {
            try? line.write(to: logURL)
        }
    }

    static func short(_ s: String) -> String { s.count > 12 ? "\(s.prefix(6))…\(s.suffix(4))" : s }

    static func label(_ payload: Data) -> String {
        switch Wire.decodeSubtype(payload) {
        case Wire.Sub.announce: return "ANNOUNCE"
        case Wire.Sub.nameRecord: return "NAME_RECORD"
        case Wire.Sub.want: return "WANT"
        case Wire.Sub.have: return "HAVE"
        case Wire.Sub.blockReq: return "BLOCK_REQ"
        case Wire.Sub.block: return "BLOCK"
        case Wire.Sub.blockNone: return "BLOCK_NONE"
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
