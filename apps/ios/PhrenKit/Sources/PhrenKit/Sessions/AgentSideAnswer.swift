import Foundation

/// Claude Code's `/btw` side question: asked beside the running turn, answered
/// in a terminal panel the Hook reads and closes. It is never part of the
/// conversation, so it arrives as its own `side-answer` frame.
public struct AgentSideAnswer: Equatable, Identifiable, Sendable {
    public enum State: String, Sendable { case pending, answer, error, cancelled }
    public let id: String
    public let question: String
    public let state: State
    public let answer: String?

    public init(id: String, question: String, state: State, answer: String? = nil) {
        self.id = id; self.question = question; self.state = state; self.answer = answer
    }

    static func read(_ frame: [String: Any]) throws -> Self {
        guard let id = frame["id"] as? String, UUID(uuidString: id) != nil,
              let question = frame["question"] as? String, !question.isEmpty, question.utf8.count <= 4_096,
              let state = State(rawValue: frame["state"] as? String ?? "") else {
            throw PhrenKitError.validation("The computer returned an invalid side answer.")
        }
        let answer = frame["answer"] as? String
        guard answer.map({ $0.utf8.count <= 131_072 }) ?? true, state != .answer || answer?.isEmpty == false else {
            throw PhrenKitError.validation("The computer returned an invalid side answer.")
        }
        return Self(id: id, question: question, state: state, answer: answer)
    }

    /// `/btw <question>` for Claude Code, where it runs beside a working turn.
    public static func question(source: String, text: String) -> String? {
        guard source == "claude" else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("/btw"), trimmed.count > 4,
              trimmed[trimmed.index(trimmed.startIndex, offsetBy: 4)].isWhitespace else { return nil }
        let question = trimmed.dropFirst(4).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return question.isEmpty ? nil : question
    }
}
