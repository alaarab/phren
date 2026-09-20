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

    public static func choices(source: String) -> [AgentModelChoice] {
        switch source {
        case "claude":
            return [
                AgentModelChoice(name: "Fable 5.1", argument: "claude-fable-5-1"),
                AgentModelChoice(name: "Opus 5", argument: "opus"),
                AgentModelChoice(name: "Opus 5 (1M context)", argument: "opus[1m]"),
                AgentModelChoice(name: "Sonnet 5", argument: "sonnet"),
                AgentModelChoice(name: "Haiku 4.5", argument: "haiku"),
            ]
        case "codex":
            return [
                AgentModelChoice(name: "Sol", argument: "gpt-5.6-sol"),
                AgentModelChoice(name: "Terra", argument: "gpt-5.6-terra"),
            ]
        default:
            return []
        }
    }

    /// The command line a choice becomes; a typed id is trimmed to one token.
    public static func command(for argument: String) -> String? {
        let token = argument.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.count <= 100, !token.contains(where: \.isWhitespace),
              token.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_[]:/")).contains($0) }) else { return nil }
        return "/model " + token
    }
}
