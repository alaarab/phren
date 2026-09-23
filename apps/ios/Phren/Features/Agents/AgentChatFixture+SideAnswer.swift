#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit

/// A `/btw` sent in the fixture chat answers like the Hook does: a pending
/// side-answer frame, then the answer about a second later.
extension AgentChatFixture {
    private static var sideQuestion: (id: String, question: String, askedAt: Date, sentRevision: Int)?
    static let sideAnswerText = "2 + 2 = 4.\n\nClaude keeps working on the current turn; this answer is **not** added to the conversation."

    static func askSide(_ text: String) {
        guard let question = AgentSideAnswer.question(source: "claude", text: text) else { return }
        sideQuestion = (UUID().uuidString.lowercased(), question, .now, 0)
    }

    static func dismissSideAnswer(_ id: String) {
        if sideQuestion?.id == id { sideQuestion = nil }
    }

    /// The next side-answer frame for the stream, once per state change.
    static func sideAnswerFrame(_ target: AgentChatTarget) throws -> AgentChatTranscript? {
        guard let side = sideQuestion else { return nil }
        let answered = Date.now.timeIntervalSince(side.askedAt) > 1.2
        let revision = answered ? 2 : 1
        guard revision > side.sentRevision else { return nil }
        sideQuestion?.sentRevision = revision
        var frame: [String: Any] = ["type": "side-answer", "source": target.source, "session": target.sessionID,
                                    "id": side.id, "question": side.question, "state": answered ? "answer" : "pending"]
        if answered { frame["answer"] = sideAnswerText }
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: target.source, session: target.sessionID)
    }
}
#endif
