import PhrenKit

/// Whether the agent has answered what talk mode sent, and with what.
enum TalkReply {
    /// The final reply to the first user message after `line`, once the
    /// agent's turn for it has ended; nil while it is still working (or the
    /// message hasn't reached the transcript yet). Tool cards and Claude's
    /// narration between tool calls are not the reply.
    static func finished(messages: [AgentChatMessage], turns: [AgentChatProgress.Turn],
                         activity: AgentChatProgress.Phase?, awaitingReply: Bool, after line: Int) -> String? {
        guard !awaitingReply, activity != .working,
              let asked = messages.first(where: { $0.role == .user && $0.line > line })?.line else { return nil }
        // A turn that covers the message and is still running.
        if turns.contains(where: { $0.phase == .working && ($0.endLine ?? .max) >= asked }) { return nil }
        return messages.last { $0.role == .assistant && !$0.isNarration && $0.line > asked }?.text
    }
}
