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
                        approval = try AgentChatFixture.approval(target)
                        terminalPrompt = AgentChatFixture.terminalPrompt(target)
                        let status = try AgentChatFixture.status(target)
                        passwordPrompt = status.passwordPrompt
                        historyStalled = status.historyStalled; historyStalledSince = status.historyStalledSince
                        if statusBranch != status.branch { statusBranch = status.branch }
                        if !ProcessInfo.processInfo.arguments.contains("--chat-streaming") {
                            acceptActivity(try AgentChatFixture.panes(session).validate(target).agentStatus)
                        }
                        interactionConnected = true
                        await ApprovalActivityController.shared.sync(approval, session: session, target: target)
                        try await Task.sleep(for: .milliseconds(250))
                        continue
                    }
                    #endif
                    for try await status in PhrenConnection.interactionUpdates(host: session.host, privateKey: try DeviceSSHKey.load(session.host.id), target: target) {
                        try Task.checkCancellation()
                        guard self.target == target, connection.generation == run, connection.statusGeneration == statusRun else { return }
                        if awaitingReply, liveActivity != "working", status.activity == "working" { awaitingReply = false }
                        approval = status.approval.flatMap { ApprovalActivityController.shared.wasHandled($0, target: target) ? nil : $0 }
                        if terminalPrompt != status.terminalPrompt { terminalPrompt = status.terminalPrompt }
                        passwordPrompt = status.passwordPrompt
                        if let prompts = status.pendingQuestions { questionState.replaceAsync(prompts) }
                        capabilities = status.capabilities
                        questionsSupported = status.questionsSupported; asyncQuestionsSupported = status.asyncQuestionsSupported
                        acceptActivity(status.activity); interactionConnected = true
                        isCompacting = status.compacting
                        historyStalled = status.historyStalled; historyStalledSince = status.historyStalledSince
                        acceptReportedModel(status.modelName)
                        if statusBranch != status.branch { statusBranch = status.branch }
                        if approval != nil || ["waiting", "blocked"].contains(status.activity ?? "") { awaitingReply = false }
                        statusError = nil
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
                passwordPrompt = false
                historyStalled = false; historyStalledSince = nil
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }
}
