import PhrenKit
import PhrenLive
import SwiftUI

/// The live links behind one chat: the transcript stream, the approval and
/// status channel, and what that channel last reported. Owned by
/// `AgentChatModel`; views read these through the model's properties.
@Observable @MainActor
final class AgentChatConnection {
    var interactionConnected = false
    /// Why the approval and status channel dropped, until it reconnects.
    var statusError: String?
    var capabilities: LiveCapabilities?
    var questionsSupported = true
    var asyncQuestionsSupported = false
    var historyStalled = false
    var historyStalledSince: Date?
    var receivedAt: Date?
    /// Counts reconnect backlogs; the view pins to the end on each when following.
    var reconnectRevision = 0
    /// A transcript too large to decode is not reopened automatically.
    var rejectedStreamTarget: AgentChatTarget?

    @ObservationIgnored var lastSession: LiveAgentSession?
    /// One per `run`; a stale run's streams must not touch a newer one.
    @ObservationIgnored var generation = UUID()
    @ObservationIgnored var statusGeneration = UUID()
    @ObservationIgnored var streamTask: Task<Void, Never>?
    @ObservationIgnored var streamTarget: AgentChatTarget?
    @ObservationIgnored var statusTask: Task<Void, Never>?
    @ObservationIgnored var progressTask: Task<Void, Never>?
    @ObservationIgnored var progressConnected = false
    @ObservationIgnored private var panesSleeper: Task<Void, Never>?

    /// The pane poll's wait; `wakePanes()` ends it early.
    func pausePanes(_ duration: Duration) async {
        let sleeper = Task { _ = try? await Task.sleep(for: duration) }
        panesSleeper = sleeper
        await withTaskCancellationHandler { await sleeper.value } onCancel: { sleeper.cancel() }
        if panesSleeper == sleeper { panesSleeper = nil }
    }

    /// Read the pane list now: a stream dropped, or the chat needs it.
    func wakePanes() { panesSleeper?.cancel() }

    func shouldBeginStream(_ target: AgentChatTarget) -> Bool {
        !target.isStarting && streamTarget != target && rejectedStreamTarget != target
    }

    /// Ends the progress, transcript and status links.
    func cancelLinks() {
        progressTask?.cancel(); progressTask = nil
        streamTask?.cancel(); streamTask = nil; streamTarget = nil
        statusTask?.cancel(); statusTask = nil; interactionConnected = false
    }
}

extension AgentChatModel {
    func beginProgress(_ session: LiveAgentSession, target: AgentChatTarget, run: UUID) {
        // Phren Hook includes real lifecycle and usage events in the chat stream.
        connection.progressTask?.cancel(); connection.progressTask = nil
        connection.progressConnected = false; progressUnavailable = false
    }

