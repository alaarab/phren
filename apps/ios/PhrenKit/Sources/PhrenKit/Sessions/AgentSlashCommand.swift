import Foundation

/// Suggestions are shortcuts, never a command allowlist. The live terminal
/// supplies the complete menu, including installed skills and plugin commands.
public enum AgentSlashCommand {
    public struct Command: Identifiable, Equatable, Sendable {
        public let name: String
        public let detail: String
        public var id: String { name }
    }
    public static func isCommand(_ text: String) -> Bool {
        text.hasPrefix("/")
    }
    public static func suggestions(source: String, draft: String) -> [String] {
        guard isCommand(draft), !draft.contains(where: { $0.isWhitespace }) else { return [] }
        let names: [String]
        switch source {
        case "codex": names = ["/model", "/permissions", "/diff", "/review", "/status", "/skills", "/compact", "/resume", "/new", "/mcp"]
        case "claude": names = ["/help", "/btw", "/model", "/permissions", "/context", "/usage", "/skills", "/compact", "/resume", "/clear", "/mcp"]
        case "copilot": names = ["/help", "/model", "/agent", "/context", "/usage", "/skills", "/compact", "/resume", "/clear", "/mcp"]
        // experimental/agent/src/commands.ts — the ones worth a tap on a phone.
        case "phren": names = ["/help", "/model", "/provider", "/plan", "/context", "/cost", "/diff", "/review", "/compact", "/resume", "/permissions", "/clear"]
        case "opencode": names = ["/help", "/models", "/agents", "/new", "/sessions", "/status", "/diff", "/skills", "/mcps", "/editor", "/themes", "/exit"]
        default: names = []
        }
        return names.filter { $0.hasPrefix(draft.lowercased()) }
    }

    public static func menu(source: String, draft: String = "/") -> [Command] {
        suggestions(source: source, draft: draft).map { name in
            let detail: String
            switch name {
            case "/model": detail = "Choose the model"
            case "/permissions": detail = "Manage agent permissions"
            case "/diff": detail = "Show the working diff"
            case "/review": detail = "Review your changes"
            case "/status": detail = "See session status and usage"
            case "/skills": detail = "Browse available skills"
            case "/compact": detail = "Compact conversation context"
            case "/resume": detail = "Continue a previous session"
            case "/new", "/clear": detail = "Start a fresh conversation"
            case "/mcp": detail = "Manage connected tools"
            case "/help": detail = "Browse agent commands"
            case "/provider": detail = "Switch the model provider"
            case "/plan": detail = "Plan before acting"
            case "/cost": detail = "See this session's cost"
            case "/agent": detail = "Choose an agent"
            case "/context": detail = "Inspect conversation context"
            case "/usage": detail = "See account usage"
            case "/btw": detail = "Ask a side question while it works"
            default: detail = "Open in the agent"
            }
            return Command(name: name, detail: detail)
        }
    }
}
