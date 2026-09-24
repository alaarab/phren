import Foundation

/// The agent's own bookkeeping calls — a subagent it delegated to, the todo
/// list it keeps, the plan it wants reviewed — read from a call's input and
/// result for a card of their own. Bounded previews; nothing is evaluated,
/// and the raw call stays on the message for the full reader.
enum AgentToolCardJSON {
    static func object(_ text: String) -> Any? {
        guard text.utf8.count <= 524_288 else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed)
    }
    /// The tool's own name: `functions.Task` → `Task`.
    static func tool(_ name: String?) -> String {
        (name ?? "").split(separator: ".").last.map(String.init) ?? ""
    }
    static func string(_ value: Any?, limit: Int = 1_200) -> String {
        guard let text = value as? String else { return "" }
        return String(text.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /// A result as its text: a plain string, a `content` list of text blocks,
    /// or an envelope's `output` / `result` / `content` string.
    static func resultText(_ result: String, depth: Int = 0) -> String {
        guard depth < 4, let value = object(result) else { return result }
        if let text = value as? String { return resultText(text, depth: depth + 1) }
        if let blocks = value as? [[String: Any]], blocks.allSatisfy({ $0["text"] is String }) {
            return blocks.compactMap { $0["text"] as? String }.joined(separator: "\n\n")
        }
        if let dict = value as? [String: Any] {
            for key in ["output", "result", "content", "text"] {
                if let text = dict[key] as? String { return resultText(text, depth: depth + 1) }
                if let blocks = dict[key] as? [[String: Any]], blocks.allSatisfy({ $0["text"] is String }) {
                    return blocks.compactMap { $0["text"] as? String }.joined(separator: "\n\n")
                }
            }
        }
        return result
    }
    static func tag(_ name: String, in text: String) -> String? {
        guard let open = text.range(of: "<\(name)>"), let close = text.range(of: "</\(name)>", range: open.upperBound..<text.endIndex) else { return nil }
        return String(text[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A subagent: Claude Code's `Task` / `Agent` tool, Codex's `spawn_agent`.
/// Running until its report — or, for a background agent, its task
/// notification — arrives.
public struct AgentSubagentPresentation: Equatable, Sendable {
    public enum State: String, Sendable { case running, done, failed }
    /// The agent's name, or its type when it was not named.
    public let name: String
    /// The one-line description the caller gave it.
    public let description: String
    public let model: String?
    public let prompt: String
    public let promptAvailable: Bool
    public let background: Bool
    /// The agent's report, bounded for the card; "" until it is back.
    public let report: String
    /// A background agent's completion line from its task notification.
    public let summary: String?
    public let state: State

    public static func recognizes(_ name: String?) -> Bool {
        ["task", "agent", "spawn_agent"].contains(AgentToolCardJSON.tool(name).lowercased())
    }

    /// `notification`: the `<task-notification>` block Claude Code wrote when
    /// a background agent finished, matched to this call by tool-use id.
    public init?(name: String, input: String, result: String? = nil, isError: Bool = false, notification: String? = nil) {
        guard Self.recognizes(name) else { return nil }
        let values = AgentToolCardJSON.object(input) as? [String: Any] ?? [:]
        func value(_ keys: String...) -> String {
            keys.map { AgentToolCardJSON.string(values[$0]) }.first(where: { !$0.isEmpty }) ?? ""
        }
        let rawPrompt = (values["prompt"] ?? values["message"] ?? values["task"] ?? values["input"]) as? String ?? ""
        promptAvailable = !Self.looksEncrypted(rawPrompt)
        self.prompt = promptAvailable ? String(rawPrompt.prefix(20_000)) : ""
        let taskName = value("task_name")
        let typed = value("name", "subagent_type", "agent_type", "role")
        self.name = taskName.isEmpty ? (typed.isEmpty ? "Agent" : typed) : Self.displayName(taskName)
        let described = value("description")
        description = described.isEmpty
            ? String(self.prompt.split(whereSeparator: \.isNewline).first?.prefix(140) ?? "").trimmingCharacters(in: .whitespaces)
            : String(described.prefix(140))
        let model = value("model")
        self.model = model.isEmpty ? nil : model
        let text = result.map { AgentToolCardJSON.resultText($0) } ?? ""
        // A background launch answers at once and only says the agent started;
        // the report never comes through the call, the notification does.
        let spawnAcknowledgement = AgentToolCardJSON.tool(name) == "spawn_agent"
            && (AgentToolCardJSON.object(text) as? [String: Any])?["task_name"] != nil
        let launched = text.lowercased().hasPrefix("async agent launched") || (text.contains("agentId:") && text.contains("output_file")) || spawnAcknowledgement
        background = values["run_in_background"] as? Bool == true || launched
        let status = notification.flatMap { AgentToolCardJSON.tag("status", in: $0) }?.lowercased()
        summary = notification.flatMap { AgentToolCardJSON.tag("summary", in: $0) }.flatMap { $0.isEmpty ? nil : String($0.prefix(500)) }
        if isError || ["failed", "killed", "cancelled", "canceled", "stopped", "error"].contains(status ?? "") {
            state = .failed
        } else if status != nil || (result != nil && !launched) {
            state = .done
        } else {
            state = .running
        }
        report = launched ? "" : Self.trimmed(text)
    }

    private static func looksEncrypted(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count > 80, value.hasPrefix("gAAAAA") else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_="))
        return value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private static func displayName(_ path: String) -> String {
        let leaf = path.split(separator: "/").last.map(String.init) ?? path
        let words = leaf.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return words.split(whereSeparator: \.isWhitespace).map { $0.prefix(1).uppercased() + String($0.dropFirst()) }.joined(separator: " ")
    }

    /// The report without Claude Code's trailing bookkeeping: the `<usage>`
    /// block and the "agentId: … (for resuming)" line.
    static func trimmed(_ text: String) -> String {
        var report = text
        if let open = report.range(of: "<usage>"), report.range(of: "</usage>", range: open.upperBound..<report.endIndex) != nil {
            report = String(report[..<open.lowerBound])
        }
        var lines = report.components(separatedBy: "\n")
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty || last.hasPrefix("agentId:") { lines.removeLast() }
        return String(lines.joined(separator: "\n").prefix(12_000)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A checklist the agent keeps: Claude Code's `TodoWrite` (the whole list
/// each call) and `TaskCreate` / `TaskUpdate` / `TaskList`, Codex's
/// `update_plan`.
public struct AgentTodoPresentation: Equatable, Sendable {
    public struct Item: Equatable, Sendable {
        public enum Status: String, Sendable { case pending, active, done }
        public let text: String
        public let status: Status
        /// Claude's present-tense form ("Adding the card"), for the active item.
        public let activeForm: String?
        public init(text: String, status: Status, activeForm: String? = nil) {
            self.text = text; self.status = status; self.activeForm = activeForm
        }
    }
    /// "Todos", "Plan" or "Tasks" — the family a later snapshot replaces.
    public let title: String
    public let items: [Item]
    /// A whole-list snapshot: a later one with the same title supersedes it.
    /// A single task's create or update never does.
    public let isSnapshot: Bool
    /// Codex's explanation, a task's description, or an unstructured listing.
    public let note: String?
    public var doneCount: Int { items.filter { $0.status == .done }.count }
    public var summary: String { "\(doneCount) of \(items.count) done" }

    public static func recognizes(_ name: String?) -> Bool {
        ["todowrite", "taskcreate", "taskupdate", "tasklist", "update_plan"].contains(AgentToolCardJSON.tool(name).lowercased())
    }

    public init?(name: String, input: String, result: String? = nil) {
        guard Self.recognizes(name) else { return nil }
        let tool = AgentToolCardJSON.tool(name).lowercased()
        let values = AgentToolCardJSON.object(input) as? [String: Any] ?? [:]
        var items: [Item] = [], note: String?
        switch tool {
        case "todowrite":
            title = "Todos"; isSnapshot = true
            items = Self.items(values["todos"], text: "content")
        case "update_plan":
            title = "Plan"; isSnapshot = true
            items = Self.items(values["plan"], text: "step")
            note = Self.nonempty(AgentToolCardJSON.string(values["explanation"], limit: 400))
        case "taskcreate":
            title = "Tasks"; isSnapshot = false
            let subject = AgentToolCardJSON.string(values["subject"], limit: 300)
            if !subject.isEmpty { items = [Item(text: subject, status: .pending, activeForm: Self.nonempty(AgentToolCardJSON.string(values["activeForm"], limit: 300)))] }
            note = Self.nonempty(AgentToolCardJSON.string(values["description"], limit: 400))
        case "taskupdate":
            title = "Tasks"; isSnapshot = false
            let subject = AgentToolCardJSON.string(values["subject"], limit: 300)
            let id = AgentToolCardJSON.string(values["taskId"] ?? values["id"] ?? values["task_id"], limit: 40)
            let text = subject.isEmpty ? (id.isEmpty ? "" : "Task #\(id)") : subject
            if !text.isEmpty { items = [Item(text: text, status: Self.status(values["status"]))] }
        default: // TaskList: the list is in the result.
            title = "Tasks"; isSnapshot = true
            let text = result.map { AgentToolCardJSON.resultText($0) } ?? ""
            if let listed = AgentToolCardJSON.object(text) {
                items = Self.items(listed, text: "subject")
                if items.isEmpty, let envelope = listed as? [String: Any] { items = Self.items(envelope["tasks"], text: "subject") }
            }
            if items.isEmpty { items = Self.checklistLines(text) }
            if items.isEmpty { note = Self.nonempty(String(text.components(separatedBy: "\n").prefix(6).joined(separator: "\n").prefix(600)).trimmingCharacters(in: .whitespacesAndNewlines)) }
        }
        guard !items.isEmpty || note != nil else { return nil }
        self.items = Array(items.prefix(40)); self.note = note
    }

    /// Which snapshots, in timeline order, a later snapshot of the same
    /// family has replaced — computed once for the whole timeline.
    public static func superseded(_ cards: [AgentTodoPresentation?]) -> [Bool] {
        var seen: Set<String> = [], flags = Array(repeating: false, count: cards.count)
        for index in cards.indices.reversed() {
            guard let card = cards[index], card.isSnapshot else { continue }
            if seen.contains(card.title) { flags[index] = true } else { seen.insert(card.title) }
        }
        return flags
    }

    private static func items(_ value: Any?, text key: String) -> [Item] {
        (value as? [[String: Any]] ?? []).compactMap { entry in
            let text = AgentToolCardJSON.string(entry[key] ?? entry["content"] ?? entry["step"] ?? entry["subject"] ?? entry["text"], limit: 300)
            guard !text.isEmpty else { return nil }
            return Item(text: text, status: status(entry["status"]), activeForm: nonempty(AgentToolCardJSON.string(entry["activeForm"], limit: 300)))
        }
    }
    private static func status(_ value: Any?) -> Item.Status {
        switch AgentToolCardJSON.string(value, limit: 40).lowercased() {
        case "completed", "complete", "done", "resolved", "closed": return .done
        case "in_progress", "in-progress", "active", "doing", "started", "running": return .active
        default: return .pending
        }
    }
    /// `- [ ] step`, `- [x] step`, `- [~] step` lines, as a text listing reads.
    private static let checklistLine = try! NSRegularExpression(pattern: #"^(?:[-*]\s*)?\[([ xX~>-])\]\s+(.+)$"#)
    private static func checklistLines(_ text: String) -> [Item] {
        text.split(whereSeparator: \.isNewline).prefix(200).compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let match = checklistLine.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
                  let mark = Range(match.range(at: 1), in: trimmed), let body = Range(match.range(at: 2), in: trimmed) else { return nil }
            let text = String(trimmed[body].prefix(300)).trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return nil }
            let glyph = trimmed[mark]
            return Item(text: text, status: ["x", "X"].contains(glyph) ? .done : ["~", ">"].contains(glyph) ? .active : .pending)
        }
    }
    private static func nonempty(_ value: String) -> String? { value.isEmpty ? nil : value }
}

/// Claude Code's plan review: `ExitPlanMode` carries the plan as markdown,
/// answered through a permission request (approve to build, deny to keep
/// planning). `EnterPlanMode` is only a mode change.
public struct AgentPlanPresentation: Equatable, Sendable {
    public enum State: String, Sendable { case pending, approved, rejected }
    public let plan: String
    public let state: State

    public static func recognizes(_ name: String?) -> Bool { AgentToolCardJSON.tool(name).lowercased() == "exitplanmode" }
    public static func isPlanMode(_ name: String?) -> Bool { AgentToolCardJSON.tool(name).lowercased() == "enterplanmode" }

    public init?(name: String, input: String, result: String? = nil, isError: Bool = false) {
        guard Self.recognizes(name) else { return nil }
        plan = Self.plan(input)
        guard let result else { state = .pending; return }
        let text = AgentToolCardJSON.resultText(result).lowercased()
        state = isError || text.contains("rejected") || text.contains("doesn't want") || text.contains("denied") ? .rejected : .approved
    }
    /// From a pending permission request's message: the tool input as JSON.
    public init?(approvalInput message: String) {
        guard message.utf8.count <= 524_288, let values = AgentToolCardJSON.object(message) as? [String: Any],
              let plan = values["plan"] as? String, !plan.isEmpty else { return nil }
        self.plan = String(plan.prefix(40_000)).trimmingCharacters(in: .whitespacesAndNewlines)
        state = .pending
    }
    private static func plan(_ input: String) -> String {
        let values = AgentToolCardJSON.object(input) as? [String: Any] ?? [:]
        let plan = values["plan"] as? String ?? ""
        return String(plan.prefix(40_000)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public extension AgentApproval {
    /// Claude Code asks for plan review through a permission request for
    /// `ExitPlanMode`; the phone shows the plan and answers approve or deny.
    var isPlan: Bool { toolName == "ExitPlanMode" }
    var plan: AgentPlanPresentation? {
        guard isPlan, let message else { return nil }
        return AgentPlanPresentation(approvalInput: message)
    }
}
