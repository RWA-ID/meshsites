import Foundation

/// What a person typed into the address bar, reduced to something the mesh can look up:
/// a content ID or an ENS name, plus the page path inside the site (D14).
///
/// Accepted forms (query and fragment are dropped):
///   bafy…                       ipfs://bafy…/page.html        meshsite://bafy…/
///   /ipfs/bafy…/page.html       https://gw.example/ipfs/bafy…/page.html
///   https://bafy….ipfs.dweb.link/page.html
///   name.eth                    name.eth/page.html            ipns://name.eth/
///   https://name.eth.limo/page.html   https://name.eth.link/   /ipns/name.eth/
public enum SiteAddress: Equatable {
    case cid(CID, path: String)
    case name(String, path: String)

    public var path: String {
        switch self {
        case .cid(_, let p), .name(_, let p): return p
        }
    }

    public static func parse(_ input: String) -> SiteAddress? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, !s.contains(where: { $0.isWhitespace }) else { return nil }
        if let i = s.firstIndex(where: { $0 == "?" || $0 == "#" }) { s = String(s[..<i]) }

        // scheme://rest
        if let r = s.range(of: "://") {
            let scheme = s[..<r.lowerBound].lowercased()
            let rest = String(s[r.upperBound...])
            let (host, path) = split(rest)
            switch scheme {
            case "ipfs", "meshsite":
                return cid(host, path)
            case "ipns":
                return name(host, path)
            case "http", "https":
                return web(host: host, path: path)
            default:
                return nil
            }
        }

        // /ipfs/… and /ipns/… paths
        if s.hasPrefix("/") { return gatewayPath(s) }

        // bare CID or name, optionally followed by a path
        let (head, path) = split(s)
        return cid(head, path) ?? name(head, path)
    }

    // MARK: pieces

    private static func web(host rawHost: String, path: String) -> SiteAddress? {
        var host = rawHost.lowercased()
        if let at = host.lastIndex(of: "@") { host = String(host[host.index(after: at)...]) }
        if let colon = host.lastIndex(of: ":") { host = String(host[..<colon]) }
        for suffix in [".eth.limo", ".eth.link"] where host.hasSuffix(suffix) {
            return name(String(host.dropLast(suffix.count - ".eth".count)), path)
        }
        if host.hasSuffix(".eth") { return name(host, path) }
        // Subdomain gateways: <cid>.ipfs.<gateway>
        if let r = rawHost.range(of: ".ipfs.", options: .caseInsensitive) {
            return cid(String(rawHost[..<r.lowerBound]), path)
        }
        // Path gateways: <gateway>/ipfs/<cid>/…
        return gatewayPath(path)
    }

    private static func gatewayPath(_ p: String) -> SiteAddress? {
        let parts = p.split(separator: "/", maxSplits: 2, omittingEmptySubsequences: true)
        guard parts.count >= 2 else { return nil }
        let rest = parts.count == 3 ? "/" + parts[2] : "/"
        switch parts[0] {
        case "ipfs": return cid(String(parts[1]), rest)
        case "ipns": return name(String(parts[1]), rest)
        default: return nil
        }
    }

    private static func cid(_ s: String, _ path: String) -> SiteAddress? {
        guard let c = try? CID.parse(s) else { return nil }
        return .cid(c, path: path)
    }

    /// ENS-style name ending in `.eth`: lowercase labels of letters, digits, `-` and `_`.
    /// (Full ENS normalisation is the publisher's job; the record carries the normalised name.)
    private static func name(_ s: String, _ path: String) -> SiteAddress? {
        let n = s.lowercased()
        guard n.hasSuffix(".eth"), n.count <= 255 else { return nil }
        let labels = n.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.allSatisfy({ label in
            !label.isEmpty && label.count <= 63 && label.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        }) else { return nil }
        return .name(n, path: path)
    }

    /// "host/a/b" → ("host", "/a/b"); "host" → ("host", "/").
    private static func split(_ s: String) -> (String, String) {
        guard let i = s.firstIndex(of: "/") else { return (s, "/") }
        let path = String(s[i...])
        return (String(s[..<i]), normalize(path))
    }

    /// Collapse duplicate slashes and drop `.` / `..` segments so a path can't climb out of the site.
    private static func normalize(_ p: String) -> String {
        var out: [Substring] = []
        for seg in p.split(separator: "/", omittingEmptySubsequences: true) {
            if seg == "." { continue }
            if seg == ".." { _ = out.popLast(); continue }
            out.append(seg)
        }
        let joined = "/" + out.joined(separator: "/")
        return p.hasSuffix("/") && joined != "/" ? joined + "/" : joined
    }
}
