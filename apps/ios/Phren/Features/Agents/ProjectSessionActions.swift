import SwiftUI
import PhrenKit

/// Project memory and the running agent share a single native destination.
struct ProjectSessionActions: View {
    enum Presentation { case menu, section }
    let storeId: String
    let project: String
    var presentation: Presentation = .menu
    private enum RouteKind: Hashable { case chat, terminal }
    private struct Route: Identifiable, Hashable {
        let id = UUID()
        let kind: RouteKind
    }
    @State private var route: Route?
    @State private var launching = false
    var body: some View {
        Group {
            switch presentation {
            case .menu:
                Menu { actions } label: { Label("Project session", systemImage: "terminal") }
                    .accessibilityLabel("Project session")
            case .section: Section("Session") { actions }
            }
        }
        .navigationDestination(item: $route) { route in
            ProjectSessionsView(storeID: storeId, project: project, openChat: route.kind == .chat)
        }
        .sheet(isPresented: $launching) { LaunchSessionView(storeID: storeId, project: project) }
    }
    private var actions: some View {
        Group {
            Button("Open on a computer…", systemImage: "desktopcomputer.and.arrow.down") { launching = true }
                .accessibilityIdentifier("project-open-on-computer")
            Button("Chat with agent", systemImage: "bubble.left.and.bubble.right") { route = .init(kind: .chat) }
            Button("Herdr terminal", systemImage: "terminal") { route = .init(kind: .terminal) }
        }
    }
}

struct SessionLaunchAlert: ViewModifier {
    @Binding var error: String?
    func body(content: Content) -> some View {
        content.alert("Couldn't open session", isPresented: $error.isPresent()) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }
}
