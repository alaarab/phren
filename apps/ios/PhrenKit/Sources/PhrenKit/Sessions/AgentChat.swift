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
    public var id: String { [hostID.uuidString, muxID, workspaceID, tabID, paneID, source, sessionID].joined(separator: "/") }

    public init(hostID: UUID, workspaceID: String, tabID: String, paneID: String, source: String, sessionID: String, muxID: String = "herdr:default") throws {
        guard [workspaceID, tabID, paneID, sessionID, muxID].allSatisfy(Self.validID), muxID.hasPrefix("herdr:"), Self.sources.contains(source),
              !["copilot", "phren"].contains(source) || UUID(uuidString: sessionID) != nil else {
            throw PhrenKitError.validation("Native chat needs a recognized Codex, Claude Code, GitHub Copilot, or Phren conversation in this pane.")
        }
        self.hostID = hostID; self.workspaceID = workspaceID; self.tabID = tabID
        self.paneID = paneID; self.source = source; self.sessionID = sessionID
        self.muxID = muxID
    }

    /// Agents the app can chat with natively. `phren` is the experimental
    /// phren-agent; its panes appear once Herdr reports that agent kind.
    public static let sources = ["codex", "claude", "copilot", "phren"]

    public var providerName: String {
        switch source {
        case "claude": return "Claude"
        case "copilot": return "Copilot"
        case "phren": return "Phren"
        default: return "Codex"
        }
    }

    private enum CodingKeys: String, CodingKey { case hostID, workspaceID, tabID, paneID, source, sessionID, muxID }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(hostID: values.decode(UUID.self, forKey: .hostID),
                      workspaceID: values.decode(String.self, forKey: .workspaceID), tabID: values.decode(String.self, forKey: .tabID),
                      paneID: values.decode(String.self, forKey: .paneID), source: values.decode(String.self, forKey: .source),
                      sessionID: values.decode(String.self, forKey: .sessionID), muxID: values.decode(String.self, forKey: .muxID))
    }

    public static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 200
            && value.range(of: #"^[A-Za-z0-9_%:.-]+$"#, options: .regularExpression) != nil
    }
}

