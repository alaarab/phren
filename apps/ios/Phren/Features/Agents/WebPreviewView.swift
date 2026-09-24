import PhrenKit
import PhrenLive
import Network
import SwiftUI
import WebKit

struct WebPreviewView: View {
    let selection: WebServerSelection
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var browser = WebPreviewModel()
    @State private var retry = UUID()
    @State private var editing = false
    private var host: LiveHost? { preferencesStore.preferences?.hosts.first { $0.id == selection.hostID } }
    private struct ConnectionID: Equatable { let host: LiveHost?; let active: Bool; let retry: UUID }

    var body: some View {
        ZStack {
            PhrenTheme.bg.ignoresSafeArea()
            if let webView = browser.webView { PreviewWebView(webView: webView) }
            if let message = browser.message {
                VStack(spacing: 14) {
                    Image(systemName: "network").font(.largeTitle).foregroundStyle(PhrenTheme.textMuted)
                    Text(message).font(.subheadline).multilineTextAlignment(.center)
                    Button("Reconnect") { retry = UUID() }.buttonStyle(.bordered)
                    if host != nil { Button("Connection settings", systemImage: "gearshape") { editing = true } }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).background(PhrenTheme.bg)
            } else if browser.webView == nil {
                ProgressView("Opening app…")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    Text(selection.server.displayName).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("\(host?.name ?? "Computer removed") · \(String(selection.server.port))")
                        .font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Reload page", systemImage: "arrow.clockwise") {
                    if browser.message != nil { retry = UUID() } else { browser.webView?.reload() }
                }
            }
            ToolbarItemGroup(placement: .bottomBar) {
                Button("Previous page", systemImage: "chevron.left") { browser.webView?.goBack() }.disabled(!browser.canGoBack)
                Button("Next page", systemImage: "chevron.right") { browser.webView?.goForward() }.disabled(!browser.canGoForward)
                Spacer()
                if browser.loading { ProgressView().controlSize(.small) }
            }
        }
        .task(id: ConnectionID(host: host, active: phase != .background, retry: retry)) {
            guard phase != .background else { browser.pause(); return }
            guard let host else { browser.message = "This computer was removed."; browser.stop(); return }
            await browser.connect(host: host, server: selection.server, path: selection.path)
        }
        .onDisappear { browser.stop() }
        .sheet(isPresented: $editing) {
            if let host { NavigationStack { LiveHostEditor(existing: host) } }
        }
    }
}

@Observable @MainActor
private final class WebPreviewModel: NSObject, WKNavigationDelegate, WKUIDelegate {
    var webView: WKWebView?
    var message: String?
    var loading = false
    var canGoBack = false
    var canGoForward = false
    private var tunnel: WebPreviewTunnel?
    private var generation = UUID()
    private var baseURL: URL?

    func connect(host: LiveHost, server: WebServer, path: String? = nil) async {
        pause()
        let run = UUID(); generation = run
        message = nil; loading = true
        do {
            let url: URL
            #if DEBUG && targetEnvironment(simulator)
            if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--web-servers-fixture") {
                url = URL(string: "http://127.0.0.1:\(server.port)/")!
            } else {
                url = try await open(host: host, server: server)
            }
            #else
            url = try await open(host: host, server: server)
            #endif
            try Task.checkCancellation()
            guard generation == run else { return }
            let previousBase = baseURL
            baseURL = url
            if let view = webView, let previous = view.url {
                if let tunnel { view.configuration.websiteDataStore.proxyConfigurations = [tunnel.proxyConfiguration] }
                if previousBase == url { view.reload() }
                else {
                    var resume = URLComponents(url: previous, resolvingAgainstBaseURL: false)!
                    if resume.host == previousBase?.host, resume.port == previousBase?.port { resume.port = url.port }
                    view.load(URLRequest(url: resume.url ?? url))
                }
            } else {
                let config = WKWebViewConfiguration()
                // Keep cookies and storage isolated to this preview, but retain
                // them and the current page across background/reconnect cycles.
                config.websiteDataStore = .nonPersistent()
                if let tunnel { config.websiteDataStore.proxyConfigurations = [tunnel.proxyConfiguration] }
                let view = WKWebView(frame: .zero, configuration: config)
                view.navigationDelegate = self; view.uiDelegate = self
                view.allowsBackForwardNavigationGestures = true
                view.accessibilityIdentifier = "web-app-preview"
                webView = view
                // A tapped link opens at its own page, on the tunnel's origin.
                let first = path.flatMap { URL(string: $0, relativeTo: url)?.absoluteURL } ?? url
                view.load(URLRequest(url: first))
            }
            if let tunnel {
                await withTaskCancellationHandler { await tunnel.waitUntilClosed() } onCancel: { tunnel.close() }
                guard !Task.isCancelled, generation == run else { return }
                message = "The connection closed. Reconnect to keep browsing."
            }
        } catch {
            guard !Task.isCancelled, generation == run else { return }
            message = error.localizedDescription; loading = false
        }
    }

    private func open(host: LiveHost, server: WebServer) async throws -> URL {
        let key = try DeviceSSHKey.load(host.id)
        let current = try await PhrenConnection.webServers(host: host, privateKey: key)
        guard let live = current.first(where: { $0.id == server.id }) else {
            throw PhrenKitError.validation("This web server is no longer running. Refresh the list to find its new port.")
        }
        let connection = try await WebPreviewTunnel.open(host: host, privateKey: key, server: live)
        try Task.checkCancellation()
        tunnel = connection
        return connection.url
    }

    func pause() {
        generation = UUID()
        tunnel?.close(); tunnel = nil
        webView?.stopLoading()
    }

    func stop() {
        pause()
        webView = nil; baseURL = nil
        canGoBack = false; canGoForward = false
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true; message = nil }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false; canGoBack = webView.canGoBack; canGoForward = webView.canGoForward
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        message = error.localizedDescription; loading = false
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { message = "The page closed. Reconnect to load it again." }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" { decisionHandler(.allow); return }
        if isPreviewOrigin(url) { decisionHandler(.allow); return }
        // External documents do not share the privileged preview. CDN resources
        // still load normally; the proxy only matches loopback destinations.
        if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }
    private func isPreviewOrigin(_ url: URL) -> Bool {
        guard let baseURL else { return false }
        return url.scheme == baseURL.scheme && url.port == baseURL.port && ["phren-preview.localhost", "127.0.0.1", "localhost", "[::1]"].contains(url.host ?? "")
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            if isPreviewOrigin(url) { webView.load(navigationAction.request) }
            else if ["http", "https"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        }
        return nil
    }
}

private struct PreviewWebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    static func dismantleUIView(_ uiView: WKWebView, coordinator: ()) { uiView.stopLoading() }
}
