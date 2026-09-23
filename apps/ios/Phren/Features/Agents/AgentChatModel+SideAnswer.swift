import PhrenKit
import PhrenLive

/// The `/btw` side answer shown for one conversation.
struct ChatSideAnswerState: Equatable {
    let targetID: String
    var answer: AgentSideAnswer
}

extension AgentChatModel {
    /// The card for the open conversation, if its side answer is not dismissed.
    var visibleSideAnswer: AgentSideAnswer? {
        guard let sideAnswer, sideAnswer.targetID == target?.id else { return nil }
        return sideAnswer.answer
    }

    /// The Hook re-sends undismissed answers after a reconnect; the newest
    /// one shows, and one the phone dismissed stays dismissed.
    func receiveSideAnswer(_ side: AgentSideAnswer) {
        guard let target, !dismissedSideAnswers.contains(side.id) else { return }
        sideAnswer = ChatSideAnswerState(targetID: target.id, answer: side)
    }

    /// Dismiss closes the card at once. A pending question is cancelled on the
    /// computer, which closes its terminal panel; a failure there is not
    /// worth an error, since the Hook forgets answers on its own.
    func dismissSideAnswer(_ session: LiveAgentSession) {
        guard let current = sideAnswer, let target, current.targetID == target.id else { sideAnswer = nil; return }
        dismissedSideAnswers.insert(current.answer.id)
        sideAnswer = nil
        let id = current.answer.id
        Task {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { AgentChatFixture.dismissSideAnswer(id); return }
            #endif
            try? await PhrenConnection.dismissSideAnswer(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, id: id)
        }
    }
}
