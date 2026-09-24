import Foundation

/// A key the phone may press in an agent's terminal to answer a prompt the
/// agent drew there. The Hook accepts exactly this set and nothing typed.
public enum AgentAnswerKey: String, CaseIterable, Sendable, Identifiable {
    case enter = "Enter", up = "Up", down = "Down", tab = "Tab", yes = "y", no = "n"
    case one = "1", two = "2", three = "3", escape = "Escape"
    /// The remaining digits a numbered terminal question can answer with.
    case four = "4", five = "5", six = "6", seven = "7", eight = "8", nine = "9"
    /// Codex's "yes, and don't ask again for commands that start with …".
    case proceedAlways = "p"
    /// Codex's "answer the last queued follow-up": opens the queue, after
    /// which the option key (or typed text) is the answer.
    case altUp = "AltUp"

    public var id: String { rawValue }

    /// What the composer row shows, in the order a prompt is usually answered.
    public static let row: [AgentAnswerKey] = [.yes, .no, .enter, .up, .down, .escape]

    public var label: String {
        switch self {
        case .enter: return "Enter"
        case .up: return "\u{2191}"
        case .down: return "\u{2193}"
        case .tab: return "Tab"
        case .yes: return "Y"
        case .no: return "N"
        case .escape: return "Esc"
        case .altUp: return "⌥\u{2191}"
        default: return rawValue
        }
    }

    public var spoken: String {
        switch self {
        case .enter: return "Press Enter"
        case .up: return "Move up"
        case .down: return "Move down"
        case .tab: return "Press Tab"
        case .yes: return "Answer yes"
        case .no: return "Answer no"
        case .escape: return "Press Escape"
        case .altUp: return "Open the queued question"
        default: return "Press \(rawValue)"
        }
    }
}
