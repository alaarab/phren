import Foundation

/// An agent conversation belongs to a specific pane on a specific computer.
/// Workspace labels and the newest transcript are never used for routing.
public struct AgentChatTarget: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let hostID: UUID
    public let workspaceID: String
    public let tabID: String
    public let paneID: String
    public let source: String
    public let sessionID: String
    public let muxID: String
    /// Present only before a transcript exists; binds the first prompt to the
    /// Hook's verified terminal/process. Never substitute a made-up session ID.
    public let startingToken: String?
    public var isStarting: Bool { startingToken != nil && sessionID.isEmpty }
    public var id: String { [hostID.uuidString, muxID, workspaceID, tabID, paneID, source, isStarting ? "starting-" + (startingToken ?? "") : sessionID].joined(separator: "/") }
    public var conversationKey: String { "\(source):\(sessionID)" }

    public init(hostID: UUID, workspaceID: String, tabID: String, paneID: String, source: String, sessionID: String, muxID: String = "herdr:default", startingToken: String? = nil) throws {
        let starting = sessionID.isEmpty && startingToken?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        guard [workspaceID, tabID, paneID, muxID].allSatisfy(Self.validID), muxID.hasPrefix("herdr:"), Self.sources.contains(source),
              starting || (startingToken == nil && Self.validID(sessionID) && (!["copilot", "phren", "opencode"].contains(source) || Self.validSessionID(sessionID))) else {
            throw PhrenKitError.validation("Native chat needs a recognized Codex, Claude Code, GitHub Copilot, Phren, or opencode conversation in this pane.")
        }
        self.hostID = hostID; self.workspaceID = workspaceID; self.tabID = tabID
        self.paneID = paneID; self.source = source; self.sessionID = sessionID
        self.muxID = muxID; self.startingToken = startingToken
    }

    /// Agents the app can chat with natively. `phren` is the experimental
    /// phren-agent; its panes appear once Herdr reports that agent kind.
    public static let sources = ["codex", "claude", "copilot", "phren", "opencode"]

    public var providerName: String {
        switch source {
        case "claude": return "Claude"
        case "copilot": return "Copilot"
        case "phren": return "Phren"
        case "opencode": return "opencode"
        default: return "Codex"
        }
    }

    private enum CodingKeys: String, CodingKey { case hostID, workspaceID, tabID, paneID, source, sessionID, muxID, startingToken }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(hostID: values.decode(UUID.self, forKey: .hostID),
                      workspaceID: values.decode(String.self, forKey: .workspaceID), tabID: values.decode(String.self, forKey: .tabID),
                      paneID: values.decode(String.self, forKey: .paneID), source: values.decode(String.self, forKey: .source),
                      sessionID: values.decode(String.self, forKey: .sessionID), muxID: values.decode(String.self, forKey: .muxID), startingToken: values.decodeIfPresent(String.self, forKey: .startingToken))
    }

    public static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 200
            && value.range(of: #"^[A-Za-z0-9_%:.-]+$"#, options: .regularExpression) != nil
    }

    public static func validSessionID(_ value: String) -> Bool {
        UUID(uuidString: value) != nil
            || value.range(of: #"^ses_[0-9A-Za-z]{1,64}$"#, options: .regularExpression) != nil
    }
}

public struct AgentComputer: Codable, Equatable, Hashable, Sendable {
    public let id: UUID
    public let name: String

    public init(id: UUID, name: String) throws {
        guard name.range(of: #"^(?!\.\.?$)[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$"#,
                         options: .regularExpression) != nil else {
            throw PhrenKitError.validation("The agent names an invalid computer.")
        }
        self.id = id; self.name = name
    }

    private enum CodingKeys: String, CodingKey { case id, name }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(id: values.decode(UUID.self, forKey: .id),
                      name: values.decode(String.self, forKey: .name))
    }
}

/// A Hook target has no phone-local host id. PhrenLive adds that only after
/// matching the immutable computer id to an enrolled connection.
public struct AgentRemoteTarget: Codable, Equatable, Hashable, Sendable {
    public let server: String
    public let workspace: String
    public let tab: String
    public let pane: String
    public let source: String
    public let session: String

    public init(server: String, workspace: String, tab: String, pane: String,
                source: String, session: String) throws {
        guard server.range(of: #"^(?!\.\.?$)[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$"#,
                           options: .regularExpression) != nil,
              [workspace, tab, pane].allSatisfy(AgentChatTarget.validID),
              AgentChatTarget.sources.contains(source), AgentChatTarget.validSessionID(session) else {
            throw PhrenKitError.validation("The agent names an invalid remote conversation.")
        }
        self.server = server; self.workspace = workspace; self.tab = tab
        self.pane = pane; self.source = source; self.session = session
    }

    private enum CodingKeys: String, CodingKey { case server, workspace, tab, pane, source, session }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(server: values.decode(String.self, forKey: .server),
                      workspace: values.decode(String.self, forKey: .workspace),
                      tab: values.decode(String.self, forKey: .tab),
                      pane: values.decode(String.self, forKey: .pane),
                      source: values.decode(String.self, forKey: .source),
                      session: values.decode(String.self, forKey: .session))
    }
}

public struct AgentRemote: Codable, Equatable, Hashable, Sendable {
    public let target: AgentRemoteTarget
    /// Parent-scoped on the remote Hook. The conductor row's public id is not
    /// a valid substitute for this value.
    public let child: String?

    public init(target: AgentRemoteTarget, child: String? = nil) throws {
        guard child.map({ $0.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil }) ?? true else {
            throw PhrenKitError.validation("The agent names an invalid remote child.")
        }
        self.target = target; self.child = child
    }

