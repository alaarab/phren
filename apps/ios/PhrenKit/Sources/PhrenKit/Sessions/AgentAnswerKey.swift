import Foundation

/// A key the phone may press in an agent's terminal to answer a prompt the
/// agent drew there. The Hook accepts exactly this set and nothing typed.
public enum AgentAnswerKey: String, CaseIterable, Sendable, Identifiable {
    case enter = "Enter", up = "Up", down = "Down", tab = "Tab", yes = "y", no = "n"
    case one = "1", two = "2", three = "3", escape = "Escape"

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
        default: return "Press \(rawValue)"
        }
    }
}
