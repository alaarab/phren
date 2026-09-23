import Foundation

/// Transport values remain typed; an absent dictionary is the legacy Hook contract.
public struct LiveCapabilities: Codable, Equatable, Sendable {
    public let memory: Bool?
    public let tasks: Bool?
    public let hook: Bool?
    public let git: Bool?
    public let diff: Bool?
    public let schedules: Bool?
    public let dispatch: Bool?
    public let codeMap: Bool?
    public let code: Bool?
    public let terminal: String?
    public let shell: String?
    public let webPreview: String?
    public let approvalPush: String?
    public let providers: [String]?

    public enum Feature: String, Sendable { case tasks, schedules, changes, dispatch, codeMap, code }
    public func allows(_ feature: Feature) -> Bool {
        switch feature {
        case .tasks: tasks == true
        case .schedules: schedules == true
        case .changes: git == true || (git == nil && diff == true)
        case .dispatch: dispatch == true
        case .codeMap: codeMap == true
        case .code: code == true
        }
    }
}

public struct HookLoad: Codable, Equatable, Sendable {
    public let average: Double
    public let cpus: Int
    public init(average: Double, cpus: Int) { self.average = average; self.cpus = cpus }
}

public struct LiveHookInfo: Codable, Equatable, Sendable {
    public let capabilities: LiveCapabilities?
    public let modules: [String: String]?
    public let store: String?
    public let profile: String?
    public let generation: String?
    /// The computer's 1-minute load average and CPU count, when reported.
    public let load: HookLoad?
    /// The node gateway's own startup-to-first-byte cost, when it was the path.
    public let gatewayMs: Int?

    public init(capabilities: LiveCapabilities?, modules: [String: String]?, store: String?,
                profile: String?, generation: String?, load: HookLoad? = nil, gatewayMs: Int? = nil) {
        self.capabilities = capabilities; self.modules = modules; self.store = store
        self.profile = profile; self.generation = generation; self.load = load; self.gatewayMs = gatewayMs
    }

    /// Answering, but the computer is oversubscribed or its node gateway was
    /// slow: distinct from unreachable, so the last snapshot stays visible.
    public var slowToAnswer: Bool {
        if let load, load.cpus > 0, load.average > 4 * Double(load.cpus) { return true }
        if let gatewayMs, gatewayMs > 1_500 { return true }
        return false
    }
}

/// The Phren Hook v1 workspace contract. A child is a tab;
/// it can aggregate several agent panes and is never claimed to be one agent.
public struct LiveWorkspaces: Codable, Equatable, Sendable {
    public struct Computer: Codable, Equatable, Sendable {
        public let id: UUID
        public let name: String
        public init(id: UUID, name: String) { self.id = id; self.name = name }
    }
    public struct Tab: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let title: String?
        public let agentStatus: String?
        public let approvalPending: Bool?
        public let agent: String?
        public let starting: Bool?
        public let cwd: String?
        /// The git branch of the agent's folder, when the Hook reports one.
        public let branch: String?
        public let agentPaneCount: Int?
        public let paneCount: Int?
        /// What a working agent is doing right now, as the Hook read it from
        /// the transcript tail ("Bash: swift build", "Editing View.swift").
        public let currentStep: String?
        /// The model the pane's agent runs, as the Hook read it from the
        /// transcript; nil for a pane with more than one agent or no answer yet.
        public let model: String?
        /// The job this tab performs. Older Hooks omit it, which is an ordinary
        /// agent tab; `conductor` is the one store-wide dispatch lead.
        public let role: String?
        public var isConductor: Bool { role == "conductor" }
        /// Running children attached to this pane's conversation. Older Hooks
        /// omit the field and therefore report no workers.
        public var runningChildren: Int { max(0, reportedRunningChildren ?? 0) }
        /// The distinct providers among the running children.
        public var childProviders: [String] { reportedChildProviders ?? [] }
        /// Herdr's state-change counter for the tab's panes: higher means the
        /// agent's status moved more recently. Not a timestamp; only an order.
        public let changedSeq: Int?
        /// The Hook's persisted wall clock for the last title or activity change.
        /// Older Hooks and malformed timestamps leave it unknown.
        public var lastChangedAt: Date? { reportedLastChangedAt?.value }
        private let reportedLastChangedAt: ActivityDate?
        private let reportedContextUsedPercent: ContextUsedPercent?
        private let reportedRunningChildren: Int?
        private let reportedChildProviders: [String]?

