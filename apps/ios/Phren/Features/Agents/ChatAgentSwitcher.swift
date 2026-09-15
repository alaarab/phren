import PhrenKit
import SwiftUI

/// Reuses live discovery and exact host/tab identities; selecting a row never
/// launches a new agent or submits anything to a running conversation.
struct ChatAgentSwitcher: View {
    let session: LiveAgentSession?
    let panes: [AgentChatPanes.Pane]
    let selectedPaneID: String?
    let choosePane: (AgentChatPanes.Pane) -> Void
    let chooseSession: (LiveAgentSession) -> Void
    let close: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(AppModel.self) private var appModel
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var overview = SessionOverviewMonitor()
    @State private var query = ""
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }
    private struct PollID: Equatable { let hosts: [LiveHost]; let active: Bool }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { tick in
            PhrenList {
                let eligiblePanes = panes.filter { pane in
                    guard let session else { return false }
                    return (try? pane.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil
                }
                let local = eligiblePanes.filter { query.isEmpty || "\($0.displayTitle) \($0.agent ?? "")".localizedCaseInsensitiveContains(query) }
                if eligiblePanes.count > 1 && !local.isEmpty {
                    Section("In this tab") {
                        ForEach(local) { pane in
                            Button { choosePane(pane) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(pane.displayTitle)
                                        Text(pane.agent ?? "Agent").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                                    }
                                    Spacer()
                                    if pane.id == selectedPaneID { Image(systemName: "checkmark").foregroundStyle(PhrenTheme.cyan) }
                                }
                            }.accessibilityIdentifier("switch-pane:\(pane.id)")
                        }
                    }
                }
                if !overview.ready { HStack { ProgressView(); Text("Finding your agents…").font(.subheadline) } }
                AgentWorkspaceTree(computers: overview.computers, query: query, current: session?.id, choose: chooseSession)
                let hasSessions = overview.computers.contains { $0.monitor.snapshot?.sessions(on: $0.host).contains { $0.tab.agent != nil || ($0.tab.agentPaneCount ?? 0) > 0 } == true }
                if overview.ready && !hasSessions && (eligiblePanes.count < 2 || local.isEmpty) {
                    Text("No matching agents").foregroundStyle(PhrenTheme.textMuted)
                }
            }
        }
        .safeAreaInset(edge: .top) {
            HStack { Text("Agents").font(.headline); Spacer(); Button("Close", systemImage: "xmark") { close() }.labelStyle(.iconOnly).frame(width: 44, height: 44) }
                .padding(.horizontal, 12).background(PhrenTheme.chatPanel)
        }
        .searchable(text: $query, prompt: "Agent, project, or computer")
        .task(id: PollID(hosts: hosts, active: scenePhase == .active)) {
            if scenePhase == .active { await overview.run(hosts: hosts) }
        }
    }
}
