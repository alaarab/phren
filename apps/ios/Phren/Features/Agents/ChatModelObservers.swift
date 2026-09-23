import PhrenKit
import SwiftUI

/// The chat screen's model-driven side effects, in an invisible view. Each
/// `onChange` and `task` here reads a model field, and reading it here rather
/// than in `AgentChatView.body` means a change to that field redraws this
/// empty view, not the header, transcript and composer around it.
struct ChatModelObservers: View {
    let model: AgentChatModel
    let session: LiveAgentSession
    let active: Bool
    /// The project for the chosen pane's folder, computed by the screen.
    let currentProject: () -> SessionProject?
    @Binding var project: SessionProject?
    @Binding var composing: Bool
    let acceptIncoming: () -> Void
    let loaded: (Bool) -> Void
    let refreshChildAgents: () async -> Void
    let stop: @MainActor () -> Void

    var body: some View {
        Color.clear
            .accessibilityHidden(true)
            .onChange(of: currentProject(), initial: true) { _, value in
                if project != value { project = value }
            }
            .onChange(of: model.restoringDraft) { _, _ in acceptIncoming() }
            .onChange(of: model.attachments.count) { _, _ in acceptIncoming() }
            .onChange(of: model.approval?.id) { _, id in if id != nil { composing = false } }
            .onChange(of: model.loading) { _, loading in loaded(!loading) }
            .onChange(of: workingActivity, initial: true) { _, value in
                Task {
                    await SessionWorkingActivityController.shared.observe(
                        session: session, project: value.project, projectStoreID: value.projectStoreID,
                        provider: value.provider,
                        branch: value.branch, activity: value.activity, toolName: value.toolName,
                        toolDetail: value.toolDetail
                    )
                }
            }
            .onChange(of: turnStopEnabled, initial: true) { _, enabled in
                model.turnControl.stop = ChatTurnStop(enabled: enabled, action: stop)
            }
            // Re-read the spawned agents when the conversation or its transcript changes.
            .task(id: (model.target?.id ?? "") + ":" + String(model.timelineRevision)) { await refreshChildAgents() }
            .task(id: active && model.reveal.isRevealing) {
                guard active else { return }
                while model.reveal.isRevealing && !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(33)) } catch { return }
                    model.reveal.advance()
                }
            }
    }

    /// The activity line's stop ring works whenever the composer's stop would,
    /// draft or not.
    private var turnStopEnabled: Bool {
        active && model.connected && model.isBusy && model.target?.isStarting != true
            && !model.sending && !model.stopping && !model.answering
    }

    private struct WorkingActivity: Equatable {
        let project: String?
        let projectStoreID: String?
        let provider: String?
        let branch: String?
        let activity: String?
        let toolName: String?
        let toolDetail: String?
    }

    private var workingActivity: WorkingActivity {
        WorkingActivity(project: project?.name, projectStoreID: project?.storeID,
                        provider: model.target?.source ?? session.tab.agent,
                        branch: model.branch ?? session.tab.branch,
                        activity: model.activityPhase == .working ? "working" : model.liveActivity ?? session.tab.agentStatus,
                        toolName: model.currentToolName, toolDetail: model.currentToolDetail)
    }
}

/// Swipe-to-dismiss waits while earlier history is loading or pending; only
/// this modifier observes those two fields.
struct ChatDismissGuard: ViewModifier {
    let model: AgentChatModel
    func body(content: Content) -> some View {
        content.interactiveDismissDisabled(model.timelineState.hasMore || model.loadingHistory)
    }
}

/// Background jobs above the queue: redrawn when the jobs change, alone.
struct ChatBackgroundJobsSlot: View {
    let timeline: AgentChatTimelineState
    var body: some View {
        if !timeline.backgroundJobs.isEmpty {
            ChatBackgroundJobsView(jobs: timeline.backgroundJobs)
        }
    }
}

/// Claude's `/btw` answer card.
struct ChatSideAnswerSlot: View {
    let model: AgentChatModel
    let session: LiveAgentSession
    var body: some View {
        if let side = model.visibleSideAnswer {
            ChatSideAnswerCard(side: side) { model.dismissSideAnswer(session) }
                .padding(.horizontal, 12).padding(.top, 6)
        }
    }
}

/// The notice that the transcript stopped advancing.
struct ChatHistoryStalledSlot: View {
    let model: AgentChatModel
    let projectKnown: Bool
    let startNew: () -> Void
    var body: some View {
        if model.historyStalled {
            ChatHistoryStalledNotice(since: model.historyStalledSince, newThread: startNew)
                .disabled(!projectKnown)
        }
    }
}
