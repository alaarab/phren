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
        guard [workspaceID, tabID, paneID, sessionID, muxID].allSatisfy(Self.validID), muxID.hasPrefix("herdr:"), ["codex", "claude", "copilot"].contains(source),
              source != "copilot" || UUID(uuidString: sessionID) != nil else {
            throw PhrenKitError.validation("Native chat needs a recognized Codex, Claude Code, or GitHub Copilot conversation in this pane.")
        }
        self.hostID = hostID; self.workspaceID = workspaceID; self.tabID = tabID
        self.paneID = paneID; self.source = source; self.sessionID = sessionID
        self.muxID = muxID
    }

    public var providerName: String { source == "claude" ? "Claude" : source == "copilot" ? "Copilot" : "Codex" }

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
    public var toolCallID: String? = nil
    public var isToolResult: Bool { role == .tool && title == "Tool result" }
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

    public static func read(_ data: Data, source: String) throws -> Self {
        guard ["codex", "claude", "copilot"].contains(source), data.count <= 8_388_608,
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
        var seen: Set<String> = []
        for entry in entries {
            guard let line = entry["line"] as? Int, line >= 0, let raw = entry["raw"] as? [String: Any] else { continue }
            let parts = try source == "codex" ? codex(raw) : source == "copilot" ? copilot(raw)
                : claude(raw, maximumParts: maximumMessages - messages.count)
            questionEvents += AgentQuestionEvent.read(raw, source: source)
            if let event = AgentChatProgressEvent.read(raw, source: source, line: line) { progressEvents.append(event) }
            for (index, part) in parts.enumerated() {
                let id = "\(line):\(part.idIndex ?? index)"
                guard (!part.text.isEmpty || part.role == .tool), seen.insert(id).inserted else { continue }
                let toolCallID = part.toolCallID.flatMap { !$0.isEmpty && $0.utf8.count <= 512 ? $0 : nil }
                messages.append(.init(id: id, line: line, role: part.role, title: part.title,
                                      text: String(part.text.prefix(64_000)), imageBlocks: part.imageBlocks, toolCallID: toolCallID))
            }
        }
        return Self(kind: kind, messages: messages.sorted { $0.line < $1.line }, hasMore: frame["hasMore"] as? Bool ?? false,
                    totalLines: frame["totalLines"] as? Int ?? 0,
                    startLine: frame["startLine"] as? Int ?? entries.compactMap { $0["line"] as? Int }.min(), questionEvents: questionEvents,
                    progressEvents: progressEvents)
    }

    private struct Part {
        let role: AgentChatMessage.Role
        var title: String? = nil
        let text: String
        var imageBlocks: [Int] = []
        var toolCallID: String? = nil
        var idIndex: Int? = nil
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
            return [Part(role: .tool, title: "Tool result", text: readable(payload["output"]), toolCallID: payload["call_id"] as? String)]
        default: return []
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
            case "tool_result": return Part(role: .tool, title: "Tool result", text: text(block["content"]), toolCallID: block["tool_use_id"] as? String, idIndex: idIndex)
            default: return nil
            }
        }
    }
}