    func beginStatus(_ session: LiveAgentSession, target: AgentChatTarget, run: UUID) {
        connection.statusTask?.cancel(); interactionConnected = false; approval = nil; isCompacting = false
        historyStalled = false; historyStalledSince = nil; statusError = nil
        let statusRun = UUID(); connection.statusGeneration = statusRun
        connection.statusTask = Task {
            while !Task.isCancelled {
                do {
                    #if DEBUG && targetEnvironment(simulator)
                    if AgentChatFixture.enabled {
                        guard self.target == target, connection.generation == run, connection.statusGeneration == statusRun else { return }
                        asyncQuestionsSupported = !ProcessInfo.processInfo.arguments.contains("--chat-question-unsupported")
                        if ProcessInfo.processInfo.arguments.contains("--chat-question-unsupported") { questionsSupported = false }
                        let fixtureApproval = try AgentChatFixture.approval(target)
                        if approval != fixtureApproval { approval = fixtureApproval }
                        let fixturePrompt = AgentChatFixture.terminalPrompt(target)
                        if terminalPrompt != fixturePrompt { terminalPrompt = fixturePrompt }
                        let status = try AgentChatFixture.status(target)
                        if passwordPrompt != status.passwordPrompt { passwordPrompt = status.passwordPrompt }
                        if historyStalled != status.historyStalled { historyStalled = status.historyStalled }
                        if historyStalledSince != status.historyStalledSince { historyStalledSince = status.historyStalledSince }
                        if statusBranch != status.branch { statusBranch = status.branch }
                        if !ProcessInfo.processInfo.arguments.contains("--chat-streaming") {
                            let pane = try AgentChatFixture.panes(session).validate(target)
                            acceptActivity(pane.agentStatus)
                            let answer = pane.needsAnswer || approval != nil
                            if needsAnswer != answer { needsAnswer = answer; if answer, awaitingReply { awaitingReply = false } }
                        }
                        if !interactionConnected { interactionConnected = true }
                        await ApprovalActivityController.shared.sync(approval, session: session, target: target)
                        try await Task.sleep(for: .milliseconds(250))
                        continue
                    }
                    #endif
                    for try await status in PhrenConnection.interactionUpdates(host: session.host, privateKey: try DeviceSSHKey.load(session.host.id), target: target) {
                        try Task.checkCancellation()
                        guard self.target == target, connection.generation == run, connection.statusGeneration == statusRun else { return }
                        if awaitingReply, liveActivity != "working", status.activity == "working" { awaitingReply = false }
                        // A status tick repeats most fields; assign only what
                        // changed, so an unchanged tick redraws nothing.
                        let reported = status.approval.flatMap { ApprovalActivityController.shared.wasHandled($0, target: target) ? nil : $0 }
                        if approval != reported { approval = reported }
                        if terminalPrompt != status.terminalPrompt { terminalPrompt = status.terminalPrompt }
                        if passwordPrompt != status.passwordPrompt { passwordPrompt = status.passwordPrompt }
                        if let prompts = status.pendingQuestions { questionState.replaceAsync(prompts) }
                        if capabilities != status.capabilities { capabilities = status.capabilities }
                        if questionsSupported != status.questionsSupported { questionsSupported = status.questionsSupported }
                        if asyncQuestionsSupported != status.asyncQuestionsSupported { asyncQuestionsSupported = status.asyncQuestionsSupported }
                        acceptActivity(status.activity)
                        // The status carries the pane's own state, so a prompt
                        // shows without waiting for the pane list.
                        let answer = ["blocked", "waiting"].contains(status.activity ?? "") || approval != nil
                        if needsAnswer != answer { needsAnswer = answer; if answer, awaitingReply { awaitingReply = false } }
                        if !interactionConnected { interactionConnected = true }
                        if isCompacting != status.compacting { isCompacting = status.compacting }
                        if historyStalled != status.historyStalled { historyStalled = status.historyStalled }
                        if historyStalledSince != status.historyStalledSince { historyStalledSince = status.historyStalledSince }
                        acceptReportedModel(status.modelName)
                        if statusBranch != status.branch { statusBranch = status.branch }
                        if awaitingReply, approval != nil || ["waiting", "blocked"].contains(status.activity ?? "") { awaitingReply = false }
                        if statusError != nil { statusError = nil }
                        await ApprovalActivityController.shared.sync(approval, session: session, target: target)
                    }
                } catch is CancellationError {
                } catch {
                    // The loop retries on its own; say why approvals and status went quiet meanwhile.
                    if self.target == target, connection.generation == run, connection.statusGeneration == statusRun {
                        statusError = "Status updates paused: \(error.localizedDescription) Retrying."
                    }
                }
                guard !Task.isCancelled, self.target == target, connection.generation == run, connection.statusGeneration == statusRun else { return }
                approval = nil; terminalPrompt = nil; interactionConnected = false; isCompacting = false
                connection.wakePanes()
                passwordPrompt = false
                historyStalled = false; historyStalledSince = nil
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }
}
