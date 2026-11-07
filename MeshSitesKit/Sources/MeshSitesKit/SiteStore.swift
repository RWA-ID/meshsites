import Foundation
import MeshSitesCore

/// Metadata for a stored site. The CAR itself is the source of truth.
public struct StoredSite: Codable, Identifiable, Hashable {
    public var id: String { root }
    public let root: String
    public var label: String
    /// ENS name, if the site was opened by name.
    public var name: String?
    /// "verified" / "unverified" for a name, nil for a raw CID.
    public var nameStatus: String?
    public let sizeBytes: Int
    public let blockCount: Int
    public let importedAt: Date
}

public enum SiteStoreError: LocalizedError {
    case tooLarge(Int)
    case invalid(String)
    case cacheFull(needed: Int, free: Int)
    case notFound

    public var errorDescription: String? {
        switch self {
        case .tooLarge(let n): return "This file is \(n / 1024) KiB; MeshSites sites are at most \(Limits.maxSiteBytes / 1024) KiB."
        case .invalid(let why): return "Rejected: \(why)"
        case .cacheFull(let needed, let free): return "Not enough room in the site cache (\(needed / 1024) KiB needed, \(free / 1024) KiB free)."
        case .notFound: return "That site is not stored on this device."
        }
    }
}

/// Stores only CARs that pass full verification, and verifies again when a
/// site is loaded for rendering (the store on disk is not trusted).
@MainActor
public final class SiteStore: ObservableObject {
    public static let shared = SiteStore()

    /// Total cache cap (SPEC: 64 MiB, configurable). LRU eviction is M6.
    public var maxCacheBytes = 64 * 1024 * 1024

    @Published public private(set) var sites: [StoredSite] = []

    let dir: URL
    private var loaded: [String: (CID, DictBlockSource)] = [:]

    public init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MeshSites/sites", isDirectory: true)
        dir = base
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        reload()
    }

    func carURL(_ root: String) -> URL { dir.appendingPathComponent("\(root).car") }
    func metaURL(_ root: String) -> URL { dir.appendingPathComponent("\(root).json") }

    public func reload() {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        sites = files.filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(StoredSite.self, from: Data(contentsOf: $0)) }
            .sorted { $0.importedAt > $1.importedAt }
    }

    public var usedBytes: Int { sites.reduce(0) { $0 + $1.sizeBytes } }

    /// Import a CAR file (Files app, AirDrop, a gateway). Size-checked before
    /// reading, fully verified before anything is written.
    @discardableResult
    public func importCar(at url: URL, label: String? = nil) throws -> StoredSite {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        // CAR framing adds a little over the block bytes; refuse clearly oversized files unread.
        if size > Limits.maxSiteBytes + 256 * 1024 { throw SiteStoreError.tooLarge(size) }
        let data = try Data(contentsOf: url)
        return try importCar(Array(data), label: label ?? url.deletingPathExtension().lastPathComponent)
    }

    @discardableResult
    public func importCar(_ car: Bytes, label: String, name: String? = nil, nameStatus: String? = nil) throws -> StoredSite {
        let v = Verify.verifyCar(car)
        guard v.ok, let root = v.root else { throw SiteStoreError.invalid(v.errors.first ?? "unknown error") }
        let key = root.description
        let existing = sites.first { $0.root == key }
        let free = maxCacheBytes - usedBytes + (existing?.sizeBytes ?? 0)
        if v.totalBytes > free { throw SiteStoreError.cacheFull(needed: v.totalBytes, free: free) }
        let site = StoredSite(root: key, label: existing?.label ?? label, name: name ?? existing?.name, nameStatus: nameStatus ?? existing?.nameStatus,
                              sizeBytes: v.totalBytes, blockCount: v.blockCount, importedAt: Date())
        try Data(car).write(to: carURL(key), options: .atomic)
        try JSONEncoder().encode(site).write(to: metaURL(key), options: .atomic)
        loaded[key] = nil
        reload()
        return site
    }

    public func delete(_ root: String) {
        try? FileManager.default.removeItem(at: carURL(root))
        try? FileManager.default.removeItem(at: metaURL(root))
        loaded[root] = nil
        reload()
    }

    /// Verified blocks of a stored site, read from disk on any thread (serving
    /// BLOCK_REQ from the mesh queue). Nil if missing or not a complete, valid DAG.
    nonisolated public func readVerifiedSource(_ root: String) -> (CID, DictBlockSource)? {
        let url = dir.appendingPathComponent("\(root).car")
        guard let data = try? Data(contentsOf: url), let parsed = try? Verify.readCar(Array(data)),
              parsed.errors.isEmpty, parsed.root.description == root else { return nil }
        let src = DictBlockSource(parsed.blocks)
        guard Verify.verifyDag(root: parsed.root, source: src).ok else { return nil }
        return (parsed.root, src)
    }

    /// Verified blocks for rendering. Re-verifies the CAR on first load.
    public func source(for root: String) throws -> (CID, BlockSource) {
        if let l = loaded[root] { return l }
        guard let data = try? Data(contentsOf: carURL(root)) else { throw SiteStoreError.notFound }
        let parsed = try Verify.readCar(Array(data))
        guard parsed.errors.isEmpty, parsed.root.description == root else { throw SiteStoreError.invalid(parsed.errors.first ?? "root mismatch") }
        let src = DictBlockSource(parsed.blocks)
        let dag = Verify.verifyDag(root: parsed.root, source: src)
        guard dag.ok else { throw SiteStoreError.invalid(dag.errors.first ?? "\(dag.missing.count) block(s) missing") }
        loaded[root] = (parsed.root, src)
        return (parsed.root, src)
    }
}