    private enum CodingKeys: String, CodingKey { case target, child }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(target: values.decode(AgentRemoteTarget.self, forKey: .target),
                      child: values.decodeIfPresent(String.self, forKey: .child))
    }
}

public struct AgentChild: Codable, Equatable, Sendable, Identifiable {
    public enum State: String, Codable, Sendable { case running, completed, failed }
    public let id: String
    public let provider: String
    public let model: String?
    public let path: String
    public let callId: String
    public let state: State
    /// A fan-out worker the Hook reports as failed for a refused permission:
    /// `blocked: <type> <pattern>`. The wire still carries `completed` for
    /// older clients, so this reason is what marks the worker refused.
    public let reason: String?
    public let finishedAt: String?
    public let failed: Bool?
    public var finishedDate: Date? { ISO8601Dates.parse(finishedAt) }
    public let worktreeName: String?
    public let branch: String?
    public let computer: AgentComputer?
    public let remote: AgentRemote?
    public let children: [AgentChild]
    /// SwiftUI selection must remain distinct when two computers reuse a
    /// session, public row id, or parent-scoped child id.
    public var navigationID: String {
        [computer?.id.uuidString.lowercased() ?? "local", id, remote?.child ?? "lead"]
            .joined(separator: "/")
    }
    public var checkoutLabel: String? { branch ?? worktreeName }
    public var name: String {
        let leaf = path.split(separator: "/").last.map(String.init) ?? "Agent"
        return leaf.replacingOccurrences(of: "_", with: " ")
    }
    /// A blocked worker the plugin refused a permission for. It is finished,
    /// but it failed: never draw it as a completed agent.
    public var permissionRefused: Bool { reason?.hasPrefix("blocked:") == true }
    /// The refused permission's type and pattern, without the `blocked:`
    /// prefix (`external_directory /path`, `doom_loop glob`).
    public var refusedDetail: String? {
        guard permissionRefused, let reason else { return nil }
        let detail = reason.dropFirst("blocked:".count).trimmingCharacters(in: .whitespaces)
        return detail.isEmpty ? nil : detail
    }
    /// The state a row draws. A refused worker is failed whatever the wire
    /// state says, so an old completed badge can never hide a refusal.
    public var displayState: State { permissionRefused || failed == true ? .failed : state }
    /// A refused worker names the refusal rather than its task.
    public var displayName: String { permissionRefused ? "Permission refused" : name }
    public var agentCount: Int { 1 + children.reduce(0) { $0 + $1.agentCount } }
    public var runningCount: Int { (displayState == .running ? 1 : 0) + children.reduce(0) { $0 + $1.runningCount } }
    public var refusedCount: Int { (permissionRefused ? 1 : 0) + children.reduce(0) { $0 + $1.refusedCount } }

    private enum CodingKeys: String, CodingKey {
        case id, provider, model, path, callId, state, reason, finishedAt, failed, worktreeName, branch, computer, remote, children
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        provider = try values.decode(String.self, forKey: .provider)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        path = try values.decode(String.self, forKey: .path)
        callId = try values.decode(String.self, forKey: .callId)
        state = try values.decode(State.self, forKey: .state)
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
        finishedAt = try values.decodeIfPresent(String.self, forKey: .finishedAt)
        failed = try values.decodeIfPresent(Bool.self, forKey: .failed)
        worktreeName = try values.decodeIfPresent(String.self, forKey: .worktreeName)
        branch = try values.decodeIfPresent(String.self, forKey: .branch)
        computer = try values.decodeIfPresent(AgentComputer.self, forKey: .computer)
        remote = try values.decodeIfPresent(AgentRemote.self, forKey: .remote)
        children = try values.decode([AgentChild].self, forKey: .children)
        guard AgentChatTarget.validID(id), AgentChatTarget.sources.contains(provider),
              remote == nil || computer != nil else {
            throw PhrenKitError.validation("The computer returned an invalid agent relation.")
        }
    }
}

public struct AgentChildTreeRow: Equatable, Sendable {
    public let agent: AgentChild
    public let depth: Int

    public init(agent: AgentChild, depth: Int) {
        self.agent = agent
        self.depth = depth
    }
}

public extension AgentChild {
    static func rows(_ agents: [AgentChild], includeCompleted: Bool) -> [AgentChildTreeRow] {
        rows(agents, includeCompleted: includeCompleted, depth: 0)
    }

    static func runningRows(_ agents: [AgentChild]) -> [AgentChildTreeRow] {
        rows(agents, includeCompleted: false)
    }

    private static func rows(_ agents: [AgentChild], includeCompleted: Bool,
                             depth: Int) -> [AgentChildTreeRow] {
        agents.flatMap { agent in
            // A refused worker is finished but must stay visible: the sheet is
            // where the person learns the permission was refused.
            let visible = includeCompleted || agent.displayState == .running || agent.permissionRefused
            let descendants = rows(agent.children, includeCompleted: includeCompleted,
                                   depth: visible ? depth + 1 : depth)
            return (visible ? [AgentChildTreeRow(agent: agent, depth: depth)] : []) + descendants
        }
    }
}

public struct AgentChildTree: Codable, Equatable, Sendable {
    public let agents: [AgentChild]
    public var agentCount: Int { agents.reduce(0) { $0 + $1.agentCount } }
    public var runningCount: Int { agents.reduce(0) { $0 + $1.runningCount } }
    public static func read(_ data: Data) throws -> Self { try JSONDecoder().decode(Self.self, from: data) }
}

