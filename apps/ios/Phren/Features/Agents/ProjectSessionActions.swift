import SwiftUI
import PhrenKit

/// Project memory and the running agent share a single native destination.
struct ProjectSessionActions: View {
    enum Presentation { case menu, section }
    let storeId: String
    let project: String
    var presentation: Presentation = .menu
    @State private var chatting = false
    @State private var terminal = false
    var body: some View {
        Group {
            switch presentation {
            case .menu:
                Menu { actions } label: { Label("Project session", systemImage: "terminal") }
                    .accessibilityLabel("Project session")
            case .section: Section("Session") { actions }
            }
        }
        .sheet(isPresented: $chatting) { ProjectSessionsView(storeID: storeId, project: project, openChat: true) }
        .sheet(isPresented: $terminal) { ProjectSessionsView(storeID: storeId, project: project) }
    }
    private var actions: some View {
        Group {
            Button("Chat with agent", systemImage: "bubble.left.and.bubble.right") { chatting = true }
            Button("Herdr terminal", systemImage: "terminal") { terminal = true }
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
