import PhrenKit
import PhrenLive
import SwiftUI

/// Answering the agent: held approvals and questions, keys and secrets
/// typed into its terminal, menu walks, and stopping the turn.
extension AgentChatModel {
    /// `updatedInput` answers a Claude AskUserQuestion approval: its own input
    /// plus the chosen answers, sent with the approval. `decision` is the
    /// Hook's effective answer when a conductor call offers grant-scoped
    /// allows; a plain approve/deny is derived from `approve` otherwise.
    func answer(_ session: LiveAgentSession, approval expected: AgentApproval? = nil, approve: Bool = false,
                decision: ApprovalDecision? = nil, updatedInput: [String: Any]? = nil,
                question prompt: AgentQuestionPrompt? = nil, selections: [[Int]] = [], answers: [AgentQuestionAnswer]? = nil) async {
        guard !answering, !sending, let target else { return }
        guard (expected != nil && expected == approval && interactionConnected)
            || (prompt != nil && prompt == question && canAnswerQuestion && connected) else { return }
        let effective = decision ?? (approve ? .approve : .deny)
        answering = true; deliveryError = nil
        defer { answering = false }
        if let expected { await ApprovalActivityController.shared.answered(target: target, actionID: expected.id) }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                AgentChatFixture.answered = true; AgentChatFixture.denied = expected != nil && !effective.allows
                AgentChatFixture.answeredInput = updatedInput
            } else { try await submitAnswer(session, target: target, approval: expected, decision: effective, updatedInput: updatedInput, question: prompt, selections: selections, answers: answers) }
            #else
            try await submitAnswer(session, target: target, approval: expected, decision: effective, updatedInput: updatedInput, question: prompt, selections: selections, answers: answers)
            #endif
            guard self.target == target else { return }
            if approval?.id == expected?.id { approval = nil }
            if let prompt { questionState.resolve(prompt.id) }
            deliveryStatus = prompt?.isAsync == true ? "Answer queued for Codex" : "Answer sent"
        } catch {
            guard self.target == target else { return }
            if approval?.id == expected?.id { approval = nil }
            deliveryError = "Answer wasn't confirmed. Check the conversation or terminal before answering again. Phren hasn't retried it."
        }
    }
    private func submitAnswer(_ session: LiveAgentSession, target: AgentChatTarget, approval: AgentApproval?, decision: ApprovalDecision, updatedInput: [String: Any]?,
                              question: AgentQuestionPrompt?, selections: [[Int]], answers: [AgentQuestionAnswer]?) async throws {
        let key = try DeviceSSHKey.load(session.host.id)
        if let approval { try await PhrenConnection.answerApproval(host: session.host, privateKey: key, target: target, actionID: approval.actionId, approve: decision.allows, decision: decision, updatedInput: updatedInput) }
        else if let question { try await PhrenConnection.answerQuestions(host: session.host, privateKey: key, target: target, prompt: question, answers: answers ?? selections.map { AgentQuestionAnswer(selections: $0) }) }
    }

    /// One key into the agent's terminal for a prompt only it can see. The
    /// row stays until the pane's status leaves "needs answer".
    func answer(_ session: LiveAgentSession, key: AgentAnswerKey) async { await answer(session, keys: [key]) }
    func answer(_ session: LiveAgentSession, keys: [AgentAnswerKey]) async {
        guard let target, !answering, !keys.isEmpty else { return }
        answering = true; deliveryError = nil
        defer { answering = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { for key in keys { try await AgentChatFixture.answer(target, key: key) }; return }
            #endif
            // The Hook takes four keys a call; a long walk goes in pieces.
            var remaining = keys[...]
            while !remaining.isEmpty {
                let chunk = Array(remaining.prefix(4)); remaining = remaining.dropFirst(4)
                try await PhrenConnection.answerWithKeys(host: session.host, privateKey: try DeviceSSHKey.load(session.host.id), target: target, keys: chunk)
            }
            // A key that answers (not a cursor move) clears the card and strip
            // until the next prompt arrives.
            if keys.contains(where: { ![.up, .down, .tab, .altUp].contains($0) }) { terminalPrompt = nil; passwordPrompt = false }
        } catch { deliveryError = error.localizedDescription }
    }

    /// Answers a released AskUserQuestion: one keys call per question, since
    /// the Hook sends the chosen digit then advances its own question index
    /// with Tab (or submits the last with Enter).
    func answerTerminalQuestions(_ session: LiveAgentSession, answers: [AgentQuestionAnswer]) async {
        for answer in answers {
            let keys = answer.selections.sorted().compactMap { AgentAnswerKey(rawValue: String($0 + 1)) }
            guard !keys.isEmpty else { continue }
            await self.answer(session, keys: keys)
        }
    }

    /// Types a secret the agent asked for (a sudo password, a login) into
    /// its terminal and presses Enter. The text is never kept on the phone.
    func answer(_ session: LiveAgentSession, secret: String) async {
        guard let target, !answering, !secret.isEmpty else { return }
        answering = true; deliveryError = nil
        defer { answering = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { try await AgentChatFixture.answer(target, secret: secret); return }
            #endif
            try await PhrenConnection.answerWithSecret(host: session.host, privateKey: try DeviceSSHKey.load(session.host.id), target: target, text: secret)
            terminalPrompt = nil; passwordPrompt = false
        } catch { deliveryError = error.localizedDescription }
    }

    /// Types a slash command whose agent answers with a menu, then walks
    /// that menu to `index`. The command goes through the ordinary send so
    /// the transcript shows it; the keys follow once the menu has drawn.
    /// Codex's Full Access confirmation is the Hook's own step: it reads the
    /// pane and answers "Enable full access?" before closing the walk.
    func drive(_ session: LiveAgentSession, menuCommand command: String, index: Int) async {
        draft = command
        await send(session)
        guard deliveryError == nil else { return }
        try? await Task.sleep(for: .milliseconds(700))
        await answer(session, keys: AgentMenuChoice.keys(selecting: index))
    }

    func stop(_ session: LiveAgentSession) async {
        guard !stopping, !sending, connected, !needsAnswer, let target else { return }
        stopping = true; deliveryError = nil
        defer { stopping = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { AgentChatFixture.stopped = true }
            else { try await PhrenConnection.stopChatTurn(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target) }
            #else
            try await PhrenConnection.stopChatTurn(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target)
            #endif
            deliveryStatus = "Stop requested"
        } catch { deliveryError = "Stop wasn't confirmed. \(error.localizedDescription)" }
        scheduleDrain()
    }
}
