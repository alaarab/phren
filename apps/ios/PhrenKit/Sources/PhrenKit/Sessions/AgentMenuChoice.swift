import Foundation

/// A slash command whose agent answers with a menu rather than an argument.
/// The phone shows the same rows natively and, once chosen, types the
/// command and walks the menu with keys (Down to the row, then Enter).
public struct AgentMenuChoice: Identifiable, Equatable, Sendable {
    public let name: String
    public let description: String?
    public var id: String { name }

    public init(name: String, description: String? = nil) {
        self.name = name
        self.description = description
    }

    /// The menu for `command` on `source`, or nil when the command takes an
    /// argument, has no menu, or belongs to the terminal.
    public static func menu(command: String, source: String) -> (title: String, rows: [AgentMenuChoice])? {
        switch (source, command) {
        case ("codex", "/permissions"):
            return ("Permissions", [
                AgentMenuChoice(name: "Ask for approval", description: "Read and edit files in the workspace and run commands; approval for the internet or other files."),
                AgentMenuChoice(name: "Approve for me", description: "Only ask for actions detected as potentially unsafe."),
                AgentMenuChoice(name: "Full Access", description: "Edit files outside the workspace and use the internet without asking. Use with care."),
            ])
        default:
            return nil
        }
    }

    /// The keys that select row `index` in a freshly opened menu.
    public static func keys(selecting index: Int) -> [AgentAnswerKey] {
        Array(repeating: .down, count: max(0, index)) + [.enter]
    }
}
