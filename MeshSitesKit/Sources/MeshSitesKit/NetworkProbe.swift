import Foundation
import MeshSitesCore
import WebKit

public struct ProbeResult: Decodable, Identifiable, Hashable {
    public var id: String { key }
    public let key: String
    public let what: String
    public let expect: String
    public let got: String
    public let detail: String?

    enum CodingKeys: String, CodingKey { case key = "id", what, expect, got, detail }

    public var passed: Bool { got == expect }
}

/// The explicit no-network test (M2): renders the shared probe site
/// (protocol/vectors/probe-site) in the real locked-down web view and
/// collects what it could reach.
@MainActor
public final class NetworkProbe: NSObject, WKScriptMessageHandler {
    public static var probeCar: Bytes {
        guard let url = Bundle.module.url(forResource: "probe-site", withExtension: "car"), let d = try? Data(contentsOf: url) else { return [] }
        return Array(d)
    }

    private var continuation: CheckedContinuation<[ProbeResult], Error>?
    private var webView: WKWebView?

    public override init() {}

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String, let data = text.data(using: .utf8) else { return }
        let results = (try? JSONDecoder().decode([ProbeResult].self, from: data)) ?? []
        continuation?.resume(returning: results)
        continuation = nil
    }

    /// Imports the probe into `store`, renders it, returns its findings.
    public func run(store: SiteStore, timeout: TimeInterval = 60) async throws -> [ProbeResult] {
        let site = try store.importCar(Self.probeCar, label: "network probe")
        defer { store.delete(site.root) }
        let config = try await SiteWebConfiguration.make(store: store, probeHandler: self)
        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 400), configuration: config)
        let policy = SiteNavigationPolicy(root: site.root)
        wv.navigationDelegate = policy
        webView = wv
        defer {
            webView = nil
            _ = policy
        }
        return try await withCheckedThrowingContinuation { c in
            continuation = c
            wv.load(URLRequest(url: URL(string: "\(MeshSiteSchemeHandler.scheme)://\(site.root)/")!))
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self, let c = self.continuation else { return }
                self.continuation = nil
                c.resume(throwing: URLError(.timedOut))
            }
        }
    }
}
