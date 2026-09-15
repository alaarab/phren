import PhrenKit
import SwiftUI

struct TerminalUploadRequest: Identifiable {
    let id = UUID()
    let attachments: [AgentAttachment]
}

/// Focus chooses a pane to inspect; its verified conversation receives a draft.
/// Files are uploaded only when the user sends that draft in chat.
struct TerminalUploadFlow: View {
    let host: LiveHost
    let attachments: [AgentAttachment]
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var snapshot: LiveWorkspaces?
    @State private var selectedSession: LiveAgentSession?
    @State private var panes: [AgentChatPanes.Pane] = []
    @State private var destination: Destination?
    @State private var loading = true
    @State private var error: String?
    @State private var retry = UUID()
    private struct Destination { let session: LiveAgentSession; let pane: AgentChatPanes.Pane }
    private var hostMatches: Bool {
        (try? LiveSessionPreferences.read(hostData))?.hosts.first { $0.id == host.id } == host
    }

    var body: some View {
        Group {
            if let destination {
                AgentChatSheet(session: destination.session, initialPane: destination.pane, attachments: attachments)
            } else {
                NavigationStack {
                    PhrenList {
                        if let error { Text(error).font(.callout).foregroundStyle(PhrenTheme.warning) }
                        if let selectedSession {
                            Section(selectedSession.workspaceName) {
                                ForEach(panes) { pane in
                                    if (try? pane.target(hostID: host.id, workspaceID: selectedSession.workspaceID,
                                                         tabID: selectedSession.tab.id, muxID: host.muxID)) != nil {
                                        Button(pane.displayTitle) { destination = .init(session: selectedSession, pane: pane) }
                                    }
                                }
                            }
                            Button("Choose another tab") { self.selectedSession = nil; panes = [] }
                        } else if let snapshot {
                            Section(host.name) {
                                ForEach(snapshot.sessions(on: host)) { session in
                                    Button {
                                        selectedSession = session
                                        retry = UUID()
                                    } label: {
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack(spacing: 5) {
                                                if session.folderName != nil { Image(systemName: "folder").foregroundStyle(PhrenTheme.textMuted) }
                                                Text(session.projectDisplayName(nil)).font(.subheadline.weight(.medium))
                                            }
                                            Text(session.tab.displayTitle).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                                        }
                                    }
                                }
                            }
                        }
                        if !loading { Button("Refresh") { retry = UUID() } }
                    }
                    .overlay { if loading { ProgressView().accessibilityLabel("Finding the current agent") } }
                    .navigationTitle("Attach to agent")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                }
            }
        }
        .task(id: retry) {
            guard destination == nil else { return }
            loading = true; error = nil
            defer { loading = false }
            do {
                guard hostMatches else { throw PhrenKitError.validation("This computer's connection changed. Reopen its terminal.") }
                if let selectedSession {
                    try await resolve(selectedSession, focusedPane: nil)
                } else {
                    let fresh = try await LiveHostMonitor.fetch(host)
                    try Task.checkCancellation()
                    guard hostMatches else { throw PhrenKitError.validation("This computer's connection changed. Reopen its terminal.") }
                    snapshot = fresh
                    if let focus = fresh.focus,
                       let session = fresh.sessions(on: host).first(where: { $0.workspaceID == focus.workspaceID && $0.tab.id == focus.tabID }) {
                        try await resolve(session, focusedPane: focus.paneID)
                    }
                }
            } catch is CancellationError { }
            catch { self.error = error.localizedDescription }
        }
    }

    private func resolve(_ session: LiveAgentSession, focusedPane: String?) async throws {
        let list = try await AgentChatModel.fetchPanes(session)
        try Task.checkCancellation()
        guard hostMatches else { throw PhrenKitError.validation("This computer's connection changed. Reopen its terminal.") }
        selectedSession = session
        panes = list.panes
        let supported = panes.filter { (try? $0.target(hostID: host.id, workspaceID: session.workspaceID,
                                                      tabID: session.tab.id, muxID: host.muxID)) != nil }
        if let focusedPane {
            if let pane = supported.first(where: { $0.id == focusedPane }) { destination = .init(session: session, pane: pane) }
            else { error = "Choose an agent for this attachment. The focused pane has no supported conversation." }
        } else if supported.count == 1 {
            destination = .init(session: session, pane: supported[0])
        } else if supported.isEmpty {
            error = "No supported agent conversation was found in this tab. Choose another tab."
        }
    }
}