        public init(id: String, label: String, title: String? = nil,
                    agentStatus: String? = nil, approvalPending: Bool? = nil,
                    agent: String? = nil, starting: Bool? = nil, cwd: String? = nil,
                    branch: String? = nil, agentPaneCount: Int? = nil,
                    paneCount: Int? = nil, currentStep: String? = nil,
                    model: String? = nil, role: String? = nil,
                    changedSeq: Int? = nil) {
            self.id = id; self.label = label; self.title = title
            self.agentStatus = agentStatus; self.approvalPending = approvalPending
            self.agent = agent; self.starting = starting; self.cwd = cwd
            self.branch = branch; self.agentPaneCount = agentPaneCount
            self.paneCount = paneCount; self.currentStep = currentStep
            self.model = model; self.role = role; self.changedSeq = changedSeq
            reportedLastChangedAt = nil; reportedContextUsedPercent = nil
            reportedRunningChildren = nil; reportedChildProviders = nil
        }

        /// Provider-reported percentage, when available. Missing or malformed
        /// metrics stay unknown; token counts alone cannot establish a limit.
        public var contextUsedPercent: Double? {
            guard agentPaneCount == nil || agentPaneCount == 1 else { return nil }
            return reportedContextUsedPercent?.value
        }

        private enum CodingKeys: String, CodingKey {
            case id, label, title, agentStatus, approvalPending, agent, starting, cwd, branch, agentPaneCount, paneCount, changedSeq, currentStep, model, role
            case reportedContextUsedPercent = "contextUsedPercent"
            case reportedLastChangedAt = "lastChangedAt"
            case reportedRunningChildren = "runningChildren"
            case reportedChildProviders = "childProviders"
        }

        private struct ActivityDate: Codable, Equatable, Sendable {
            let value: Date?
            func encode(to encoder: Encoder) throws {
                var container = encoder.singleValueContainer()
                try container.encode(value?.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            }
            init(from decoder: Decoder) throws {
                let raw = try? decoder.singleValueContainer().decode(String.self)
                value = raw.flatMap {
                    (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse($0))
                        ?? (try? Date.ISO8601FormatStyle().parse($0))
                }
            }
        }

        private struct ContextUsedPercent: Codable, Equatable, Sendable {
            let value: Double?
            func encode(to encoder: Encoder) throws {
                var container = encoder.singleValueContainer()
                try container.encode(value)
            }

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
    public struct Group: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let children: [Tab]
        init(id: String, label: String, children: [Tab]) { self.id = id; self.label = label; self.children = children }
    }
    public struct Focus: Codable, Equatable, Sendable {
        public let workspaceID: String
        public let tabID: String
        public let paneID: String
    }
    public let kind: String
    public let groups: [Group]
    public let focus: Focus?
    /// The Hook's durable identity, distinct from `LiveHost.id`, which exists
    /// only on this phone.
    public let computer: Computer?
    /// What the Hook reports about itself: capabilities and the modules it runs.
    public let phren: LiveHookInfo?
    public var capabilities: LiveCapabilities? { phren?.capabilities }

    /// The snapshot as it will read once Herdr has closed a tab (or a whole
    /// workspace when `tab` is nil): the card leaves the list the moment the
    /// close is confirmed instead of on the next poll.
    public func closing(workspace: String, tab: String?) -> Self {
        let groups = groups.compactMap { group -> Group? in
            guard group.id == workspace else { return group }
            guard let tab else { return nil }
            let children = group.children.filter { $0.id != tab }
            return children.isEmpty ? nil : Group(id: group.id, label: group.label, children: children)
        }
        let focus = focus.flatMap { focus -> Focus? in
            focus.workspaceID == workspace && (tab == nil || focus.tabID == tab) ? nil : focus
        }
        return Self(kind: kind, groups: groups, focus: focus, computer: computer, phren: phren)
    }

