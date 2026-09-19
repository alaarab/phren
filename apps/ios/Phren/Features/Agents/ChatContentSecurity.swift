import PhrenKit
import SwiftUI

enum ChatClipboard {
    static func copy(_ text: String) {
        UIPasteboard.general.setItems([["public.utf8-plain-text": text]], options: [.localOnly: true])
        #if DEBUG && targetEnvironment(simulator)
        // Tests cannot read the pasteboard (the runner hangs on the paste
        // prompt); the fixture keeps what was copied instead.
        if AppRuntime.isUITesting { MainActor.assumeIsolated { AgentChatFixture.report.copied.append(text) } }
        #endif
    }
}

extension View {
    func confirmsWebLinks() -> some View { modifier(ChatWebLinks()) }
    func confirmWebLink(_ url: Binding<URL?>, open: @escaping (URL) -> Void) -> some View {
        modifier(WebLinkConfirmation(url: url, open: open))
    }
}

private struct ChatWebLinks: ViewModifier {
    @State private var pending: URL?
    @Environment(\.openURL) private var testCapture
    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            if ExternalLinkPolicy.host(for: url) != nil { pending = url }
            return .discarded
        })
        .confirmWebLink($pending) { url in
            #if DEBUG
            if AppRuntime.isUITesting {
                if ProcessInfo.processInfo.arguments.contains("--capture-chat-links"), url.host == "example.org" { testCapture(url) }
                return
            }
            #endif
            UIApplication.shared.open(url)
        }
    }
}

private struct WebLinkConfirmation: ViewModifier {
    @Binding var url: URL?
    let open: (URL) -> Void
    func body(content: Content) -> some View {
        content.alert("Open website?", isPresented: Binding(get: { url != nil }, set: { if !$0 { url = nil } }), presenting: url) { destination in
            Button("Open website") {
                guard ExternalLinkPolicy.host(for: destination) != nil else { return }
                open(destination); url = nil
            }.accessibilityIdentifier("external-link-open")
            Button("Cancel", role: .cancel) { url = nil }
        } message: { destination in
            Text(ExternalLinkPolicy.host(for: destination) ?? "")
        }
    }
}
