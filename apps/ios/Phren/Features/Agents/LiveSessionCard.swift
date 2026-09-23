import PhrenKit
import PhrenLive
import SwiftUI

struct LiveSessionCard: View, Equatable {
    @Environment(AppModel.self) private var model
    @Environment(\.liveSessionPreferences) private var livePreferences
    let session: LiveAgentSession
    let fresh: Bool
    /// The computer answered before and its answer aged out, so the card says
    /// Stale. A computer still being reached never sets this.
    var stale = false
    var showHost = false
    var resolvedProject: String? = nil
    var resolvedPin: Bool? = nil
    var onChat: (() -> Void)? = nil
    let onDetails: () -> Void
    /// The swipe's red Close acts at once, the way Mail's does: the person
    /// already swiped and hit a red button. Hold, then Close tab or Close
    /// workspace, confirms first, through the one dialog the list owns: a dialog
    /// per row inside a list that re-renders every second presented for the
    /// wrong row, and deleting a row after its swipe action ran under a dialog
    /// tripped UIKit's batch-update check.
    let onClose: (SessionCloseRequest, _ confirm: Bool) -> Void
    @Environment(\.sessionCardMenu) private var openSessionMenu
    private var childTarget: AgentChatTarget? { SessionSubagentStore.shared.entry(session).target }
    private var childAgents: [AgentChild] { SessionSubagentStore.shared.entry(session).agents }
    private struct SubagentFollow: Equatable { let session: LiveAgentSession.ID; let busy: Bool }
    @State private var showingChildAgents = false
    @State private var showingCloseAction = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.session == rhs.session && lhs.fresh == rhs.fresh && lhs.stale == rhs.stale && lhs.showHost == rhs.showHost
            && lhs.resolvedProject == rhs.resolvedProject && lhs.resolvedPin == rhs.resolvedPin
    }

    private func openMenu(project: String?, prefix: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        openSessionMenu?(SessionCardMenuRequest(session: session, project: project, prefix: prefix))
    }

    var body: some View {
        let preferences = livePreferences.preferences
        let match = showHost ? nil : preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd,
                                                projects: model.sessionProjects)
        let project = showHost ? resolvedProject : match?.project.name
        let projectStoreId = showHost ? nil : match?.project.storeID
        let prefix = showHost ? "overview" : "live"
        HStack(spacing: 0) {
            AgentConversationLink(session: session, onOpenInPhren: onChat) {
                SessionCardContent(session: session, fresh: fresh, stale: stale, project: project, projectStoreId: projectStoreId,
                                   computer: showHost ? session.host : nil, identifierPrefix: prefix, onDetails: onDetails)
                    .equatable()
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(showHost ? "overview-chat:\(session.accessibilityKey)"
                                     : "live-chat:\(session.workspaceID):\(session.tab.id)")
            .accessibilityAction(named: "Session actions") { openMenu(project: project, prefix: prefix) }
            .disabled(!fresh)
            // Only agents still working earn a place on the card; finished
            // ones stay reachable from the chat's agent tree.
            let runningAgents = childAgents.reduce(0) { $0 + $1.runningCount }
            if runningAgents > 0 {
                Button { showingChildAgents = true } label: {
                    VStack(spacing: 2) {
                        Image(systemName: "person.2.wave.2")
                        Text("\(runningAgents)").font(.caption2.weight(.bold)).monospacedDigit()
                    }
                    .foregroundStyle(PhrenTheme.phrenCardAccent)
                    .frame(minWidth: 38, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(runningAgents) agents running")
                .accessibilityIdentifier("\(prefix)-running-agents:\(session.accessibilityKey)")
            }
            SessionPinButton(session: session, pinned: resolvedPin ?? (preferences?.isPinned(session.id) == true),
                             identifierPrefix: prefix, data: livePreferences.binding)
            if showHost && showingCloseAction {
                Button(role: .destructive) {
                    showingCloseAction = false
                    onClose(.init(session: session, scope: .tab), false)
                } label: {
                    Label("Close", systemImage: "xmark").labelStyle(.iconOnly)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(PhrenTheme.danger)
                .accessibilityIdentifier("\(prefix)-close:\(session.accessibilityKey)")
            }
        }
        .sessionCard()
        // ScrollView does not host native swipe actions. Preserve the overview's
        // swipe-to-close affordance without claiming vertical scrolling.
        .contentShape(Rectangle())
        .modifier(SessionCardSwipe(isEnabled: showHost) { reveal in
            if showHost { showingCloseAction = reveal }
        })
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Close", systemImage: "xmark", role: .destructive) { onClose(.init(session: session, scope: .tab), false) }
                .accessibilityIdentifier("\(prefix)-close:\(session.accessibilityKey)")
        }
        // Hold opens the list's session actions sheet; VoiceOver reaches the
        // same sheet through the chat button's named action.
        .highPriorityGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in openMenu(project: project, prefix: prefix) })
        .sheet(isPresented: $showingChildAgents) {
            if let childTarget { ChatSubagentsView(session: session, target: childTarget, agents: childAgents) }
        }
        // One shared read per session, with the drawer and the details.
        .task(id: SubagentFollow(session: session.id, busy: session.tab.runningChildren > 0 || session.tab.isConductor)) {
            await SessionSubagentStore.shared.follow(session)
        }
    }
}
