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
            for key in ["justification", "description", "command", "cmd", "plan"] {
                if let text = input[key] as? String, !text.isEmpty { return text }
            }
        }
        return message
    }

    /// Claude Code asks its questions through a permission request: the tool
    /// is `AskUserQuestion` and the input is the question set. The phone
    /// answers by approving with that input plus `answers`.
    public var isQuestion: Bool { toolName == "AskUserQuestion" }
    public var questionInput: [String: Any]? {
        guard isQuestion, let message, message.utf8.count <= 32_768 else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(message.utf8))) as? [String: Any]
    }
    public var questionPrompt: AgentQuestionPrompt? {
        guard let input = questionInput else { return nil }
        return AgentQuestionPrompt.read(id: actionId, questions: input["questions"])
    }
}

/// A permission request the agent is drawing in its own terminal because the
/// Hook had no one to hold it for. Read-only on the phone: the answer goes
/// in as keys, not as an approval.
public struct AgentTerminalPrompt: Decodable, Equatable, Sendable {
    public let toolName: String?
    public let message: String?

    public init(toolName: String?, message: String?) {
        self.toolName = toolName
        self.message = message
    }

    /// The same first-line rule as an approval card: the human reason or
    /// command when the input carries one, otherwise the input itself.
    public var explanation: String? {
        guard let message, !message.isEmpty else { return nil }
        if let input = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any] {
            for key in ["justification", "description", "command", "cmd", "plan"] {
                if let text = input[key] as? String, !text.isEmpty { return text }
            }
        }
        return message
    }
    public var command: String? {
        guard let message, let input = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any] else { return nil }
        return ["command", "cmd"].lazy.compactMap { input[$0] as? String }.first { !$0.isEmpty }
    }
}

public struct AgentInteractionStatus: Equatable, Sendable {
    public let approval: AgentApproval?
    public var terminalPrompt: AgentTerminalPrompt? = nil
    public var activity: String? = nil
    public var modelName: String? = nil
    public var questionsSupported = true
    public var asyncQuestionsSupported = false
    public var pendingQuestions: [AgentQuestionPrompt]? = nil
    /// The pane's current git branch, read by Phren Hook on the computer.
    public var branch: String? = nil
    /// True while the agent is summarizing the conversation to reclaim context.
    public var compacting = false
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
        var terminalPrompt: AgentTerminalPrompt?
        if approval == nil, let raw = status["terminalPrompt"] as? [String: Any], JSONSerialization.isValidJSONObject(raw) {
            terminalPrompt = try? JSONDecoder().decode(AgentTerminalPrompt.self, from: JSONSerialization.data(withJSONObject: raw))
            if let message = terminalPrompt?.message, message.utf8.count > 32_768 { terminalPrompt = AgentTerminalPrompt(toolName: terminalPrompt?.toolName, message: String(message.prefix(32_768))) }
        }
        let activity = status["status"] as? String
        return .init(approval: approval, terminalPrompt: terminalPrompt, activity: ["working", "idle", "done", "waiting", "blocked", "error"].contains(activity ?? "") ? activity : nil,
                     modelName: (status["modelName"] as? String).map { String($0.prefix(100)) },
                     questionsSupported: (status["capabilities"] as? [String: Any])?["questions"] as? Bool ?? true,
                     asyncQuestionsSupported: (status["capabilities"] as? [String: Any])?["asyncQuestions"] as? Bool ?? false,
                     pendingQuestions: (status["pendingQuestions"] as? [[String: Any]]).map { values in values.prefix(64).compactMap { raw in
                         guard let id = raw["toolUseId"] as? String else { return nil }
                         // Status already uses the normalized question shape.
                         guard var prompt = AgentQuestionPrompt.read(id: id, questions: raw["questions"]) else { return nil }
                         prompt.isAsync = true; return prompt
                     } },
                     branch: (status["branch"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(200)) },
                     compacting: status["compacting"] as? Bool ?? false)
    }
}

public struct AgentQuestionPrompt: Decodable, Equatable, Sendable, Identifiable {
    public struct Question: Decodable, Equatable, Sendable {
        public struct Option: Decodable, Equatable, Sendable {
            public let label: String
            public let description: String?
            /// Claude Code's `preview`: a mockup, snippet or config rendered
            /// monospaced beside the choice. Bounded so one option cannot
            /// swallow the card.
            public var preview: String? { rawPreview.flatMap { $0.isEmpty ? nil : String($0.prefix(4_000)) } }
            private let rawPreview: String?
            enum CodingKeys: String, CodingKey { case label, description, rawPreview = "preview" }
            public init(label: String, description: String? = nil, preview: String? = nil) {
                self.label = label; self.description = description; self.rawPreview = preview
            }
        }
        public let id: String?
        public let header: String?
        public let question: String
        public let multiSelect: Bool?
        public let options: [Option]
        /// Claude Code: `choice` (the default), or `text` / `number` for a
        /// typed answer with no options.
        public let kind: String?
        public var isFreeText: Bool { kind == "text" || kind == "number" }
    }
    public let toolUseId: String
    /// Async Codex questions remain pending after the tool acknowledges receipt.
    public var isAsync: Bool? = nil
    public let questions: [Question]
    public var id: String { toolUseId }