public struct AgentChatPanes: Decodable, Equatable, Sendable {
    public struct Pane: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let agent: String?
        public let agentStatus: String?
        public let sessionId: String?
        public let starting: Bool?
        public let startingToken: String?
        public let title: String?
        public let cwd: String?
        public var displayTitle: String { title?.isEmpty == false ? title! : label }
        public var needsAnswer: Bool { ["blocked", "waiting"].contains(agentStatus ?? "") }
        public func target(hostID: UUID, workspaceID: String, tabID: String, muxID: String = "herdr:default") throws -> AgentChatTarget {
            try AgentChatTarget(hostID: hostID, workspaceID: workspaceID, tabID: tabID,
                                paneID: id, source: agent ?? "", sessionID: sessionId ?? "", muxID: muxID,
                                startingToken: starting == true && sessionId == nil ? startingToken : nil)
        }
    }
    public let kind: String
    public let groupId: String
    public let childId: String
    public let panes: [Pane]

    public static func read(_ data: Data, workspaceID: String, tabID: String) throws -> Self {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The agent list is too large.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.kind == "herdr", value.groupId == workspaceID, value.childId == tabID,
              Set(value.panes.map(\.id)).count == value.panes.count,
              value.panes.allSatisfy({ AgentChatTarget.validID($0.id) }) else {
            throw PhrenKitError.validation("The computer returned a different or invalid agent location. Refresh the session.")
        }
        return value
    }

    /// Attach only to the same starting terminal/process, preserving the pane
    /// selection even when other agents appear while the first prompt runs.
    public func attachedTarget(for target: AgentChatTarget) throws -> AgentChatTarget? {
        guard target.isStarting else { return nil }
        guard groupId == target.workspaceID, childId == target.tabID,
              let pane = panes.first(where: { $0.id == target.paneID }), pane.agent == target.source else {
            throw PhrenKitError.validation("The starting agent changed. Reopen chat before sending.")
        }
        // Once the pane reports a conversation, attach to it even if the
        // starting token changed: the agent may have restarted in the same pane
        // (new PIDs), which is still the conversation the person opened.
        if pane.sessionId != nil {
            return try pane.target(hostID: target.hostID, workspaceID: target.workspaceID, tabID: target.tabID, muxID: target.muxID)
        }
        guard pane.startingToken == target.startingToken else {
            throw PhrenKitError.validation("The starting agent changed. Reopen chat before sending.")
        }
        return nil
    }

    public func validate(_ target: AgentChatTarget, sending: Bool = false) throws -> Pane {
        guard groupId == target.workspaceID, childId == target.tabID,
              let pane = panes.first(where: { $0.id == target.paneID }),
              pane.agent == target.source,
              target.isStarting ? (pane.starting == true && pane.sessionId == nil && pane.startingToken == target.startingToken) : pane.sessionId == target.sessionID else {
            throw PhrenKitError.validation("The agent in this pane changed. Reopen chat to choose its current conversation.")
        }
        // A waiting agent may still take typed text (a plain question in its
        // terminal); the Hook refuses when something structured is pending.
        _ = sending
        return pane
    }
}

