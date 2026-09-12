import Foundation

/// The Phren Hook v1 workspace contract. A child is a tab;
/// it can aggregate several agent panes and is never claimed to be one agent.
public struct LiveWorkspaces: Decodable, Equatable, Sendable {
    public struct Tab: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let title: String?
        public let agentStatus: String?
        public let approvalPending: Bool?
        public let agent: String?
        public let cwd: String?
        public let agentPaneCount: Int?
        public let paneCount: Int?
        private let reportedContextUsedPercent: ContextUsedPercent?

        /// Provider-reported percentage, when available. Missing or malformed
        /// metrics stay unknown; token counts alone cannot establish a limit.
        public var contextUsedPercent: Double? {
            guard agentPaneCount == nil || agentPaneCount == 1 else { return nil }
            return reportedContextUsedPercent?.value
        }

        private enum CodingKeys: String, CodingKey {
            case id, label, title, agentStatus, approvalPending, agent, cwd, agentPaneCount, paneCount
            case reportedContextUsedPercent = "contextUsedPercent"
        }

        private struct ContextUsedPercent: Decodable, Equatable, Sendable {
            let value: Double?

            init(from decoder: Decoder) throws {
                let container = try decoder.singleValueContainer()
                let number = try? container.decode(Double.self)
                value = number.flatMap { $0.isFinite && (0...100).contains($0) ? $0 : nil }
            }
        }

        public var displayTitle: String {
            let value = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return value.isEmpty ? label : value
        }

        public enum Activity: String, CaseIterable, Sendable {
            case error = "Error", waiting = "Waiting", working = "Working"
            case idle = "Idle", done = "Done", unknown = "Unknown"
        }

        public var activity: Activity {
            if approvalPending == true { return .waiting }
            switch agentStatus {
            case "working": return .working
            case "idle": return .idle
            case "done": return .done
            case "error": return .error
            case "blocked", "waiting": return .waiting
            default: return .unknown
            }
        }
        public var status: String { approvalPending == true ? "Permission needed" : activity.rawValue }
    }
    public struct Group: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let children: [Tab]
    }
    public struct Focus: Decodable, Equatable, Sendable {
        public let workspaceID: String
        public let tabID: String
        public let paneID: String
    }
    public let kind: String
    public let groups: [Group]
    public let focus: Focus?

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The session response is too large.") }
        let result = try JSONDecoder().decode(Self.self, from: data)
        guard result.kind == "herdr" else {
            throw PhrenKitError.validation("Phren Hook returned an unsupported session provider.")
        }
        var groupIDs: Set<String> = []
        for group in result.groups {
            guard !group.id.isEmpty, groupIDs.insert(group.id).inserted else {
                throw PhrenKitError.validation("The hook returned repeated or empty workspace IDs.")
            }
            var tabIDs: Set<String> = []
            for tab in group.children {
                guard !tab.id.isEmpty, tabIDs.insert(tab.id).inserted else {
                    throw PhrenKitError.validation("The hook returned repeated or empty tab IDs.")
                }
            }
        }
        if let focus = result.focus {
            guard [focus.workspaceID, focus.tabID, focus.paneID].allSatisfy(AgentChatTarget.validID),
                  result.groups.contains(where: { $0.id == focus.workspaceID && $0.children.contains(where: { $0.id == focus.tabID }) }) else {
                throw PhrenKitError.validation("The focused Herdr tab changed. Refresh the computer.")
            }
        }
        return result
    }
}

public struct LiveHost: Codable, Equatable, Sendable, Identifiable {
    public let id: UUID
    public let name: String
    public let address: String
    public let port: Int
    public let username: String
    public var fingerprint: String?
    public var herdrSession: String?
    public var muxID: String { "herdr:" + (herdrSession ?? "default") }

    public init(id: UUID = UUID(), name: String, address: String, port: Int = 22,
                username: String, fingerprint: String? = nil, herdrSession: String? = nil) throws {
        self.id = id
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        self.port = port
        self.username = username.trimmingCharacters(in: .whitespacesAndNewlines)
        self.fingerprint = fingerprint
        self.herdrSession = herdrSession
        try validate()
    }

    public func validate() throws {
        if let herdrSession {
            guard AgentChatTarget.validID(herdrSession), !herdrSession.contains(":") else {
                throw PhrenKitError.validation("Choose a valid Herdr server name.")
            }
        }
        guard !name.isEmpty, name.count <= 100, !address.isEmpty, address.count <= 253,
              !username.isEmpty, username.count <= 100, (1...65535).contains(port),
              !address.contains("/"), !address.contains("@"),
              address.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              [name, address, username].allSatisfy({ $0.rangeOfCharacter(from: .controlCharacters) == nil }) else {
            throw PhrenKitError.validation("Enter a name, SSH hostname or IP address, port from 1–65535, and username.")
        }
        if let fingerprint, fingerprint.range(of: #"^SHA256:[A-Za-z0-9+/]{43}$"#, options: .regularExpression) == nil {
            throw PhrenKitError.validation("The saved SSH host fingerprint is invalid.")
        }
    }
}

