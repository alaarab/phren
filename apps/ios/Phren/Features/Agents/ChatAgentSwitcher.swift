import PhrenKit
import SwiftUI

/// Reuses live discovery and exact host/tab identities; selecting a row never
/// launches a new agent or submits anything to a running conversation.
struct ChatAgentSwitcher: View {
    let session: LiveAgentSession?
    let panes: [AgentChatPanes.Pane]
    let selectedPaneID: String?
    let children: [AgentChild]
    let openChild: (AgentChild) -> Void
    let openSessionChild: (LiveAgentSession, AgentChatTarget, AgentChild) -> Void
    let choosePane: (AgentChatPanes.Pane) -> Void
    let chooseSession: (LiveAgentSession) -> Void
    let close: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveSessionPreferences) private var livePreferences
    private var overview: SessionOverviewMonitor { .shared }
    @State private var query = ""
    @AppStorage("agents.drawer.recent.v1") private var recent = false
    private var preferences: LiveSessionPreferences? { livePreferences.preferences }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }
    private struct PollID: Equatable { let hosts: [LiveHost]; let active: Bool }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
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
                Text("WORKSPACES").font(.caption2.weight(.semibold)).tracking(1)
                    .foregroundStyle(PhrenTheme.textMuted).padding(.horizontal, 12).padding(.top, 12)
                if !overview.ready { HStack { ProgressView(); Text("Finding your agents…").font(.subheadline) }.padding(12) }
                if overview.ready {
                    AgentWorkspaceTree(computers: overview.computers, query: query, current: session?.id,
                                       recent: recent, children: children, choose: chooseSession,
                                       openChild: openChild, openSessionChild: openSessionChild)
                }
                let hasSessions = overview.computers.contains { computer in
                    computer.monitor.snapshot?.sessions(on: computer.host).contains {
                        ($0.tab.agent != nil || ($0.tab.agentPaneCount ?? 0) > 0) && $0.matches(query)
                    } == true
                }
                if overview.ready && !hasSessions && (eligiblePanes.count < 2 || local.isEmpty) {
                    Text("No matching agents").foregroundStyle(PhrenTheme.textMuted)
                }
            }
        }
        .safeAreaInset(edge: .top) {
            VStack(spacing: 8) {
                HStack {
                    PhrenSearchField(text: $query, placeholder: "Search workspaces, tabs…",
                                     identifier: "agent-drawer-search")
                    Button("Close", systemImage: "xmark") { close() }
                        .labelStyle(.iconOnly).frame(width: 44, height: 44)
                        .accessibilityIdentifier("agent-drawer-close")
                }
                PhrenTextSegment(items: [
                    .init(id: "recent", value: true, title: "Recent"),
                    .init(id: "list", value: false, title: "List"),
                ], selection: $recent, identifier: "agent-drawer-order")
                .phrenContainerMarker("agent-drawer-order", label: "Workspace order",
                                      value: recent ? "Recent" : "List")
            }.padding(12).background(PhrenTheme.chatCanvas)
        }
        .task(id: PollID(hosts: hosts, active: scenePhase == .active)) {
            // The Agents list normally has this running already; if the chat
            // was reached without it (Spotlight, Siri), start it here.
            if scenePhase == .active { overview.ensureRunning(hosts: hosts) }
        }
    }
}