    /// A bounded, well-formed question set from a transcript block or a
    /// permission request, or nothing.
    static func read(id: String, questions: Any?, isAsync: Bool = false) -> Self? {
        // Codex's async prompt uses `title` and string options; older prompts
        // and Claude use `question` and option objects.
        let normalized = (questions as? [[String: Any]])?.map { raw in
            var question = raw
            if isAsync {
                question["question"] = raw["title"]
                question["options"] = (raw["options"] as? [String])?.map { ["label": $0] } ?? []
                if (question["options"] as? [[String: Any]])?.isEmpty == true { question["kind"] = "text" }
            }
            return question
        }
        guard !id.isEmpty, id.utf8.count <= 512, let normalized,
              let data = try? JSONSerialization.data(withJSONObject: ["toolUseId": id, "questions": normalized, "isAsync": isAsync]),
              let prompt = try? JSONDecoder().decode(Self.self, from: data),
              (1...8).contains(prompt.questions.count),
              prompt.questions.allSatisfy({ !$0.question.isEmpty && $0.question.utf8.count <= 4_000
                  && ($0.isFreeText ? (0...12) : (1...12)).contains($0.options.count) && $0.options.allSatisfy({ !$0.label.isEmpty }) }) else { return nil }
        return prompt
    }

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

    /// Async Codex questions accept the same choice or typed response its
    /// terminal sends. The helper reconstructs the quoted message from the
    /// original transcript, then queues it to this exact conversation.
    public func answerBody(target: AgentChatTarget, answers: [AgentQuestionAnswer]) throws -> Data {
        guard isAsync == true else { return try answerBody(target: target, selections: answers.map(\.selections)) }
        guard isAnswered(answers) else { throw PhrenKitError.validation("Answer every question.") }
        return try JSONSerialization.data(withJSONObject: [
            "source": target.source, "sessionId": target.sessionID, "toolUseId": toolUseId,
            "answers": answers.map { ["optionIndexes": $0.selections, "text": $0.typed] as [String: Any] }
        ])
    }

    /// Claude Code reads `answers[question text]`: one label, the labels of a
    /// multiSelect, or any other string as a typed answer. The result is the
    /// request's own input with only `answers` added.
    public func answeredInput(_ original: [String: Any], answers: [AgentQuestionAnswer]) throws -> [String: Any] {
        guard answers.count == questions.count, Set(questions.map(\.question)).count == questions.count else {
            throw PhrenKitError.validation("Answer every question.")
        }
        var values: [String: Any] = [:]
        for (question, answer) in zip(questions, answers) { values[question.question] = try answer.value(for: question) }
        var input = original
        input["answers"] = values
        return input
    }
    public func isAnswered(_ answers: [AgentQuestionAnswer]) -> Bool { (try? answeredInput([:], answers: answers)) != nil }
}

/// What the person chose for one question: option indexes and/or typed text
/// ("Other…", or the whole answer for a free-text question).
public struct AgentQuestionAnswer: Equatable, Sendable {
    public var selections: [Int]
    public var text: String
    public init(selections: [Int] = [], text: String = "") { self.selections = selections; self.text = text }
    public var typed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    func value(for question: AgentQuestionPrompt.Question) throws -> Any {
        let typed = typed
        guard typed.utf8.count <= 4_000, selections.count == Set(selections).count,
              selections.allSatisfy({ question.options.indices.contains($0) }) else {
            throw PhrenKitError.validation("Choose an available answer for every question.")
        }
        let labels = selections.sorted().map { question.options[$0].label }
        if question.isFreeText {
            guard selections.isEmpty, !typed.isEmpty else { throw PhrenKitError.validation("Type an answer.") }
            return typed
        }
        if question.multiSelect == true {
            let all = labels + (typed.isEmpty ? [] : [typed])
            guard !all.isEmpty else { throw PhrenKitError.validation("Choose at least one answer.") }
            return all
        }
        switch (labels.first, typed.isEmpty) {
        case (let label?, true) where labels.count == 1: return label
        case (nil, false): return typed
        default: throw PhrenKitError.validation("Choose one answer.")
        }
    }
}

public enum AgentQuestionEvent: Equatable, Sendable {
    case question(AgentQuestionPrompt)
    case resolved(String)
    case reply(String)

