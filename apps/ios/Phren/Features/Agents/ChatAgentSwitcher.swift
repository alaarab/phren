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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var overview: SessionOverviewMonitor { .shared }
    @State private var query = ""
    @State private var isSearching = false
    @FocusState private var searchFocused: Bool
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
            HStack(spacing: PhrenTheme.Space.small) {
                if isSearching {
                    PhrenSearchField(text: $query, placeholder: "Search workspaces, tabs…",
                                     identifier: "agent-drawer-search", focus: $searchFocused)
                        .transition(.opacity)
                        .onAppear { searchFocused = true }
                    Button("Cancel") {
                        query = ""
                        searchFocused = false
                        isSearching = false
                    }
                    .font(PhrenTypography.body)
                    .foregroundStyle(PhrenTheme.accent)
                    .frame(minHeight: 44).contentShape(Rectangle())
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("agent-drawer-search-cancel")
                } else {
                    iconGroup.transition(.opacity)
                }
                Spacer(minLength: 0)
                Button("Close", systemImage: "xmark") { close() }
                    .labelStyle(.iconOnly).frame(width: 44, height: 44)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityIdentifier("agent-drawer-close")
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .background(PhrenTheme.chatCanvas)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: isSearching)
        }
        .task(id: PollID(hosts: hosts, active: scenePhase == .active)) {
            // The Agents list normally has this running already; if the chat
            // was reached without it (Spotlight, Siri), start it here.
            if scenePhase == .active { overview.ensureRunning(hosts: hosts) }
        }
    }

    private var iconGroup: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            orderButton(icon: "magnifyingglass", label: "Search", identifier: "agent-drawer-search-toggle",
                        selected: false) {
                isSearching = true
                searchFocused = true
            }
            orderButton(icon: "clock", label: "Recent order", identifier: "agent-drawer-order-recent",
                        selected: recent) { recent = true }
            orderButton(icon: "list.bullet", label: "List order", identifier: "agent-drawer-order-list",
                        selected: !recent) { recent = false }
        }
        .phrenContainerMarker("agent-drawer-order", label: "Workspace order",
                              value: recent ? "Recent" : "List")
    }

    private func orderButton(icon: String, label: String, identifier: String, selected: Bool,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(PhrenTypography.icon(18, weight: .semibold))
                .foregroundStyle(selected ? PhrenTheme.accent : PhrenTheme.textMuted)
                .frame(width: 44, height: 44)
                .background(selected ? PhrenTheme.surfaceRaised : .clear,
                            in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}
