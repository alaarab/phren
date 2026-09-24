import Foundation

/// One standing authorization the Hook's `conductor.yaml` holds: which
/// conductor actions it covers, for which scope, on which computers, until
/// when. Matches the Hook's grant schema field for field.
public struct ConductorGrant: Codable, Equatable, Sendable {
    public enum Action: String, Codable, CaseIterable, Sendable {
        case dispatch
        case handOff = "hand_off"
    }

    /// `"global"`, or `"project:<slug>"` for one project.
    public let scope: String
    /// One or two of ``Action``.
    public let actions: [Action]
    /// Named verified peers; nil means any computer.
    public let computers: [String]?
    /// ISO 8601 datetime with offset; nil means until revoked.
    public let until: String?

    public init(scope: String, actions: [Action], computers: [String]? = nil, until: String? = nil) throws {
        try Self.validate(scope: scope, actions: actions, computers: computers, until: until)
        self.scope = scope
        self.actions = actions
        self.computers = computers
        self.until = until
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let scope = try values.decode(String.self, forKey: .scope)
        let actions = try values.decode([Action].self, forKey: .actions)
        let computers = try values.decodeIfPresent([String].self, forKey: .computers)
        let until = try values.decodeIfPresent(String.self, forKey: .until)
        try Self.validate(scope: scope, actions: actions, computers: computers, until: until)
        self.scope = scope
        self.actions = actions
        self.computers = computers
        self.until = until
    }

    /// The project slug for a project scope; nil for `global`.
    public var projectSlug: String? {
        guard scope.hasPrefix("project:") else { return nil }
        return String(scope.dropFirst("project:".count))
    }

    /// "Everywhere" for global, the project name otherwise.
    public var scopeTitle: String { projectSlug ?? "Everywhere" }

    public func actionTitle(_ action: Action) -> String {
        action == .handOff ? "Hand off" : "Dispatch"
    }

    /// Parsed `until`, for the row's expiry caption.
    public var expiresAt: Date? {
        guard let until else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(until))
            ?? (try? Date.ISO8601FormatStyle().parse(until))
    }

    private static func validate(scope: String, actions: [Action], computers: [String]?, until: String?) throws {
        let projectPattern = #"^project:[A-Za-z0-9][A-Za-z0-9_-]{0,99}$"#
        guard scope == "global" || scope.range(of: projectPattern, options: .regularExpression) != nil else {
            throw PhrenKitError.validation("Choose Everywhere or one project.")
        }
        guard (1...2).contains(actions.count), Set(actions).count == actions.count else {
            throw PhrenKitError.validation("Choose at least one conductor action.")
        }
        if let computers {
            guard (1...32).contains(computers.count),
                  computers.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 253 && !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }) else {
                throw PhrenKitError.validation("Choose between one and 32 computers.")
            }
        }
        if let until {
            guard (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(until)) != nil
                || (try? Date.ISO8601FormatStyle().parse(until)) != nil else {
                throw PhrenKitError.validation("Enter a valid expiry date.")
            }
        }
    }
}

/// A conductor `dispatch` or `hand_off` the Hook is asking about, present on
/// the pending approval so the card can offer grant-scoped answers.
public struct ConductorCall: Decodable, Equatable, Sendable {
    /// `"dispatch"` or `"hand_off"`.
    public let action: String
    public let project: String?
    public let computer: String?

    public init(action: String, project: String? = nil, computer: String? = nil) {
        self.action = action
        self.project = project
        self.computer = computer
    }
}

/// The Hook's approval answer decisions: a plain allow or deny, or an allow
/// that also writes a standing grant for this conductor call.
public enum ApprovalDecision: String, Codable, Equatable, Sendable {
    case approve
    case deny
    case allowProject = "allow-project"
    case allowEverywhere = "allow-everywhere"

    /// Whether the agent proceeds (grant answers still approve the call).
    public var allows: Bool { self != .deny }
}
