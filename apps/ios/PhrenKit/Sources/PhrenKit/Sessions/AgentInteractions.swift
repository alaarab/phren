import Foundation

public struct AgentApproval: Decodable, Equatable, Sendable, Identifiable {
    public let actionId: String
    public let title: String?
    public let toolName: String?
    public let message: String?
    public let expiresAt: String?
    public var id: String { actionId }

    public var expiration: Date? {
        guard let expiresAt else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(expiresAt))
            ?? (try? Date.ISO8601FormatStyle().parse(expiresAt))
    }

    /// Show the human explanation first; keep the complete tool input available
    /// separately for inspection. Hook providers often send a JSON tool input.
    public var explanation: String? {
        guard let message, !message.isEmpty else { return nil }
        if let input = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any] {
            for key in ["justification", "description", "command", "cmd"] {
                if let text = input[key] as? String, !text.isEmpty { return text }
            }
        }
        return message
    }
}

public struct AgentInteractionStatus: Equatable, Sendable {
    public let approval: AgentApproval?
    public var activity: String? = nil
    public var modelName: String? = nil
    public var questionsSupported = true
    /// The pane's current git branch, read by Phren Hook on the computer.
    public var branch: String? = nil
    public static func read(_ data: Data, target: AgentChatTarget) throws -> Self? {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("Agent status is too large.") }
        guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = frame["agentStatus"] as? [String: Any] else { return nil }
        guard status["source"] as? String == target.source, status["session"] as? String == target.sessionID else {
            throw PhrenKitError.validation("Status belongs to a different conversation.")
        }
        var approval: AgentApproval?
        if let raw = status["pendingApproval"] as? [String: Any] {
            let candidate = try JSONDecoder().decode(AgentApproval.self, from: JSONSerialization.data(withJSONObject: raw))
            guard !candidate.actionId.isEmpty, candidate.actionId.utf8.count <= 512 else {
                throw PhrenKitError.validation("The approval has no usable identity.")
            }
            approval = candidate
        }
        let activity = status["status"] as? String
        return .init(approval: approval, activity: ["working", "idle", "done", "waiting", "blocked", "error"].contains(activity ?? "") ? activity : nil,
                     modelName: (status["modelName"] as? String).map { String($0.prefix(100)) },
                     questionsSupported: (status["capabilities"] as? [String: Any])?["questions"] as? Bool ?? true,
                     branch: (status["branch"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(200)) })
    }
}

public struct AgentQuestionPrompt: Decodable, Equatable, Sendable, Identifiable {
    public struct Question: Decodable, Equatable, Sendable {
        public struct Option: Decodable, Equatable, Sendable {
            public let label: String
            public let description: String?
        }
        public let id: String?
        public let header: String?
        public let question: String
        public let multiSelect: Bool?
        public let options: [Option]
    }
    public let toolUseId: String
    public let questions: [Question]
    public var id: String { toolUseId }

    public func answerBody(target: AgentChatTarget, selections: [[Int]]) throws -> Data {
        guard selections.count == questions.count else { throw PhrenKitError.validation("Answer every question.") }
        for (question, indexes) in zip(questions, selections) {
            guard !indexes.isEmpty, indexes.count == Set(indexes).count,
                  question.multiSelect == true || indexes.count == 1,
                  indexes.allSatisfy({ question.options.indices.contains($0) }) else {
                throw PhrenKitError.validation("Choose an available answer for every question.")
            }
        }
        return try JSONSerialization.data(withJSONObject: [
            "source": target.source, "sessionId": target.sessionID, "toolUseId": toolUseId,
            "questions": questions.map { q in ["id": q.id ?? "", "header": q.header ?? "", "question": q.question,
                                               "multiSelect": q.multiSelect ?? false, "options": q.options.map(\.label)] as [String: Any] },
            "answers": zip(questions, selections).map { ["questionId": $0.0.id ?? "", "optionIndexes": $0.1] as [String: Any] }
        ])
    }
}

public enum AgentQuestionEvent: Equatable, Sendable {
    case question(AgentQuestionPrompt)
    case resolved(String)

    static func read(_ raw: [String: Any], source: String) -> [Self] {
        var blocks: [[String: Any]] = []
        if source == "codex", raw["type"] as? String == "response_item", let payload = raw["payload"] as? [String: Any] { blocks = [payload] }
        if source == "claude", raw["isMeta"] as? Bool != true, raw["isSidechain"] as? Bool != true,
           let message = raw["message"] as? [String: Any] { blocks = message["content"] as? [[String: Any]] ?? [] }
        return blocks.compactMap { block in
            let kind = block["type"] as? String ?? ""
            if ["function_call_output", "tool_result"].contains(kind), let id = (block["call_id"] ?? block["tool_use_id"]) as? String { return .resolved(id) }
            guard ["function_call", "tool_use"].contains(kind),
                  ["request_user_input", "AskUserQuestion"].contains(block["name"] as? String ?? ""),
                  let id = (block["call_id"] ?? block["id"]) as? String, !id.isEmpty, id.utf8.count <= 512 else { return nil }
            var input = block["input"] as? [String: Any]
            if let arguments = block["arguments"] as? String { input = (try? JSONSerialization.jsonObject(with: Data(arguments.utf8))) as? [String: Any] }
            guard let questions = input?["questions"],
                  let data = try? JSONSerialization.data(withJSONObject: ["toolUseId": id, "questions": questions]),
                  let prompt = try? JSONDecoder().decode(AgentQuestionPrompt.self, from: data),
                  (1...8).contains(prompt.questions.count),
                  prompt.questions.allSatisfy({ !$0.question.isEmpty && (1...12).contains($0.options.count) && $0.options.allSatisfy({ !$0.label.isEmpty }) }) else { return nil }
            return .question(prompt)
        }
    }
}

public struct AgentRepositoryDiff: Decodable, Sendable {
    public struct File: Decodable, Sendable, Identifiable {
        public let path: String
        public let status: String
        public let sections: [Section]
        public var id: String { path }
    }
    public struct Section: Decodable, Sendable, Identifiable {
        public let id: String
        public let kind: String
        public let binary: Bool?
        public let loadState: String?
        public let patch: String?

        public init(id: String, kind: String, binary: Bool? = nil, loadState: String? = nil, patch: String? = nil) {
            self.id = id; self.kind = kind; self.binary = binary; self.loadState = loadState; self.patch = patch
        }
    }
    public let branch: String?
    public let root: String
    public let launchPath: String
    public let files: [File]
    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The repository diff is too large.") }
        let result = try JSONDecoder().decode(Self.self, from: data)
        guard result.root.hasPrefix("/"), result.launchPath.hasPrefix("/"), result.files.count <= 5_000,
              Set(result.files.map(\.path)).count == result.files.count else { throw PhrenKitError.validation("The repository response is invalid.") }
        return result
    }
    public static func statusPath(_ data: Data) throws -> String {
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["git"] as? Bool == true,
              let url = result["url"] as? String,
              url.range(of: #"^/apps/diff/diff_[a-f0-9]+/$"#, options: .regularExpression) != nil else {
            throw PhrenKitError.validation("This pane is not in a Git repository, or its diff is unavailable.")
        }
        return url + "api/status"
    }
}