/// Device-local host settings, pinned tabs, and explicit directory → store/project mappings.
/// Credentials and observed session data do not belong in this document.
public struct LiveSessionPreferences: Codable, Equatable, Sendable {
    public struct Mapping: Codable, Equatable, Sendable {
        public let hostID: UUID
        public let directory: String
        public let storeID: String
        public let project: String
    }
    public private(set) var schemaVersion = 1
    public private(set) var hosts: [LiveHost] = []
    public private(set) var mappings: [Mapping] = []
    /// Pins follow the host, Herdr server, workspace, and tab identity used by
    /// navigation. Conversation/title changes within that tab keep its pin;
    /// another tab or server does not inherit it. Offline snapshots never prune pins.
    public private(set) var pinnedSessions: [LiveAgentSession.ID] = []

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, hosts, mappings, pinnedSessions
    }

    private init() {}

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        hosts = try values.decode([LiveHost].self, forKey: .hosts)
        mappings = try values.decode([Mapping].self, forKey: .mappings)
        // Only an absent field is an older preference document. A present but
        // malformed field must fail before any saved connections are overwritten.
        pinnedSessions = values.contains(.pinnedSessions)
            ? try values.decode([LiveAgentSession.ID].self, forKey: .pinnedSessions) : []
    }

    public static func read(_ data: Data) throws -> Self {
        if data.isEmpty { return Self() }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.schemaVersion == 1 else { throw PhrenKitError.validation("Update phren to read these live connections.") }
        var ids: Set<UUID> = []
        for host in value.hosts {
            try host.validate()
            guard ids.insert(host.id).inserted else { throw PhrenKitError.validation("Repeated live connection.") }
        }
        var paths: Set<String> = []
        for mapping in value.mappings {
            guard ids.contains(mapping.hostID), !mapping.storeID.isEmpty, !mapping.project.isEmpty,
                  try normalizedDirectory(mapping.directory) == mapping.directory,
                  paths.insert(mapping.hostID.uuidString + mapping.directory).inserted else {
                throw PhrenKitError.validation("Invalid live project mapping.")
            }
        }
        var pins: Set<LiveAgentSession.ID> = []
        for sessionID in value.pinnedSessions {
            guard ids.contains(sessionID.hostID), validPin(sessionID), pins.insert(sessionID).inserted else {
                throw PhrenKitError.validation("Invalid pinned live session.")
            }
        }
        return value
    }

    public static func saving(_ host: LiveHost, in data: Data) throws -> Data {
        var value = try read(data)
        try host.validate()
        value.hosts.removeAll { $0.id == host.id }
        value.hosts.append(host)
        return try JSONEncoder().encode(value)
    }

    public static func removing(_ hostID: UUID, from data: Data) throws -> Data {
        var value = try read(data)
        value.hosts.removeAll { $0.id == hostID }
        value.mappings.removeAll { $0.hostID == hostID }
        value.pinnedSessions.removeAll { $0.hostID == hostID }
        return try JSONEncoder().encode(value)
    }

    public func isPinned(_ sessionID: LiveAgentSession.ID) -> Bool {
        pinnedSessions.contains(sessionID)
    }

    /// Preserve the incoming order within the pinned and unpinned sections.
    public func pinnedFirst(_ sessions: [LiveAgentSession]) -> [LiveAgentSession] {
        let pins = Set(pinnedSessions)
        return sessions.filter { pins.contains($0.id) } + sessions.filter { !pins.contains($0.id) }
    }

    public static func setPinned(_ isPinned: Bool, for sessionID: LiveAgentSession.ID, in data: Data) throws -> Data {
        var value = try read(data)
        guard let host = value.hosts.first(where: { $0.id == sessionID.hostID }) else {
            throw PhrenKitError.validation("Connection no longer exists.")
        }
        guard validPin(sessionID) else { throw PhrenKitError.validation("Invalid pinned live session.") }
        if isPinned {
            guard host.muxID == sessionID.muxID else {
                throw PhrenKitError.validation("The Herdr server changed. Refresh the computer before pinning this session.")
            }
            if !value.isPinned(sessionID) { value.pinnedSessions.append(sessionID) }
        } else {
            value.pinnedSessions.removeAll { $0 == sessionID }
        }
        return try JSONEncoder().encode(value)
    }

    private static func validPin(_ sessionID: LiveAgentSession.ID) -> Bool {
        let server = String(sessionID.muxID.dropFirst("herdr:".count))
        return !sessionID.workspace.isEmpty && !sessionID.tab.isEmpty
            && sessionID.muxID.hasPrefix("herdr:") && AgentChatTarget.validID(server) && !server.contains(":")
    }

    public static func assigning(hostID: UUID, directory: String, storeID: String?, project: String?, in data: Data) throws -> Data {
        var value = try read(data)
        guard value.hosts.contains(where: { $0.id == hostID }) else { throw PhrenKitError.validation("Connection no longer exists.") }
        let path = try normalizedDirectory(directory)
        value.mappings.removeAll { $0.hostID == hostID && $0.directory == path }
        if let storeID, let project {
            guard !storeID.isEmpty, !project.isEmpty else { throw PhrenKitError.validation("Choose a store and project.") }
            value.mappings.append(Mapping(hostID: hostID, directory: path, storeID: storeID, project: project))
        }
        return try JSONEncoder().encode(value)
    }

    public func mapping(hostID: UUID, cwd: String?) -> Mapping? {
        guard let cwd, let path = try? Self.normalizedDirectory(cwd) else { return nil }
        return mappings.filter {
            $0.hostID == hostID && (path == $0.directory || path.hasPrefix($0.directory + "/"))
        }.max { $0.directory.count < $1.directory.count }
    }

    static func normalizedDirectory(_ directory: String) throws -> String {
        let parts = directory.split(separator: "/", omittingEmptySubsequences: true)
        guard directory.hasPrefix("/"), !parts.isEmpty, !parts.contains(".."),
              !parts.contains("."), directory.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw PhrenKitError.validation("Choose an absolute project directory without . or .. components.")
        }
        return "/" + parts.joined(separator: "/")
    }
}
