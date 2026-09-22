import Foundation

/// What `/model` can be given on the phone without a terminal picker. Each
/// agent accepts the argument form of its own command (`/model sonnet`,
/// `/model gpt-5.6-terra`) and answers in the transcript, so the chat can
/// offer the usual names and still let any id be typed.
public struct AgentModelChoice: Identifiable, Equatable, Sendable {
    public let name: String
    public let argument: String
    public var description: String? = nil
    public var isDefault = false
    public var id: String { argument }

    public init(name: String, argument: String, description: String? = nil, isDefault: Bool = false) {
        self.name = name
        self.argument = argument
        self.description = description
        self.isDefault = isDefault
    }

    /// The catalogue the computer reports (`/v1/models`): what the agent's
    /// own menu would list, so the phone needs no update when models change.
    public static func read(_ data: Data) throws -> [AgentModelChoice] {
        guard data.count <= 262_144, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = object["models"] as? [[String: Any]] else { throw PhrenKitError.validation("The computer returned no model list.") }
        return models.prefix(64).compactMap { raw in
            guard let id = raw["id"] as? String, command(for: id) != nil else { return nil }
            let name = (raw["name"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(100)) } ?? id
            let description = (raw["description"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(300)) }
            return AgentModelChoice(name: name, argument: id, description: description, isDefault: raw["isDefault"] as? Bool == true)
        }
    }

    /// Providers whose `/model <id>` applies without an interactive menu.
    public static func supportsPicker(source: String) -> Bool {
        ["claude", "codex"].contains(source)
    }

    /// The per-harness built-in list, shown when the computer's `/v1/models`
    /// route fails (or cannot be asked). Claude's entries mirror Claude Code's
    /// own `/model` menu and Codex's mirror its app-server `model/list`: the
    /// fixture and the Hook table keep the same rows, pinned by a parity test.
    public static func choices(source: String) -> [AgentModelChoice] {
        switch source {
        case "claude":
            return [
                AgentModelChoice(name: "Fable 5.1", argument: "claude-fable-5-1", description: "Most intelligent.", isDefault: true),
                AgentModelChoice(name: "Opus 5", argument: "claude-opus-5", description: "Most capable for long work."),
                AgentModelChoice(name: "Sonnet 5", argument: "claude-sonnet-5", description: "Fast and capable."),
                AgentModelChoice(name: "Haiku 4.5", argument: "claude-haiku-4-5-20251001", description: "Fastest and lightest."),
                AgentModelChoice(name: "Fable 5.1 (1M context)", argument: "claude-fable-5-1[1m]", description: "Fable 5.1 with a 1M context window."),
            ]
        case "codex":
            return [
                AgentModelChoice(name: "GPT-6-Astra", argument: "gpt-6-astra", description: "Our most capable model for complex, demanding work.", isDefault: true),
                AgentModelChoice(name: "GPT-5.6-Sol", argument: "gpt-5.6-sol", description: "Reliable agentic workhorse for everyday tasks."),
                AgentModelChoice(name: "GPT-5.6-Terra", argument: "gpt-5.6-terra", description: "Balanced agentic coding model for everyday work."),
            ]
        default:
            return []
        }
    }

    /// The one row the radio mark lands on for the session's reported model.
    /// An exact id wins, so `claude-fable-5-1[1m]` never shares its mark with
    /// `claude-fable-5-1`; then a versioned id extending the candidate, then
    /// a recognized family alias such as `sonnet`. Context variants stay
    /// distinct. At most one row matches; ties keep list order.
    public static func markedChoice(current: String?, in choices: [AgentModelChoice]) -> AgentModelChoice? {
        guard let raw = current?.lowercased(), !raw.isEmpty else { return nil }
        var best: (choice: AgentModelChoice, score: Int)?
        for choice in choices {
            let id = choice.argument.lowercased()
            guard id.hasSuffix("[1m]") == raw.hasSuffix("[1m]") else { continue }
            let base = raw.replacingOccurrences(of: "[1m]", with: "")
            let candidate = id.replacingOccurrences(of: "[1m]", with: "")
            let alias = ["fable", "opus", "sonnet", "haiku"].contains(base) && candidate.hasPrefix("claude-" + base + "-")
            let score = id == raw ? 3 : base.hasPrefix(candidate + "-") ? 2 : alias ? 1 : 0
            guard score > 0 else { continue }
            if best == nil || score > best!.score { best = (choice, score) }
        }
        return best?.choice
    }

    /// The command line a choice becomes; a typed id is trimmed to one token.
    public static func command(for argument: String) -> String? {
        let token = argument.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.count <= 100, !token.contains(where: \.isWhitespace),
              token.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_[]:/")).contains($0) }) else { return nil }
        return "/model " + token
    }
}
