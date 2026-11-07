import MeshSitesCore
import SwiftUI
import UniformTypeIdentifiers
import WebKit

extension UTType {
    /// IPLD CAR files (`.car`). Falls back to generic data when the type isn't registered.
    static var ipldCar: UTType { UTType(filenameExtension: "car", conformingTo: .data) ?? .data }
}

/// Entry point shown from bitchat's app info screen.
public struct MeshSitesView: View {
    @ObservedObject var store: SiteStore
    @ObservedObject var mesh: MeshSitesService
    @State private var importing = false
    @State private var message: String?
    @State private var openSite: StoredSite?
    @State private var showProbe = false
    @State private var showMesh = false

    public init(store: SiteStore = .shared, mesh: MeshSitesService = .shared) {
        self.store = store
        self.mesh = mesh
    }

    public var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Websites stored on this device. They open with no internet, and every block was checked against its content hash.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("Stored sites") {
                    if store.sites.isEmpty {
                        Text("No sites yet. Import a .car file (Files or AirDrop).").foregroundStyle(.secondary)
                    }
                    ForEach(store.sites) { site in
                        Button { openSite = site } label: { SiteRow(site: site) }
                            .buttonStyle(.plain)
                    }
                    .onDelete { idx in idx.map { store.sites[$0].root }.forEach(store.delete) }
                    Button { importing = true } label: { Label("Import a .car file", systemImage: "square.and.arrow.down") }
                    if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
                Section {
                    Toggle("Share my sites with nearby devices", isOn: $mesh.seeding)
                    Button { showMesh = true } label: {
                        Label("Nearby sites (\(mesh.nearby.filter { !$0.stored }.count))", systemImage: "dot.radiowaves.left.and.right")
                    }
                } header: {
                    Text("Mesh")
                } footer: {
                    Text(mesh.attached
                         ? "Sharing announces your stored sites over Bluetooth and answers requests for them. Off by default."
                         : "The mesh is not connected yet.")
                }
                Section {
                    Button { showProbe = true } label: { Label("Run the no-network test", systemImage: "network.slash") }
                } footer: {
                    Text("Cache: \(store.usedBytes / 1024) KiB of \(store.maxCacheBytes / 1024 / 1024) MiB")
                }
            }
            .navigationTitle("MeshSites")
            .fileImporter(isPresented: $importing, allowedContentTypes: [.ipldCar, .data]) { result in
                switch result {
                case .success(let url):
                    do {
                        let site = try store.importCar(at: url)
                        message = "Verified and stored \(site.blockCount) blocks."
                    } catch {
                        message = error.localizedDescription
                    }
                case .failure(let error):
                    message = error.localizedDescription
                }
            }
            .sheet(item: $openSite) { site in SiteBrowserView(site: site, store: store) }
            .sheet(isPresented: $showProbe) { ProbeView(store: store) }
            .sheet(isPresented: $showMesh) { MeshActivityView(mesh: mesh) }
        }
    }
}

struct SiteRow: View {
    let site: StoredSite
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(site.name ?? site.label).font(.body.weight(.semibold))
                NameBadge(status: site.nameStatus, compact: true)
            }
            Text(site.root).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            Text("\(site.blockCount) blocks · \(site.sizeBytes / 1024) KiB").font(.caption).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }
}

struct NameBadge: View {
    let status: String?
    var compact = false
    var body: some View {
        let (text, color): (String, Color) = switch status {
        case "verified": ("Verified name", .green)
        case "unverified": ("Unverified name", .orange)
        default: ("Opened by CID", .secondary)
        }
        Text(compact && status == nil ? "CID" : text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

/// Renders one stored site in the locked-down web view.
struct SiteBrowserView: View {
    let site: StoredSite
    @ObservedObject var store: SiteStore
    @Environment(\.dismiss) private var dismiss
    @State private var blocked: [URL] = []

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    NameBadge(status: site.nameStatus)
                    if site.nameStatus == "unverified" {
                        Text("Nobody you trust has vouched for this name's signer. The content still matches its CID.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Text(site.root).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    if let last = blocked.last {
                        Text("Blocked a link to \(last.absoluteString) (offline sites can't leave themselves)")
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.vertical, 8)
                Divider()
                SiteWebView(root: site.root, store: store) { blocked.append($0) }
            }
            .navigationTitle(site.name ?? site.label)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 600)
        #endif
    }
}

/// The explicit no-network test, run in the real web view configuration.
struct ProbeView: View {
    @ObservedObject var store: SiteStore
    @Environment(\.dismiss) private var dismiss
    @State private var results: [ProbeResult] = []
    @State private var error: String?
    @State private var running = true
    @State private var probe = NetworkProbe()

