import PhrenKit
import SwiftUI
import os
import WebKit

struct GraphCommand: Equatable {
    enum Action: Equatable {
        case reset, zoomIn, zoomOut, clear, focus(String), reveal(String)
    }
    let id = UUID()
    let action: Action
}

enum GraphAction: Equatable {
    case select(String)
    case focus(String)
    case openProject(String)
    case share(String)
    case edit(String)
    case delete(String)
    case close
}

/// Local renderer only. Native controls issue a small set of typed commands.
/// One `WKWebView` is created per host view and kept for its lifetime; a new
/// payload or command is sent through JavaScript, never by rebuilding the
/// web view, so selecting a node never reloads the page.
struct GraphWebView: UIViewRepresentable {
    let payload: GraphPayload
    let command: GraphCommand?
    let onSelect: (GraphNodeRef?) -> Void
    let onAction: (GraphAction) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect, onAction: onAction, onError: onError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        for name in Coordinator.handlers {
            config.userContentController.add(context.coordinator, name: name)
        }
        config.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(PhrenTheme.bg)
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        guard let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "graph") else {
            DispatchQueue.main.async { onError("The graph couldn't be loaded. Please try updating the app.") }
            return webView
        }
        context.coordinator.resourceRoot = url.deletingLastPathComponent()
        context.coordinator.startTimeout()
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return webView
    }

    /// The web view must claim exactly the frame SwiftUI gives it: WKWebView's
    /// own content size otherwise wins and the canvas draws short of the frame.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: WKWebView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? uiView.frame.width,
               height: proposal.height ?? uiView.frame.height)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onSelect = onSelect
        context.coordinator.onAction = onAction
        context.coordinator.onError = onError
        context.coordinator.pendingPayload = payload
        context.coordinator.pendingCommand = command
        context.coordinator.renderIfReady()
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.timeout?.cancel()
        webView.evaluateJavaScript("window.phrenGraph?.destroy();", completionHandler: nil)
        webView.stopLoading()
        webView.navigationDelegate = nil
        for name in Coordinator.handlers { webView.configuration.userContentController.removeScriptMessageHandler(forName: name) }
        coordinator.webView = nil
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        static let handlers = ["graphReady", "graphSelect", "graphAction", "graphError"]
        weak var webView: WKWebView?
        var resourceRoot: URL?
        var pendingPayload: GraphPayload?
        var pendingCommand: GraphCommand?
        var onSelect: (GraphNodeRef?) -> Void
        var onAction: (GraphAction) -> Void
        var onError: (String) -> Void
        var timeout: DispatchWorkItem?
        private var isReady = false
        private var isRendering = false
        private var lastRenderedPayload: GraphPayload?
        private var lastCommand: UUID?

        init(onSelect: @escaping (GraphNodeRef?) -> Void,
             onAction: @escaping (GraphAction) -> Void,
             onError: @escaping (String) -> Void) {
            self.onSelect = onSelect
            self.onAction = onAction
            self.onError = onError
        }

        /// Automatic retries of a render call that failed.
        var renderAttempts = 0

        func startTimeout() {
            let task = DispatchWorkItem { [weak self] in
                guard let self, !self.isReady else { return }
                self.onError("The graph took too long to load. Try opening it again.")
            }
            timeout = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: task)
        }

        /// Serialize and parse the payload off the main actor, then send it
        /// through JavaScript on the one web view this host keeps. An
        /// unchanged payload only re-runs the pending command.
        func renderIfReady() {
            guard isReady, !isRendering, let payload = pendingPayload else { return }
            if payload == lastRenderedPayload { runCommand(); return }
            isRendering = true
            Task.detached(priority: .userInitiated) {
                let json = try? payload.jsonString()
                let object = json.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) }
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    guard let webView = self.webView else {
                        self.isRendering = false
                        return
                    }
                    guard let object else {
                        self.isRendering = false
                        self.onError("The graph data couldn't be read.")
                        return
                    }
                    webView.callAsyncJavaScript("window.phrenHost.render(payload); return true;",
                                                arguments: ["payload": object], in: nil, in: .page) { [weak self] result in
                        guard let self else { return }
                        self.isRendering = false
                        switch result {
                        case .success:
                            self.renderAttempts = 0
                            self.lastRenderedPayload = payload
                            self.renderIfReady()
                        case .failure(let error):
                            // The first call can land while the page is still
                            // settling (seen on first open; Try again always
                            // worked): retry twice before showing the error.
                            os_log("graph render failed (attempt %d): %{public}@", self.renderAttempts + 1, error.localizedDescription)
                            if self.renderAttempts < 2 {
                                self.renderAttempts += 1
                                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(300 * self.renderAttempts)) { self.renderIfReady() }
                            } else {
                                self.renderAttempts = 0
                                self.onError("The graph couldn't be drawn. Try opening it again.")
                            }
                        }
                    }
                }
            }
        }

        private func runCommand() {
            guard let command = pendingCommand, command.id != lastCommand, let webView else { return }
            lastCommand = command.id
            let name: String
            var arguments: [String: Any] = [:]
            switch command.action {
            case .reset: name = "reset"
            case .zoomIn: name = "zoom"; arguments["value"] = 1.4
            case .zoomOut: name = "zoom"; arguments["value"] = 1 / 1.4
            case .clear: name = "clear"
            case .focus(let id): name = "focusNode"; arguments["value"] = id
            case .reveal(let id): name = "revealNode"; arguments["value"] = id
            }
            arguments["name"] = name
            if arguments["value"] == nil { arguments["value"] = NSNull() }
            webView.callAsyncJavaScript("window.phrenHost[name](value); return true;",
                                       arguments: arguments, in: nil, in: .page) { [weak self] result in
                if case .failure = result { self?.onError("That graph control couldn't be applied. Try opening the graph again.") }
            }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame else { return }
            switch message.name {
            case "graphReady":
                timeout?.cancel()
                isReady = true
                renderIfReady()
            case "graphSelect":
                if message.body is NSNull { onSelect(nil); return }
                guard JSONSerialization.isValidJSONObject(message.body),
                      let data = try? JSONSerialization.data(withJSONObject: message.body),
                      let node = try? JSONDecoder().decode(GraphNodeRef.self, from: data) else { return }
                onSelect(node)
            case "graphAction":
                guard JSONSerialization.isValidJSONObject(message.body),
                      let data = try? JSONSerialization.data(withJSONObject: message.body),
                      let action = try? JSONDecoder().decode(GraphActionMessage.self, from: data) else { return }
                switch action.action {
                case "select": onAction(.select(action.id))
                case "focus": onAction(.focus(action.id))
                case "openProject": onAction(.openProject(action.id))
                case "share": onAction(.share(action.id))
                case "edit": onAction(.edit(action.id))
                case "delete": onAction(.delete(action.id))
                case "close": onAction(.close)
                default: break
                }
            case "graphError":
                onError("The graph renderer couldn't load. Try opening it again.")
            default: break
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            timeout?.cancel()
            onError("The graph couldn't be loaded. Try opening it again.")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            self.webView(webView, didFail: navigation, withError: error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onError("The graph was closed to free memory. Tap Try again to reopen it.")
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, url.isFileURL, let resourceRoot,
                  url.standardizedFileURL.path.hasPrefix(resourceRoot.standardizedFileURL.path + "/") else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}

private struct GraphActionMessage: Decodable {
    let action: String
    let id: String
}