    private static let requiringHookKey = CodingUserInfoKey(rawValue: "Phren.requiresHookEnvelope")!
    private enum CodingKeys: String, CodingKey { case kind, groups, focus, phren }
    private struct PhrenInfo: Codable {
        var product: String? = nil
        var `protocol`: Int? = nil
        let computer: Computer?
        let capabilities: LiveCapabilities?
        let modules: [String: String]?
        let store: String?
        let profile: String?
        let generation: String?
        let load: HookLoad?
        let gatewayMs: Int?
    }

    init(kind: String, groups: [Group], focus: Focus?, computer: Computer? = nil, phren: LiveHookInfo? = nil) {
        self.kind = kind; self.groups = groups; self.focus = focus; self.computer = computer; self.phren = phren
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(String.self, forKey: .kind)
        groups = try values.decode([Group].self, forKey: .groups)
        focus = try values.decodeIfPresent(Focus.self, forKey: .focus)
        let info = try values.decodeIfPresent(PhrenInfo.self, forKey: .phren)
        if decoder.userInfo[Self.requiringHookKey] as? Bool == true {
            guard info?.product == "phren-hook", info?.protocol == 1 else {
                throw PhrenKitError.validation("Install Phren Hook on this computer with phren bridge install.")
            }
        }
        computer = info?.computer
        phren = info.map { LiveHookInfo(capabilities: $0.capabilities, modules: $0.modules, store: $0.store, profile: $0.profile, generation: $0.generation, load: $0.load, gatewayMs: $0.gatewayMs) }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(kind, forKey: .kind)
        try values.encode(groups, forKey: .groups)
        try values.encodeIfPresent(focus, forKey: .focus)
        if computer != nil || phren != nil {
            try values.encode(PhrenInfo(computer: computer, capabilities: phren?.capabilities, modules: phren?.modules,
                                        store: phren?.store, profile: phren?.profile, generation: phren?.generation,
                                        load: phren?.load, gatewayMs: phren?.gatewayMs), forKey: .phren)
        }
    }

    public static func read(_ data: Data, requiringHook: Bool = false) throws -> Self {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The session response is too large.") }
        let decoder = JSONDecoder()
        if requiringHook { decoder.userInfo[requiringHookKey] = true }
        let result = try decoder.decode(Self.self, from: data)
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
        if let computer = result.computer {
            guard !computer.name.isEmpty, computer.name.utf8.count <= 253,
                  computer.name.rangeOfCharacter(from: .controlCharacters) == nil else {
                throw PhrenKitError.validation("Phren Hook returned an invalid computer identity.")
            }
        }
        return result
    }
}

public struct LiveHost: Codable, Equatable, Sendable, Identifiable {
    public static let colorPalette = [
        "#6E9BFF", "#35C9C0", "#4CD37A", "#F2B441",
        "#FF8A5B", "#FF6FA5", "#A78BFA", "#9AA5B8",
    ]

    public let id: UUID
    public let name: String
    public let address: String
    public let port: Int
    public let username: String
    /// The immutable id reported by this enrolled Hook. The phone-local `id`
    /// continues to own its keychain key and saved connection.
    public var hookComputerID: UUID?
    public var fingerprint: String?
    public var herdrSession: String?
    public var color: String?
    public var muxID: String { "herdr:" + (herdrSession ?? "default") }

    public init(id: UUID = UUID(), name: String, address: String, port: Int = 22,
                username: String, hookComputerID: UUID? = nil,
                fingerprint: String? = nil, herdrSession: String? = nil,
                color: String? = nil) throws {
        self.id = id
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        self.port = port
        self.username = username.trimmingCharacters(in: .whitespacesAndNewlines)
        self.hookComputerID = hookComputerID
        self.fingerprint = fingerprint
        self.herdrSession = herdrSession
        self.color = color
        try validate()
    }

