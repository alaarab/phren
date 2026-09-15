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
        switch presentation {
        case .menu:
            Menu { actions } label: { Label("Project session", systemImage: "terminal") }
                .accessibilityLabel("Project session")
                .modifier(Destinations(storeId: storeId, project: project, route: $route, launching: $launching))
        case .section:
            // The presentation modifiers ride on the rows, not the Section: a
            // Section with modifiers of its own stops being a section to the
            // list and draws its buttons as one stacked cell.
            Section("Session") {
                openButton
                chatButton
                terminalButton.modifier(Destinations(storeId: storeId, project: project, route: $route, launching: $launching))
            }
        }
    }
    private var actions: some View {
        Group { openButton; chatButton; terminalButton }
    }
    private var openButton: some View {
        Button("Open on a computer…", systemImage: "desktopcomputer.and.arrow.down") { launching = true }
            .accessibilityIdentifier("project-open-on-computer")
    }
    private var chatButton: some View {
        Button("Chat with agent", systemImage: "bubble.left.and.bubble.right") { route = .init(kind: .chat) }
    }
    private var terminalButton: some View {
        Button("Herdr terminal", systemImage: "terminal") { route = .init(kind: .terminal) }
    }
    private struct Destinations: ViewModifier {
        let storeId: String
        let project: String
        @Binding var route: Route?
        @Binding var launching: Bool
        func body(content: Content) -> some View {
            content
                .navigationDestination(item: $route) { route in
                    ProjectSessionsView(storeID: storeId, project: project, openChat: route.kind == .chat)
                }
                .sheet(isPresented: $launching) { LaunchSessionView(storeID: storeId, project: project) }
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
