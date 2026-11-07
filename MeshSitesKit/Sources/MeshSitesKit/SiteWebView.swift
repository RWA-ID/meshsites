import Foundation
import MeshSitesCore
import WebKit

/// Serves meshsite://<cid>/<path> from verified local blocks.
/// Each CID is its own origin, so sites can't read each other's storage.
@MainActor
public final class MeshSiteSchemeHandler: NSObject, WKURLSchemeHandler {
    public static let scheme = "meshsite"
    let store: SiteStore
    private var stopped = Set<ObjectIdentifier>()

    public init(store: SiteStore) { self.store = store }

    /// Every source is this site's own origin. connect-src covers fetch/XHR/
    /// WebSocket/EventSource/beacons; frame-src 'none' covers iframes.
    static func csp(_ root: String) -> String {
        let own = "\(scheme)://\(root)"
        return [
            "default-src \(own)", "script-src \(own) 'unsafe-inline'", "style-src \(own) 'unsafe-inline'",
            "img-src \(own) data: blob:", "font-src \(own) data:", "media-src \(own) blob:", "connect-src \(own)",
            "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri \(own)",
        ].joined(separator: "; ")
    }

    public func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == Self.scheme, let root = url.host?.lowercased() else {
            return task.didFailWithError(URLError(.badURL))
        }
        // A page may only load from its own site.
        if let main = task.request.mainDocumentURL, main.scheme == Self.scheme, main.host?.lowercased() != root {
            return respond(task, url: url, status: 403, mime: "text/plain", body: Array("Blocked: a site may not read another site".utf8), root: root)
        }
        let path = (url.path.removingPercentEncoding ?? url.path)
        let trailing = url.absoluteString.hasSuffix("/") || url.path.isEmpty
        do {
            let (cid, src) = try store.source(for: root)
            switch try Resolver.resolve(root: cid, path: trailing && !path.hasSuffix("/") ? path + "/" : path, source: src) {
            case .file(_, let bytes, let mime):
                respond(task, url: url, status: 200, mime: mime, body: bytes, root: root)
            case .redirect(let location):
                // Scheme handlers can't issue HTTP redirects; send the browser to the slash form.
                let html = "<!doctype html><meta http-equiv=\"refresh\" content=\"0;url=\(location)\">"
                respond(task, url: url, status: 200, mime: "text/html; charset=utf-8", body: Array(html.utf8), root: root)
            case .notFound:
                respond(task, url: url, status: 404, mime: "text/plain; charset=utf-8", body: Array("Not found in this site".utf8), root: root)
            }
        } catch {
            respond(task, url: url, status: 404, mime: "text/plain; charset=utf-8", body: Array("Not available offline: \(error.localizedDescription)".utf8), root: root)
        }
    }

    public func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mime: String, body: Bytes, root: String) {
        if stopped.remove(ObjectIdentifier(task)) != nil { return }
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(body.count),
            "Content-Security-Policy": Self.csp(root),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
        ]
        let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(resp)
        task.didReceive(Data(body))
        task.didFinish()
    }
}

/// Builds the locked-down WKWebView configuration for rendering sites.
@MainActor
public enum SiteWebConfiguration {
    /// Blocks every load except meshsite:// (HTTP, HTTPS, WebSocket, data
    /// fetches…). Compiled once and cached by WebKit.
    static let ruleListJSON = """
    [
      {"trigger": {"url-filter": ".*"}, "action": {"type": "block"}},
      {"trigger": {"url-filter": "^meshsite://"}, "action": {"type": "ignore-previous-rules"}}
    ]
    """

    /// Runs before any site script, in every frame: removes APIs that CSP
    /// can't govern (WebRTC) or that a static site never needs.
    static let lockdownScript = """
    (() => {
      const kill = (obj, name) => { try { Object.defineProperty(obj, name, { value: undefined, writable: false, configurable: false }); } catch (e) {} };
      for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'WebTransport'])
        kill(window, n);
      if (navigator.mediaDevices) kill(navigator, 'mediaDevices');
      kill(navigator, 'geolocation');
    })();
    """

    private static var ruleList: WKContentRuleList?

    public static func make(store: SiteStore, probeHandler: WKScriptMessageHandler? = nil) async throws -> WKWebViewConfiguration {
        if ruleList == nil {
            ruleList = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "meshsites-offline-v1", encodedContentRuleList: ruleListJSON)
        }
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MeshSiteSchemeHandler(store: store), forURLScheme: MeshSiteSchemeHandler.scheme)
        config.websiteDataStore = .nonPersistent()
        config.preferences.isFraudulentWebsiteWarningEnabled = false // Safe Browsing makes network lookups
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.add(ruleList!)
        config.userContentController.addUserScript(WKUserScript(source: lockdownScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        if let probeHandler { config.userContentController.add(probeHandler, name: "meshsitesProbe") }
        #if os(iOS)
        config.dataDetectorTypes = []
        config.allowsInlineMediaPlayback = true
        #endif
        return config
    }
}

/// Navigation policy: only meshsite://<same cid>; everything else is cancelled.
@MainActor
public final class SiteNavigationPolicy: NSObject, WKNavigationDelegate {
    let root: String
    public var onBlocked: ((URL) -> Void)?

    public init(root: String) { self.root = root }

    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == MeshSiteSchemeHandler.scheme && url.host?.lowercased() == root { return decisionHandler(.allow) }
        if url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" { return decisionHandler(.allow) }
        onBlocked?(url)
        decisionHandler(.cancel)
    }
}