public struct AgentChatPanes: Decodable, Equatable, Sendable {
    public struct Pane: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let agent: String?
        public let agentStatus: String?
        public let sessionId: String?
        public let title: String?
        public let cwd: String?
        public var displayTitle: String { title?.isEmpty == false ? title! : label }
        public var needsAnswer: Bool { ["blocked", "waiting"].contains(agentStatus ?? "") }
        public func target(hostID: UUID, workspaceID: String, tabID: String, muxID: String = "herdr:default") throws -> AgentChatTarget {
            try AgentChatTarget(hostID: hostID, workspaceID: workspaceID, tabID: tabID,
                                paneID: id, source: agent ?? "", sessionID: sessionId ?? "", muxID: muxID)
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

    public func validate(_ target: AgentChatTarget, sending: Bool = false) throws -> Pane {
        guard groupId == target.workspaceID, childId == target.tabID,
              let pane = panes.first(where: { $0.id == target.paneID }),
              pane.agent == target.source, pane.sessionId == target.sessionID else {
            throw PhrenKitError.validation("The agent in this pane changed. Reopen chat to choose its current conversation.")
        }
        if sending && pane.needsAnswer {
            throw PhrenKitError.validation("This agent needs an approval or answer in the terminal before another message can be sent.")
        }
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
    public var imageBlocks: [Int] = []
    /// Images inside a tool result — a Read of a screenshot, say — as the
    /// transcript's `blob` route addresses them.
    public var resultImages: [ImageRef] = []
    public var toolCallID: String? = nil
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
}

/// Normalize only visible conversation content. Encrypted reasoning, system
/// prompts, hook metadata, and terminal escape sequences are never rendered.
public struct AgentChatTranscript: Equatable, Sendable {
    public enum Kind: String, Sendable { case backlog, append, older }
    public enum LimitError: Error, LocalizedError, Sendable {
        case tooManyMessages
        public var errorDescription: String? {
            "This conversation has too many message blocks to load. Open the terminal to view it."
        }
    }
    static let maximumMessages = 4_000
    public let kind: Kind
    public let messages: [AgentChatMessage]
    public let hasMore: Bool
    public let totalLines: Int
    public let startLine: Int?
    public var questionEvents: [AgentQuestionEvent] = []
    public var progressEvents: [AgentChatProgressEvent] = []
    /// What the newest rows say about the session itself: the model
    /// answering and the branch the agent was on.
    public var context = AgentSessionContext()

    public static func read(_ data: Data, source: String) throws -> Self {
        guard AgentChatTarget.sources.contains(source), data.count <= 8_388_608,
              let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = Kind(rawValue: frame["type"] as? String ?? ""), frame["source"] as? String == source,
              frame["entries"] == nil || frame["entries"] is [[String: Any]] else {
            throw PhrenKitError.validation("The computer returned an unsupported chat transcript.")
        }
        // The helper omits entries when a new conversation has only metadata.
        let entries = frame["entries"] as? [[String: Any]] ?? []
        guard entries.count <= 2_000 else { throw PhrenKitError.validation("The chat transcript is too large.") }
        var messages: [AgentChatMessage] = []
        var questionEvents: [AgentQuestionEvent] = []
        var progressEvents: [AgentChatProgressEvent] = []
        var context = AgentSessionContext()
        var seen: Set<String> = []
        for entry in entries {
            guard let line = entry["line"] as? Int, line >= 0, let raw = entry["raw"] as? [String: Any] else { continue }
            context.merge(AgentSessionContext.read(raw, source: source, line: line))
            var parts = try source == "codex" ? codex(raw) : source == "copilot" ? copilot(raw) : source == "phren" ? phren(raw)
                : claude(raw, maximumParts: maximumMessages - messages.count)
            parts += changes(raw, after: parts)
            questionEvents += AgentQuestionEvent.read(raw, source: source)
            if let event = AgentChatProgressEvent.read(raw, source: source, line: line) { progressEvents.append(event) }
            for (index, part) in parts.enumerated() {
                let id = "\(line):\(part.idIndex ?? index)"
                guard (!part.text.isEmpty || part.role == .tool), seen.insert(id).inserted else { continue }
                let toolCallID = part.toolCallID.flatMap { !$0.isEmpty && $0.utf8.count <= 512 ? $0 : nil }
                messages.append(.init(id: id, line: line, role: part.role, title: part.title,
                                      text: String(part.text.prefix(64_000)), imageBlocks: part.imageBlocks, resultImages: part.resultImages, toolCallID: toolCallID))
            }
        }
        return Self(kind: kind, messages: messages.sorted { $0.line < $1.line }, hasMore: frame["hasMore"] as? Bool ?? false,
                    totalLines: frame["totalLines"] as? Int ?? 0,
                    startLine: frame["startLine"] as? Int ?? entries.compactMap { $0["line"] as? Int }.min(), questionEvents: questionEvents,
                    progressEvents: progressEvents, context: context)
    }

    private struct Part {
        let role: AgentChatMessage.Role
        var title: String? = nil
        let text: String
        var imageBlocks: [Int] = []
        var resultImages: [AgentChatMessage.ImageRef] = []
        var toolCallID: String? = nil
        var idIndex: Int? = nil
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
            return [Part(role: role, text: text(payload["content"]), imageBlocks: images)]
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
                            toolCallID: block["tool_use_id"] as? String, idIndex: index)
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
        guard raw["isMeta"] as? Bool != true, raw["isSidechain"] as? Bool != true,
              let message = raw["message"] as? [String: Any],
              let role = AgentChatMessage.Role(rawValue: message["role"] as? String ?? ""), role != .tool else { return [] }
        if let content = message["content"] as? String {
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
                return Part(role: role, text: text, idIndex: idIndex)
            case "image": return Part(role: role, text: "[Image attachment]", imageBlocks: [index], idIndex: idIndex)
            case "tool_use": return Part(role: .tool, title: block["name"] as? String ?? "Tool", text: readable(block["input"]), toolCallID: block["id"] as? String, idIndex: idIndex)
            case "tool_result": return Part(role: .tool, title: "Tool result", text: text(block["content"]),
                                            resultImages: innerImages(block["content"]).map { AgentChatMessage.ImageRef(block: index, inner: $0) },
                                            toolCallID: block["tool_use_id"] as? String, idIndex: idIndex)
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