    public static func defaultColor(for id: UUID) -> String {
        let index = id.uuidString.utf8.reduce(0) { (($0 &* 31) &+ Int($1)) % colorPalette.count }
        return colorPalette[index]
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
        if let color, color.range(of: #"^#[0-9A-F]{6}$"#, options: .regularExpression) == nil {
            throw PhrenKitError.validation("Choose a color as #RRGGBB.")
        }
    }

    /// Remote targets may select another Herdr server without changing the
    /// enrolled address, pin, phone key, or Hook identity.
    public func hasSameConnection(as other: Self) -> Bool {
        id == other.id && address == other.address && port == other.port
            && username == other.username && fingerprint == other.fingerprint
            && (hookComputerID == nil || other.hookComputerID == nil || hookComputerID == other.hookComputerID)
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

    /// Views read this from computed properties inside `body`, so the same
    /// bytes are decoded many times a second. One-entry memo: `@AppStorage`
    /// hands every reader the identical `Data`, and equality on a few hundred
    /// bytes is far cheaper than a decode plus validation.
    private static let memo = DecodeMemo<Self>()

    public static func read(_ data: Data) throws -> Self {
        PerformanceCounters.bump("prefs.read")
        return try memo.value(for: data, decode: decode)
    }

    private static func decode(_ data: Data) throws -> Self {
        PerformanceCounters.bump("prefs.decode")
        if data.isEmpty { return Self() }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.schemaVersion == 1 else { throw PhrenKitError.validation("Update phren to read these live connections.") }
        var ids: Set<UUID> = []
        var computerIDs: Set<UUID> = []
        for host in value.hosts {
            try host.validate()
            guard ids.insert(host.id).inserted,
                  host.hookComputerID.map({ computerIDs.insert($0).inserted }) ?? true else {
                throw PhrenKitError.validation("Repeated live connection.")
            }
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
        guard !value.hosts.contains(where: { host.hookComputerID != nil && $0.hookComputerID == host.hookComputerID }) else {
            throw PhrenKitError.validation("This Hook is already associated with another connection.")
        }
        value.hosts.append(host)
        return try JSONEncoder().encode(value)
    }

    public static func settingColor(hostID: UUID, color: String?, in data: Data) throws -> Data {
        var value = try read(data)
        guard let index = value.hosts.firstIndex(where: { $0.id == hostID }) else {
            throw PhrenKitError.validation("Connection no longer exists.")
        }
        let normalizedColor: String?
        if let color {
            guard color.range(of: #"^#[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil else {
                throw PhrenKitError.validation("Choose a color as #RRGGBB.")
            }
            normalizedColor = color.uppercased()
        } else {
            normalizedColor = nil
        }
        value.hosts[index].color = normalizedColor
        return try JSONEncoder().encode(value)
    }

    public static func associating(hostID: UUID, hookComputerID: UUID, in data: Data) throws -> Data {
        var value = try read(data)
        guard let index = value.hosts.firstIndex(where: { $0.id == hostID }) else {
            throw PhrenKitError.validation("Connection no longer exists.")
        }
        guard !value.hosts.contains(where: { $0.id != hostID && $0.hookComputerID == hookComputerID }) else {
            throw PhrenKitError.validation("This Hook is already associated with another connection.")
        }
        value.hosts[index].hookComputerID = hookComputerID
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

/// Remembers the last `(bytes, outcome)` a `read(_:)` produced — outcome
/// including the thrown error, so a malformed blob isn't re-decoded per frame
/// either. A plain lock rather than an actor: callers are synchronous view
/// code on the main thread, and the critical section is a `Data` compare.
final class DecodeMemo<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var last: (data: Data, result: Result<Value, Error>)?

    func value(for data: Data, decode: (Data) throws -> Value) throws -> Value {
        lock.lock()
        if let last, last.data == data {
            lock.unlock()
            return try last.result.get()
        }
        lock.unlock()
        let result = Result { try decode(data) }
        lock.lock()
        last = (data, result)
        lock.unlock()
        return try result.get()
    }
}