    var body: some View {
        NavigationStack {
            List {
                if running { HStack { ProgressView(); Text("Running the probe site…") } }
                if let error { Text(error).foregroundStyle(.red) }
                if !results.isEmpty {
                    let failed = results.filter { !$0.passed }.count
                    Text(failed == 0 ? "All \(results.count) network checks behave as expected" : "\(failed) check(s) failed")
                        .font(.headline).foregroundStyle(failed == 0 ? .green : .red)
                }
                ForEach(results) { r in
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: r.passed ? "checkmark.circle.fill" : "xmark.octagon.fill").foregroundStyle(r.passed ? .green : .red)
                        VStack(alignment: .leading) {
                            Text(r.what)
                            Text("expect \(r.expect), got \(r.got)\(r.detail.map { " · \($0)" } ?? "")").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("No-network test")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                do { results = try await probe.run(store: store) } catch { self.error = error.localizedDescription }
                running = false
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
        #endif
    }
}

#if os(iOS)
typealias PlatformViewRepresentable = UIViewRepresentable
#else
typealias PlatformViewRepresentable = NSViewRepresentable
#endif

/// SwiftUI wrapper around the locked-down WKWebView.
struct SiteWebView: View {
    let root: String
    @ObservedObject var store: SiteStore
    var onBlocked: (URL) -> Void
    @State private var config: WKWebViewConfiguration?
    @State private var error: String?

    var body: some View {
        Group {
            if let config {
                WebViewHost(root: root, config: config, onBlocked: onBlocked)
            } else if let error {
                Text(error).foregroundStyle(.red).padding()
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            do { config = try await SiteWebConfiguration.make(store: store) } catch { self.error = error.localizedDescription }
        }
    }
}

struct WebViewHost: PlatformViewRepresentable {
    let root: String
    let config: WKWebViewConfiguration
    let onBlocked: (URL) -> Void

    func makeCoordinator() -> SiteNavigationPolicy {
        let p = SiteNavigationPolicy(root: root)
        p.onBlocked = onBlocked
        return p
    }

    func makeWebView(_ context: Context) -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = context.coordinator
        wv.load(URLRequest(url: URL(string: "\(MeshSiteSchemeHandler.scheme)://\(root)/")!))
        return wv
    }

    #if os(iOS)
    func makeUIView(context: Context) -> WKWebView { makeWebView(context) }
    func updateUIView(_ view: WKWebView, context: Context) {}
    #else
    func makeNSView(context: Context) -> WKWebView { makeWebView(context) }
    func updateNSView(_ view: WKWebView, context: Context) {}
    #endif
}

/// M3 test screen: sites heard over the mesh, who holds them, and recent gossip.
struct MeshActivityView: View {
    @ObservedObject var mesh: MeshSitesService
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if mesh.nearby.isEmpty {
                        Text("Nothing heard yet. Sites appear here when a nearby device with sharing on announces them (about once a minute).")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(mesh.nearby) { site in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(site.root).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                                if site.stored { Text("stored").font(.caption2).foregroundStyle(.secondary) }
                            }
                            Text("\(site.peers) device(s), nearest \(site.nearestHops) hop(s)").font(.caption).foregroundStyle(.secondary)
                            if let d = mesh.downloads[site.root] { DownloadLine(d: d) }
                            HStack {
                                Button(mesh.probing.contains(site.root) ? "Asking…" : "Who has it?") { mesh.probe(root: site.root) }
                                    .buttonStyle(.bordered)
                                    .disabled(mesh.probing.contains(site.root))
                                if !site.stored {
                                    let d = mesh.downloads[site.root]
                                    Button("Download") { mesh.download(root: site.root) }
                                        .buttonStyle(.borderedProminent)
                                        .disabled(d?.phase == .asking || d?.phase == .downloading)
                                }
                                if let holders = mesh.holders[site.root], !mesh.probing.contains(site.root) {
                                    Text(holders.isEmpty ? "no answer" : holders.map { "\(MeshSitesService.short($0.peer)) (\($0.hops) hop)" }.joined(separator: ", "))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Nearby sites")
                }
                Section {
                    ForEach(Array(mesh.log.reversed().enumerated()), id: \.offset) { _, line in
                        Text(line).font(.caption2.monospaced())
                    }
                } header: {
                    Text("Activity")
                } footer: {
                    Text("Rejected packets: \(mesh.spamStrikes)")
                }
            }
            .navigationTitle("Mesh")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct DownloadLine: View {
    let d: MeshSitesService.Download

    var body: some View {
        let kb = d.bytes / 1024
        let secs = d.seconds.map { String(format: "%.1f s", $0) } ?? ""
        let rate = (d.seconds ?? 0) > 0 ? String(format: ", %.1f KB/s", Double(d.bytes) / 1024 / d.seconds!) : ""
        let from = d.peer.map { " from \(MeshSitesService.short($0)) over \(d.via == "bulk" ? "Wi-Fi" : "Bluetooth")" } ?? ""
        Group {
            switch d.phase {
            case .asking: Text("Looking for holders…")
            case .downloading: Text("\(d.blocks)/\(max(d.expectedBlocks, d.blocks)) blocks, \(kb) KB\(from)")
            case .done: Text("Downloaded \(d.blocks) blocks, \(kb) KB in \(secs)\(rate)\(from). Stored.")
            case .failed: Text("Failed: \(d.error ?? "unknown")").foregroundStyle(.red)
            }
        }
        .font(.caption)
    }
}