    static func read(_ raw: [String: Any], source: String) -> [Self] {
        var blocks: [[String: Any]] = []
        if source == "codex", raw["type"] as? String == "response_item", let payload = raw["payload"] as? [String: Any] { blocks = [payload] }
        if source == "claude", raw["isMeta"] as? Bool != true, raw["isSidechain"] as? Bool != true,
           let message = raw["message"] as? [String: Any] { blocks = message["content"] as? [[String: Any]] ?? [] }
        return blocks.compactMap { block in
            let kind = block["type"] as? String ?? ""
            if source == "codex", kind == "message", block["role"] as? String == "user" {
                let text = (block["content"] as? [[String: Any]])?.compactMap { $0["text"] as? String }.joined(separator: "\n") ?? ""
                return text.isEmpty ? nil : .reply(text)
            }
            if ["function_call_output", "custom_tool_call_output", "tool_result"].contains(kind), let id = (block["call_id"] ?? block["tool_use_id"]) as? String {
                if let output = block["output"] as? String,
                   let object = try? JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any],
                   object["accepted"] as? Bool == true { return nil }
                return .resolved(id)
            }
            let name = (block["name"] as? String ?? "").replacingOccurrences(of: "functions.", with: "", options: .anchored)
            guard ["function_call", "tool_use"].contains(kind),
                  ["request_user_input", "request_user_input_async", "AskUserQuestion"].contains(name),
                  let id = (block["call_id"] ?? block["id"]) as? String, !id.isEmpty, id.utf8.count <= 512 else { return nil }
            var input = block["input"] as? [String: Any]
            if let arguments = block["arguments"] as? String { input = (try? JSONSerialization.jsonObject(with: Data(arguments.utf8))) as? [String: Any] }
            guard let prompt = AgentQuestionPrompt.read(id: id, questions: input?["questions"], isAsync: name == "request_user_input_async") else { return nil }
            return .question(prompt)
        }
    }
}


/// Keeps asynchronous questions visible across tool acknowledgements and final
/// replies. A terminal answer quotes the exact question in a later user turn.
public struct AgentQuestionState: Equatable, Sendable {
    public private(set) var pending: [AgentQuestionPrompt] = []
    private var answered: Set<String> = []
    public init() {}
    public mutating func resolve(_ id: String) {
        guard pending.contains(where: { $0.id == id }) else { return }
        pending.removeAll { $0.id == id }
        answered.insert(id)
    }
    public mutating func replaceAsync(_ prompts: [AgentQuestionPrompt]) {
        pending.removeAll { $0.isAsync == true }
        pending += prompts.filter { !answered.contains($0.id) }
    }
    public mutating func receive(_ events: [AgentQuestionEvent], reset: Bool = false) {
        if reset { pending.removeAll { $0.isAsync != true } }
        for event in events {
            switch event {
            case .question(let prompt):
                if !answered.contains(prompt.id), !pending.contains(where: { $0.id == prompt.id }) { pending.append(prompt) }
            case .resolved(let id): resolve(id)
            case .reply(let text):
                for prompt in pending where prompt.isAsync == true && prompt.questions.allSatisfy({ question in
                    let quote = question.question.components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n") + "\n\n"
                    guard let range = text.range(of: quote) else { return false }
                    return !text[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }) {
                    resolve(prompt.id)
                }
            }
        }
    }
}

public struct AgentRepositoryDiff: Decodable, Sendable {
    public struct File: Decodable, Sendable, Identifiable {
        public let path: String
        public let status: String
        public let sections: [Section]
        public var id: String { path }
        public init(path: String, status: String, sections: [Section]) { self.path = path; self.status = status; self.sections = sections }
    }
    public struct Section: Decodable, Sendable, Identifiable {
        public let id: String
        public let kind: String
        public let binary: Bool?
        public let loadState: String?
        public let patch: String?
        /// For a `committed` section: the commit's hash, subject and age.
        public let note: String?

        public init(id: String, kind: String, binary: Bool? = nil, loadState: String? = nil, patch: String? = nil, note: String? = nil) {
            self.id = id; self.kind = kind; self.binary = binary; self.loadState = loadState; self.patch = patch; self.note = note
        }
    }
    /// Another repository a command wrote into — the phren store, a sibling
    /// checkout — with the changes under the paths it named.
    public struct Related: Decodable, Sendable, Identifiable {
        public let root: String
        public let branch: String?
        public let files: [File]
        public var id: String { root }
    }
    public let branch: String?
    public let root: String
    public let launchPath: String
    public let files: [File]
    public let related: [Related]?
    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The repository diff is too large.") }
        let result = try JSONDecoder().decode(Self.self, from: data)
        let related = result.related ?? []
        guard result.root.hasPrefix("/"), result.launchPath.hasPrefix("/"), result.files.count <= 5_000,
              Set(result.files.map(\.path)).count == result.files.count, related.count <= 8,
              related.allSatisfy({ $0.root.hasPrefix("/") && $0.files.count <= 5_000 && Set($0.files.map(\.path)).count == $0.files.count })
        else { throw PhrenKitError.validation("The repository response is invalid.") }
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