public struct AgentChatMessage: Equatable, Sendable, Identifiable {
    public enum Role: String, Sendable { case user, assistant, tool }
    public let id: String
    public let line: Int
    public let role: Role
    public let title: String?
    public let text: String
    /// Computed when a transcript part is decoded, never while a row scrolls.
    /// Includes content, so an edited row of the same length invalidates caches.
    public let renderKey: String
    public let textByteCount: Int
    public var imageBlocks: [Int] = []
    /// Images inside a tool result — a Read of a screenshot, say — as the
    /// transcript's `blob` route addresses them.
    public var resultImages: [ImageRef] = []
    /// Pictures the phone sent that Claude Code recorded only by path — a
    /// `[Image: source: …]` marker per picture, no image block — as the
    /// Hook's uploads route serves them back. Stripped from `text`.
    public var uploadImages: [String] = []
    public var toolCallID: String? = nil
    /// When the transcript row was written, where the source stamps one.
    public var timestamp: Date? = nil
    public var wasQueued = false
    public var isQueued = false
    public var queueKey: String? = nil
    public var isToolError = false
    init(id: String, line: Int, role: Role, title: String?, text: String,
         imageBlocks: [Int] = [], resultImages: [ImageRef] = [], uploadImages: [String] = [], toolCallID: String? = nil) {
        self.id = id; self.line = line; self.role = role; self.title = title; self.text = text
        self.imageBlocks = imageBlocks; self.resultImages = resultImages; self.uploadImages = uploadImages; self.toolCallID = toolCallID
        localCommand = role == .user ? LocalCommand(text) : nil
        textByteCount = text.utf8.count
        renderKey = "\(id)|\(role.rawValue)|\(title ?? "")|\(textByteCount)|\(text.hashValue)"
            + (uploadImages.isEmpty ? "" : "|u\(uploadImages.count):\(uploadImages.hashValue)")
    }
    public struct ImageRef: Hashable, Sendable {
        /// The message content block (Claude/phren: the tool_result; Codex: the output item).
        public let block: Int
        /// The image's index inside that block's own content; nil for Codex.
        public let inner: Int?
        public init(block: Int, inner: Int?) { self.block = block; self.inner = inner }
    }
    public var isToolResult: Bool { role == .tool && title == "Tool result" }
    /// A file a shell call changed, attached by Phren Hook — shown under the
    /// call as a diff rather than counted as a call of its own.
    public var isChange: Bool { role == .tool && title == "Changes" }
    /// Claude Code summarizing the conversation: the boundary row and its
    /// summary draw as one collapsed system line, never a bubble.
    public var isCompaction: Bool { role == .tool && title == "Conversation compacted" }
    /// A slash command or `!` shell line typed at Claude Code's own prompt,
    /// which the transcript records as a user turn wrapped in tags — shown
    /// as a system line rather than a bubble of angle brackets.
    public let localCommand: LocalCommand?
    public struct LocalCommand: Equatable, Sendable {
        public enum Kind: Sendable { case command, shell, output }
        public let kind: Kind
        /// The typed line (`/model`, `pwd`) or the command's output.
        public let text: String
        init(kind: Kind, text: String) { self.kind = kind; self.text = text }
        init?(_ raw: String) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("<command-name>") || trimmed.hasPrefix("<local-command-stdout>") || trimmed.hasPrefix("<local-command-stderr>")
                    || trimmed.hasPrefix("<bash-input>") || trimmed.hasPrefix("<bash-stdout>") || trimmed.hasPrefix("<bash-stderr>") else { return nil }
            func tag(_ name: String) -> String? {
                guard let open = trimmed.range(of: "<\(name)>"), let close = trimmed.range(of: "</\(name)>", range: open.upperBound..<trimmed.endIndex) else { return nil }
                return String(trimmed[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let name = tag("command-name") {
                let args = tag("command-args") ?? ""
                kind = .command; text = args.isEmpty ? name : name + " " + args
            } else if let input = tag("bash-input") {
                kind = .shell; text = input
            } else {
                kind = .output
                text = [tag("local-command-stdout"), tag("local-command-stderr"), tag("bash-stdout"), tag("bash-stderr")]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
            }
        }
    }
}

public struct AgentQueueConsumption: Hashable, Sendable {
    public let line: Int
    public let key: String
}

/// Normalize only visible conversation content. Encrypted reasoning, system
/// prompts, hook metadata, and terminal escape sequences are never rendered.
public struct AgentChatPreview: Equatable, Sendable {
    public let turnStartedAt: Date
    public let text: String
}

public struct AgentChatTranscript: Equatable, Sendable {
    public enum Kind: String, Sendable { case backlog, append, older, preview }
    public enum LimitError: Error, LocalizedError, Sendable {
        case tooManyMessages
        public var errorDescription: String? {
            "This conversation has too many message blocks to load. Open the terminal to view it."
        }
    }
    static let maximumMessages = 4_000
    private static func validQueueKey(_ key: String) -> Bool {
        key.utf8.count == 64 && key.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    public let kind: Kind
    public let messages: [AgentChatMessage]
    public let hasMore: Bool
    public let totalLines: Int
    public let startLine: Int?
    /// The Hook's explicit conversation-replacement flag. A resume delta is
    /// never a replacement; an empty placeholder while the file is missing
    /// carries no conversation to replace with (`replacesConversation`).
    public var reset: Bool = false
    /// True only for a snapshot that actually carries the conversation after
    /// a replacement: the only frame that may clear what the phone retained.
    public var replacesConversation: Bool { reset && (totalLines > 0 || !messages.isEmpty) }
    public var questionEvents: [AgentQuestionEvent] = []
    public var progressEvents: [AgentChatProgressEvent] = []
    public var queueEvents: [AgentQueueConsumption] = []
    /// What the newest rows say about the session itself: the model
    /// answering and the branch the agent was on.
    public var context = AgentSessionContext()
    public var preview: AgentChatPreview? = nil
    public var updatesPreview = false

    /// `sidechain` reads a child agent's own transcript, where Claude marks
    /// every row `isSidechain`: those are that conversation's turns, not the
    /// parent's stray sidechain rows an older Hook would leak.
    public static func read(_ data: Data, source: String, sidechain: Bool = false, session: String? = nil) throws -> Self {
        guard AgentChatTarget.sources.contains(source), data.count <= 8_388_608,
              let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = Kind(rawValue: frame["type"] as? String ?? ""), frame["source"] as? String == source,
              session == nil || frame["session"] as? String == session,
              frame["entries"] == nil || frame["entries"] is [[String: Any]] else {
            throw PhrenKitError.validation("The computer returned an unsupported chat transcript.")
        }
        // The helper omits entries when a new conversation has only metadata.
        let entries = frame["entries"] as? [[String: Any]] ?? []
        var preview: AgentChatPreview?
        let updatesPreview = kind != .older && frame.keys.contains("preview")
        if updatesPreview, !(frame["preview"] is NSNull) {
            guard let value = frame["preview"] as? [String: Any],
                  let start = ISO8601Dates.parse(value["turnStartedAt"] as? String),
                  let text = value["text"] as? String, !text.isEmpty, text.utf8.count <= 131_072 else {
                throw PhrenKitError.validation("The computer returned an invalid reply preview.")
            }
            preview = .init(turnStartedAt: start, text: text)
        }
        if kind == .preview {
            guard updatesPreview, entries.isEmpty else { throw PhrenKitError.validation("A reply preview cannot contain messages.") }
            return Self(kind: kind, messages: [], hasMore: false, totalLines: 0, startLine: nil, preview: preview, updatesPreview: true)
        }
        guard entries.count <= 2_000 else { throw PhrenKitError.validation("The chat transcript is too large.") }
        var messages: [AgentChatMessage] = []
        var questionEvents: [AgentQuestionEvent] = []
        var progressEvents: [AgentChatProgressEvent] = []
        var queueEvents: [AgentQueueConsumption] = []
        var context = AgentSessionContext()
        var seen: Set<String> = []
        for entry in entries {
            guard let line = entry["line"] as? Int, line >= 0, var raw = entry["raw"] as? [String: Any] else { continue }
            if sidechain, raw["isSidechain"] as? Bool == true { raw.removeValue(forKey: "isSidechain") }
            if ["claude", "codex"].contains(source), raw["type"] as? String == "phren_queue_consumed",
               let key = raw["key"] as? String, Self.validQueueKey(key) {
                queueEvents.append(.init(line: line, key: key)); continue
            }
            context.merge(AgentSessionContext.read(raw, source: source, line: line))
            var parts = try source == "codex" ? codex(raw) : source == "copilot" ? copilot(raw) : source == "phren" || source == "opencode" ? phren(raw)
                : claude(raw, maximumParts: maximumMessages - messages.count)
            parts = mergedUserParts(withUploadImages(parts))
            parts += changes(raw, after: parts)
            questionEvents += AgentQuestionEvent.read(raw, source: source)
            if var event = AgentChatProgressEvent.read(raw, source: source, line: line) {
                event.timestamp = Self.timestamp(raw)
                progressEvents.append(event)
            }
            // Claude's real user messages start turns; tool results, queued
            // input and compaction summaries do not. Its final stop reason
            // ends the turn, even when the same row also carries usage.
            if source == "claude" {
                if raw["phrenQueued"] as? Bool != true,
                   parts.contains(where: { $0.role == .user && AgentChatMessage.LocalCommand($0.text) == nil }) {
                    progressEvents.append(.init(line: line, value: .started(Self.timestamp(raw))))
                }
                if let message = raw["message"] as? [String: Any],
                   message["stop_reason"] as? String == "end_turn",
                   raw["isMeta"] as? Bool != true, raw["isSidechain"] as? Bool != true {
                    progressEvents.append(.init(line: line, value: .finished(Self.timestamp(raw))))
                }
            } else if source == "phren" || source == "opencode",
                      raw["type"] as? String == "assistant/message",
                      let data = raw["data"] as? [String: Any], data["usage"] != nil,
                      data["stop_reason"] as? String == "end_turn" {
                progressEvents.append(.init(line: line, value: .finished(ISO8601Dates.parse(raw["time"] as? String))))
            }
            for (index, part) in parts.enumerated() {
                let id = "\(line):\(part.idIndex ?? index)"
                guard (!part.text.isEmpty || part.role == .tool), seen.insert(id).inserted else { continue }
                let toolCallID = part.toolCallID.flatMap { !$0.isEmpty && $0.utf8.count <= 512 ? $0 : nil }
                var message = AgentChatMessage(id: id, line: line, role: part.role, title: part.title,
                                               text: boundedMessageText(part.text), imageBlocks: part.imageBlocks, resultImages: part.resultImages,
                                               uploadImages: part.uploadImages, toolCallID: toolCallID)
                message.timestamp = Self.timestamp(raw)
                message.isToolError = part.isToolError
                if part.role == .user {
                    message.queueKey = (raw["phrenQueueKey"] as? String).flatMap { Self.validQueueKey($0) ? $0 : nil }
                }
                if ["claude", "codex"].contains(source), part.role == .user, raw["phrenQueued"] as? Bool == true {
                    message.wasQueued = true; message.isQueued = true
                    message.queueKey = (raw["phrenQueueKey"] as? String).flatMap { Self.validQueueKey($0) ? $0 : nil }
                }
                messages.append(message)
            }
        }
        let ordered = messages.sorted { $0.line < $1.line }
        return Self(kind: kind, messages: Self.collapsedCompactions(ordered), hasMore: frame["hasMore"] as? Bool ?? false,
                    totalLines: frame["totalLines"] as? Int ?? 0,
                    startLine: frame["startLine"] as? Int ?? entries.compactMap { $0["line"] as? Int }.min(),
                    reset: frame["reset"] as? Bool ?? false, questionEvents: questionEvents,
                    progressEvents: progressEvents, queueEvents: queueEvents, context: context,
                    preview: preview, updatesPreview: updatesPreview)
    }

    /// Foundation JSON strings can retain NSString storage. Walking a long
    /// bridged string by Character repeatedly crosses that boundary; make its
    /// UTF-8 contiguous once before applying the existing grapheme limit.
    static func boundedMessageText(_ value: String) -> String {
        var text = value
        text.makeContiguousUTF8()
        return text.utf8.count <= 64_000 ? text : String(text.prefix(64_000))
    }

    /// A compaction boundary and its summary arrive as adjacent rows. Draw
    /// them as one: keep the row that carries the summary, drop the empty
    /// boundary beside it. A boundary with no summary still shows.
    private static func collapsedCompactions(_ messages: [AgentChatMessage]) -> [AgentChatMessage] {
        var result: [AgentChatMessage] = []
        var index = 0
        while index < messages.count {
            guard messages[index].isCompaction else { result.append(messages[index]); index += 1; continue }
            var end = index
            while end < messages.count, messages[end].isCompaction { end += 1 }
            let group = messages[index..<end]
            if let withText = group.first(where: { !$0.text.isEmpty }) { result.append(withText) }
            else if let first = group.first { result.append(first) }
            index = end
        }
        return result
    }

    struct Part {
        let role: AgentChatMessage.Role
        var title: String? = nil
        var text: String
        var imageBlocks: [Int] = []
        var resultImages: [AgentChatMessage.ImageRef] = []
        var uploadImages: [String] = []
        var toolCallID: String? = nil
        var idIndex: Int? = nil
        var isToolError = false
    }
    /// At most this many pictures are drawn for one turn from the phone.
    static let maximumUploadImages = 8
    private static let uploadImageMarker = try! NSRegularExpression(pattern: #"\[Image: source: ([^\]\n]+)\]"#)
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]
    /// A picture the phone sent lands in Claude Code's transcript as the text
    /// `[Image: source: /path/to/it.png]` — no image block — so the words
    /// would show the marker and no picture. Record the paths that name an
    /// image (the Hook only ever serves those) and take the markers out of
    /// the words; a marker naming anything else stays as it was written.
    static func uploadImageMarkers(in text: String) -> (text: String, paths: [String]) {
        guard text.contains("[Image: source: ") else { return (text, []) }
        var paths: [String] = []
        var stripped = "", cursor = text.startIndex
        for match in uploadImageMarker.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let whole = Range(match.range, in: text), let inner = Range(match.range(at: 1), in: text) else { continue }
            let path = text[inner].trimmingCharacters(in: .whitespaces)
            let ext = (path as NSString).pathExtension.lowercased()
            guard path.hasPrefix("/"), path.utf8.count <= 4_096, imageExtensions.contains(ext),
                  !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { continue }
            if paths.count < maximumUploadImages { paths.append(path) }
            stripped += text[cursor..<whole.lowerBound]; cursor = whole.upperBound
        }
        guard !paths.isEmpty else { return (text, []) }
        stripped += text[cursor...]
        return (stripped.trimmingCharacters(in: .whitespacesAndNewlines), paths)
    }
    /// The person's parts with their upload markers turned into pictures; a
    /// part that was nothing but markers keeps the placeholder the image
    /// blocks use, so the turn still has a bubble to draw them in.
    static func withUploadImages(_ parts: [Part]) -> [Part] {
        parts.map { part in
            guard part.role == .user else { return part }
            let (text, paths) = uploadImageMarkers(in: part.text)
            guard !paths.isEmpty else { return part }
            var updated = part
            updated.text = text.isEmpty ? "[Image attachment]" : text
            updated.uploadImages = paths
            return updated
        }
    }
    /// One turn from the person is one bubble: a row's text and image blocks
    /// arrive as separate parts, and drawn apart the picture floats under
    /// the words it came with. Fold them into the first user part, dropping
    /// the "[Image attachment]" placeholders the pictures stood in for.
    static func mergedUserParts(_ parts: [Part]) -> [Part] {
        let users = parts.indices.filter { parts[$0].role == .user }
        guard users.count > 1, let first = users.first else { return parts }
        var merged = parts[first]
        var texts: [String] = []
        var imageBlocks: [Int] = [], uploadImages: [String] = []
        for index in users {
            let part = parts[index]
            imageBlocks += part.imageBlocks
            uploadImages += part.uploadImages
            if part.text != "[Image attachment]", !part.text.isEmpty { texts.append(part.text) }
        }
        merged = Part(role: .user, title: merged.title, text: texts.isEmpty ? "[Image attachment]" : texts.joined(separator: "\n\n"),
                      imageBlocks: imageBlocks, resultImages: merged.resultImages, uploadImages: Array(uploadImages.prefix(maximumUploadImages)),
                      toolCallID: merged.toolCallID, idIndex: merged.idIndex)
        var result: [Part] = []
        for (index, part) in parts.enumerated() {
            if index == first { result.append(merged) } else if part.role != .user { result.append(part) }
        }
        return result
    }
    /// Text a harness injects into the conversation as if the person typed it:
    /// Codex's environment/filesystem/permission context, system reminders.
    static func isHarnessPreamble(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return ["<environment_context>", "<filesystem>", "<permission_profile", "<system-reminder>", "<user_instructions>", "<turn_context>"]
            .contains { trimmed.hasPrefix($0) }
    }
    /// A user turn that is nothing but Claude Code's background completion
    /// envelope (optionally inside a system-reminder wrapper).
    static func isTaskNotification(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("<task-notification>"), trimmed.contains("<tool-use-id>") else { return false }
        return trimmed.hasPrefix("<task-notification>") || trimmed.hasPrefix("<system-reminder>")
    }
    private static let isoTimestamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
    }()
    private static let isoTimestampPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime]; return formatter
    }()
    static func timestamp(_ raw: [String: Any]) -> Date? {
        if let value = raw["timestamp"] as? String { return isoTimestamp.date(from: value) ?? isoTimestampPlain.date(from: value) }
        if let value = raw["timestamp"] as? Double { return Date(timeIntervalSince1970: value > 1e12 ? value / 1000 : value) }
        return nil
    }
    /// Where the images sit inside a tool result's content array.
    private static func innerImages(_ content: Any?) -> [Int] {
        (content as? [[String: Any]] ?? []).enumerated().compactMap { ["image", "input_image"].contains($0.element["type"] as? String ?? "") ? $0.offset : nil }
    }
    /// What a shell call changed on disk, as Phren Hook attaches it to the
    /// call's output row (`phren_changes`, keyed by call id): one Patch-shaped
    /// part per file, in the apply_patch form the diff cards already draw.
    private static func changes(_ raw: [String: Any], after parts: [Part]) -> [Part] {
        guard let attached = raw["phren_changes"] as? [String: [[String: Any]]] else { return [] }
        var extra: [Part] = []
        for part in parts where part.title == "Tool result" {
            guard let id = part.toolCallID, let files = attached[id] else { continue }
            for file in files.prefix(40) {
                guard let path = file["path"] as? String, !path.isEmpty, path.utf8.count <= 4_096,
                      let patch = file["patch"] as? String, !patch.isEmpty else { continue }
                let status = file["status"] as? String ?? "M"
                let header = status == "A" ? "*** Add File: " : status == "D" ? "*** Delete File: " : "*** Update File: "
                let hunks = patch.components(separatedBy: "\n").drop { !$0.hasPrefix("@@") }.joined(separator: "\n")
                extra.append(Part(role: .tool, title: "Changes", text: header + path + "\n" + hunks, toolCallID: id))
            }
        }
        return extra
    }
    private static func text(_ value: Any?) -> String {
        if let value = value as? String { return value }
        guard let blocks = value as? [[String: Any]] else { return "" }
        return blocks.compactMap { block -> String? in
            switch block["type"] as? String {
            case "text", "input_text", "output_text": return block["text"] as? String
            case "image", "input_image": return "[Image attachment]"
            default: return nil
            }
        }.joined(separator: "\n\n")
    }
    private static func readable(_ value: Any?) -> String {
        if let value = value as? String { return value }
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
    private static func codex(_ raw: [String: Any]) -> [Part] {
        guard raw["type"] as? String == "response_item", let payload = raw["payload"] as? [String: Any] else { return [] }
        switch payload["type"] as? String {
        case "message":
            guard let role = AgentChatMessage.Role(rawValue: payload["role"] as? String ?? ""), role != .tool else { return [] }
            let images = (payload["content"] as? [[String: Any]] ?? []).enumerated().compactMap { index, block in
                ["input_image", "image"].contains(block["type"] as? String ?? "") ? index : nil
            }
            let body = text(payload["content"])
            // Codex writes its own environment/permission preamble as the first
            // "user" turn; that is the harness talking, not the person.
            if role == .user, images.isEmpty, Self.isHarnessPreamble(body) { return [] }
            return [Part(role: role, text: body, imageBlocks: images)]
        case "function_call", "custom_tool_call":
            return [Part(role: .tool, title: payload["name"] as? String ?? "Tool", text: readable(payload["arguments"] ?? payload["input"]), toolCallID: payload["call_id"] as? String)]
        case "function_call_output", "custom_tool_call_output":
            return [Part(role: .tool, title: "Tool result", text: readable(payload["output"]),
                         resultImages: innerImages(payload["output"]).map { AgentChatMessage.ImageRef(block: $0, inner: nil) }, toolCallID: payload["call_id"] as? String)]
        default: return []
        }
    }
    /// phren-agent's event log, as Phren Hook exports it: one `user/message`,
    /// `assistant/message` or `tool/results` event per row, each carrying an
    /// Anthropic-shaped message whose blocks are text, image, tool_use or
    /// tool_result (reasoning is already redacted on the computer).
    private static func phren(_ raw: [String: Any]) -> [Part] {
        guard let type = raw["type"] as? String, let data = raw["data"] as? [String: Any],
              let message = data["message"] as? [String: Any] else { return [] }
        let role: AgentChatMessage.Role
        switch type {
        case "user/message": role = .user
        case "assistant/message": role = .assistant
        case "tool/results": role = .tool
        default: return []
        }
        if let content = message["content"] as? String {
            return role == .tool ? [] : [Part(role: role, text: content)]
        }
        guard let blocks = message["content"] as? [[String: Any]] else { return [] }
        return blocks.enumerated().compactMap { index, block -> Part? in
            switch block["type"] as? String {
            case "text":
                guard role != .tool, let text = block["text"] as? String, !text.isEmpty else { return nil }
                return Part(role: role, text: text, idIndex: index)
            case "image":
                return role == .tool ? nil : Part(role: role, text: "[Image attachment]", imageBlocks: [index], idIndex: index)
            case "tool_use":
                return Part(role: .tool, title: block["name"] as? String ?? "Tool", text: readable(block["input"]), toolCallID: block["id"] as? String, idIndex: index)
            case "tool_result":
                return Part(role: .tool, title: "Tool result", text: text(block["content"]),
                            resultImages: innerImages(block["content"]).map { AgentChatMessage.ImageRef(block: index, inner: $0) },
                            toolCallID: block["tool_use_id"] as? String, idIndex: index, isToolError: block["is_error"] as? Bool == true)
            default: return nil
            }
        }
    }
    private static func copilot(_ raw: [String: Any]) -> [Part] {
        guard raw["agentId"] == nil, raw["ephemeral"] as? Bool != true,
              let data = raw["data"] as? [String: Any] else { return [] }
        switch raw["type"] as? String {
        case "user.message":
            guard data["source"] == nil || data["source"] as? String == "user" else { return [] }
            return [Part(role: .user, text: text(data["content"]))]
        case "assistant.message": return [Part(role: .assistant, text: text(data["content"]))]
        case "tool.execution_start": return [Part(role: .tool, title: data["toolName"] as? String ?? "Tool", text: readable(data["arguments"]), toolCallID: data["toolCallId"] as? String)]
        case "tool.execution_complete":
            let result = data["result"] as? [String: Any], error = data["error"] as? [String: Any]
            return [Part(role: .tool, title: "Tool result", text: text(result?["content"]) + text(error?["message"]), toolCallID: data["toolCallId"] as? String)]
        default: return []
        }
    }
    private static func claude(_ raw: [String: Any], maximumParts: Int) throws -> [Part] {
        // Claude Code's compaction boundary: the point in the transcript where
        // the conversation was summarized. It carries no words of its own.
        if raw["type"] as? String == "system", raw["phrenCompacted"] as? Bool == true {
            return [Part(role: .tool, title: "Conversation compacted", text: "")]
        }
        if raw["phrenBackground"] as? Bool == true,
           let message = raw["message"] as? [String: Any], let content = message["content"] as? String {
            return [Part(role: .tool, title: "Background notification", text: content)]
        }
        guard raw["isMeta"] as? Bool != true, raw["isSidechain"] as? Bool != true,
              let message = raw["message"] as? [String: Any],
              let role = AgentChatMessage.Role(rawValue: message["role"] as? String ?? ""), role != .tool else { return [] }
        // The summary that follows the boundary: flagged by the Hook, or, on
        // older Hooks, a user turn opened by the continuation preamble. Its
        // words are capped so one summary can never draw a giant bubble.
        if role == .user, raw["isCompactSummary"] as? Bool == true {
            return [Part(role: .tool, title: "Conversation compacted", text: String(Self.text(message["content"]).prefix(4_000)))]
        }
        if let content = message["content"] as? String {
            // Claude Code also records a background job's completion as a user
            // turn wrapped in <task-notification>; that is the Background row's
            // business, not a bubble of angle brackets.
            if role == .user, Self.isTaskNotification(content) {
                return [Part(role: .tool, title: "Background notification", text: content)]
            }
            if role == .user, content.hasPrefix("This session is being continued from a previous conversation") {
                return [Part(role: .tool, title: "Conversation compacted", text: String(content.prefix(4_000)))]
            }
            if role == .user, Self.isHarnessPreamble(content) { return [] }
            guard content.isEmpty || maximumParts > 0 else { throw LimitError.tooManyMessages }
            return [Part(role: role, text: content)]
        }
        guard let blocks = message["content"] as? [[String: Any]] else { return [] }
        // A single provider row can contain thousands of blocks. Enforce the
        // history's message ceiling before allocating Parts and display text;
        // raw-entry and byte limits alone do not bound this expansion. Reject
        // the whole frame, since paging by source line cannot recover a cut row.
        var visible = 0
        for block in blocks {
            switch block["type"] as? String {
            case "text": if (block["text"] as? String ?? "").isEmpty { continue }
            case "image", "tool_use", "tool_result": break
            default: continue
            }
            visible += 1
            guard visible <= maximumParts else { throw LimitError.tooManyMessages }
        }
        var normalizedIndex = 0
        return blocks.enumerated().compactMap { index, block in
            guard let type = block["type"] as? String, ["text", "image", "tool_use", "tool_result"].contains(type) else { return nil }
            // Empty text used to occupy a Part before being discarded. Keep
            // later message IDs stable without allocating those empty Parts.
            let idIndex = normalizedIndex; normalizedIndex += 1
            switch block["type"] as? String {
            case "text":
                guard let text = block["text"] as? String, !text.isEmpty else { return nil }
                if role == .user, Self.isTaskNotification(text) {
                    return Part(role: .tool, title: "Background notification", text: text, idIndex: idIndex)
                }
                return Part(role: role, text: text, idIndex: idIndex)
            case "image": return Part(role: role, text: "[Image attachment]", imageBlocks: [index], idIndex: idIndex)
            case "tool_use": return Part(role: .tool, title: block["name"] as? String ?? "Tool", text: readable(block["input"]), toolCallID: block["id"] as? String, idIndex: idIndex)
            case "tool_result": return Part(role: .tool, title: "Tool result", text: text(block["content"]),
                                            resultImages: innerImages(block["content"]).map { AgentChatMessage.ImageRef(block: index, inner: $0) },
                                            toolCallID: block["tool_use_id"] as? String, idIndex: idIndex, isToolError: block["is_error"] as? Bool == true)
            default: return nil
            }
        }
    }
}

