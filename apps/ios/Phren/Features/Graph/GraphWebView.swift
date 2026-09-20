import SwiftUI
import WebKit

struct GraphCommand: Equatable {
    enum Action: Equatable {
        case reset, zoomIn, zoomOut, clear, focus(String), reveal(String)
    }
    let id = UUID()
    let action: Action
}

enum GraphAction: Equatable {
    case focus(String)
    case openProject(String)
    case share(String)
    case close
}

/// Local renderer only. Native controls issue a small set of typed commands.
struct GraphWebView: UIViewRepresentable {
    let payloadJSON: String
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

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onSelect = onSelect
        context.coordinator.onAction = onAction
        context.coordinator.onError = onError
        context.coordinator.pendingPayload = payloadJSON
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
        var pendingPayload: String?
        var pendingCommand: GraphCommand?
        var onSelect: (GraphNodeRef?) -> Void
        var onAction: (GraphAction) -> Void
        var onError: (String) -> Void
        var timeout: DispatchWorkItem?
        private var isReady = false
        private var isRendering = false
        private var lastRendered: String?
        private var lastCommand: UUID?

        init(onSelect: @escaping (GraphNodeRef?) -> Void,
             onAction: @escaping (GraphAction) -> Void,
             onError: @escaping (String) -> Void) {
            self.onSelect = onSelect
            self.onAction = onAction
            self.onError = onError
        }

        func startTimeout() {
            let task = DispatchWorkItem { [weak self] in
                guard let self, !self.isReady else { return }
                self.onError("The graph took too long to load. Try opening it again.")
            }
            timeout = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: task)
        }

        func renderIfReady() {
            guard isReady, !isRendering, let webView, let json = pendingPayload else { return }
            guard json != lastRendered else { runCommand(); return }
            guard let payload = try? JSONSerialization.jsonObject(with: Data(json.utf8)) else {
                onError("The graph data couldn't be read.")
                return
            }
            isRendering = true
            webView.callAsyncJavaScript("window.phrenHost.render(payload); return true;",
                                       arguments: ["payload": payload], in: nil, in: .page) { [weak self] result in
                guard let self else { return }
                self.isRendering = false
                switch result {
                case .success:
                    self.lastRendered = json
                    self.renderIfReady()
                case .failure:
                    self.onError("The graph couldn't be drawn. Try opening it again.")
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
                case "focus": onAction(.focus(action.id))
                case "openProject": onAction(.openProject(action.id))
                case "share": onAction(.share(action.id))
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
