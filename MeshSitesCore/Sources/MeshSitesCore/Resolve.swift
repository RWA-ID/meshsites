/// Resolve a URL path inside a VERIFIED site DAG (verifyDag ok) to file bytes.
/// Used by the iOS `meshsite://` scheme handler. Mirrors resolve.ts.

public enum Resolved: Equatable {
    case file(path: String, bytes: Bytes, mime: String)
    case redirect(location: String)
    case notFound
}

public enum Resolver {
    static let mimes: [String: String] = [
        "html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8",
        "css": "text/css; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "json": "application/json", "txt": "text/plain; charset=utf-8", "md": "text/plain; charset=utf-8",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "avif": "image/avif", "ico": "image/x-icon", "woff": "font/woff", "woff2": "font/woff2",
        "wasm": "application/wasm", "webmanifest": "application/manifest+json", "xml": "application/xml",
        "pdf": "application/pdf", "mp3": "audio/mpeg", "mp4": "video/mp4",
    ]

    public static func mime(for path: String) -> String {
        let last = path.lowercased().split(separator: "/").last.map(String.init) ?? ""
        let ext = last.split(separator: ".").last.map(String.init) ?? ""
        return mimes[ext] ?? "application/octet-stream"
    }

    static func fileBytes(_ cid: CID, _ src: BlockSource) throws -> Bytes {
        guard let b = src.block(cid) else { throw DecodeError("missing block \(cid)") }
        if cid.codec == Codec.raw { return b }
        let node = try PBNode.decode(b)
        let fs = try UnixFSData.decode(node.data ?? [])
        if fs.type == .directory { throw DecodeError("is a directory") }
        var out = fs.data ?? []
        for l in node.links { out += try fileBytes(l.hash, src) }
        return out
    }

    static func lookup(_ dir: CID, _ name: String, _ src: BlockSource) -> CID? {
        guard dir.codec == Codec.dagPB, let b = src.block(dir), let node = try? PBNode.decode(b),
              (try? UnixFSData.decode(node.data ?? []))?.type == .directory else { return nil }
        return node.links.first { $0.name == name }?.hash
    }

    static func isDir(_ cid: CID, _ src: BlockSource) -> Bool {
        guard cid.codec == Codec.dagPB, let b = src.block(cid), let node = try? PBNode.decode(b) else { return false }
        return (try? UnixFSData.decode(node.data ?? []))?.type == .directory
    }

    /// `path` is URL-decoded, '/'-separated, relative to the site root.
    public static func resolve(root: CID, path: String, source src: BlockSource) throws -> Resolved {
        let segs = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init).filter { $0 != "." }
        if segs.contains("..") { return .notFound }
        var cur = root
        for s in segs {
            guard let next = lookup(cur, s, src) else { return .notFound }
            cur = next
        }
        if isDir(cur, src) {
            if !segs.isEmpty && !path.hasSuffix("/") { return .redirect(location: segs.last! + "/") }
            guard let index = lookup(cur, "index.html", src) else { return .notFound }
            return .file(path: (segs + ["index.html"]).joined(separator: "/"), bytes: try fileBytes(index, src), mime: mimes["html"]!)
        }
        let p = segs.joined(separator: "/")
        return .file(path: p, bytes: try fileBytes(cur, src), mime: mime(for: p))
    }
}