/// The model and git branch a transcript reports for its session, each from
/// the newest row that carried it. Claude Code stamps `gitBranch` on every
/// row and `message.model` on assistant rows; Codex records `model` in a
/// `turn_context` row (which Phren Hook exports with only that field). A
/// row that lacks a field never clears an older value, so a status-only row
/// can't blank the model the last reply named.
public struct AgentSessionContext: Equatable, Sendable {
    public var modelName: String?
    public var branch: String?
    /// The newest transcript line either value came from; -1 when neither
    /// has been seen, so an older history page never overrides a newer one.
    public var line = -1

    public init(modelName: String? = nil, branch: String? = nil, line: Int = -1) {
        self.modelName = modelName; self.branch = branch; self.line = line
    }

    static func read(_ raw: [String: Any], source: String, line: Int) -> Self {
        var found = Self(line: line)
        if source == "claude", raw["isMeta"] as? Bool != true, raw["isSidechain"] as? Bool != true {
            if let message = raw["message"] as? [String: Any], message["role"] as? String == "assistant" {
                found.modelName = name(message["model"])
            }
            found.branch = name(raw["gitBranch"], limit: 200)
        } else if source == "codex", raw["type"] as? String == "turn_context" {
            found.modelName = name((raw["payload"] as? [String: Any])?["model"])
        }
        return found
    }

    /// Takes `other`'s values when it is at least as new as what is held.
    public mutating func merge(_ other: Self) {
        guard other.modelName != nil || other.branch != nil, other.line >= line else { return }
        if let modelName = other.modelName { self.modelName = modelName }
        if let branch = other.branch { self.branch = branch }
        line = other.line
    }

    private static func name(_ value: Any?, limit: Int = 100) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(limit))
    }
}
