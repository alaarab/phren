import Foundation

/// A bounded, human-readable preview. Raw input/output stays on the message
/// for the full reader; malformed or future tools still have useful fields.
public struct PhrenToolPresentation: Equatable, Sendable {
    public enum Status: String, Sendable { case running, succeeded, failed }
    public struct Field: Equatable, Sendable {
        public let name: String
        public let value: String
    }
    public let verb: String
    public let project: String?
    public let body: String
    public let tag: String?
    public let fields: [Field]
    public let resultSummary: String?
    public let titles: [String]
    public let status: Status
    /// Full content is separate from the bounded preview used by folded cards.
    public let fullInput: String
    public let fullOutput: String?
    public let rawResult: String?
    /// A failed call's own validation lines ("updates: expected object…").
    public let issues: [String]
    public let target: Target?
    public let searchResults: [SearchResult]

    public struct SearchResult: Equatable, Sendable {
        public let title: String
        public let text: String
        public let source: String?
    }

    public struct Target: Equatable, Sendable {
        public enum Kind: Sendable { case task, finding, search }
        public let kind: Kind
        public let store: String?
        public let project: String?
        public let stableID: String?
        public let text: String?
    }

    public static func recognizes(_ name: String?) -> Bool {
        bareTool(name) != nil
    }

    /// The tool after phren's own prefix: Claude Code sends
    /// `mcp__phren__add_task`; OpenCode names its MCP servers `phren_add_task`.
    static func bareTool(_ name: String?) -> String? {
        guard let tool = (name ?? "").split(separator: ".").last.map(String.init) else { return nil }
        if tool.hasPrefix("mcp__phren__") { return String(tool.dropFirst("mcp__phren__".count)) }
        if tool.hasPrefix("phren_") { return String(tool.dropFirst("phren_".count)) }
        return nil
    }

    public init?(name: String, input: String, result: String? = nil, isError: Bool = false) {
        guard let tool = Self.bareTool(name) else { return nil }
        let values = Self.object(input) as? [String: Any] ?? [:]
        let response = result.map { Self.unwrap(Self.object($0) ?? $0) }
        let envelope = response as? [String: Any] ?? [:]
        let data = envelope["data"] as? [String: Any] ?? envelope
        func value(_ names: String...) -> String {
            names.compactMap { values[$0].map { Self.plain($0) } }.first(where: { !$0.isEmpty }) ?? ""
        }
        let failure = result.flatMap { Self.failure(Self.object($0) ?? $0) }
        let failed = isError || failure != nil
        status = failed ? .failed : result == nil ? .running : .succeeded
        fullInput = values.isEmpty ? Self.readable(input) : values.keys.sorted().map {
            let raw = values[$0]!
            let text = (raw as? String) ?? Self.render(raw)
            return $0.replacingOccurrences(of: "_", with: " ").capitalized + "\n" + text
        }.joined(separator: "\n\n")
        fullOutput = result.map(Self.readable)
        rawResult = result
        project = Self.nonempty(tool == "get_project_summary" ? value("project", "name") : value("project"))
        tag = tool == "add_finding" ? Self.nonempty(value("findingType", "finding_type")) : nil
        var details: [Field] = []
        let action = value("action").lowercased()
        switch tool {
        case "add_finding": verb = "Save finding"; body = value("finding", "text", "content")
        case "add_task": verb = "Add task"; body = value("task", "item", "text")
        case "complete_task": verb = "Completed a task"; body = value("item", "task", "id")
        case "manage_task":
            verb = "Update task"
            body = value("item", "task", "id", "text")
            if !action.isEmpty { details.append(.init(name: "Action", value: action)) }
        case "search_knowledge": verb = "Search memory"; body = value("query", "q")
        case "get_memory_detail": verb = "Read a memory"; body = value("id", "memoryId", "memory_id")
        case "get_tasks": verb = "Read tasks"; body = value("status", "filter")
        case "get_project_summary": verb = "Read project"; body = ""
        case "session":
            verb = "Session"
            body = value("summary", "message", "name")
        case "phren_admin": verb = action.isEmpty ? "Phren admin" : action; body = value("message", "value", "setting")
        case "revise_finding": verb = "Revise finding"; body = value("newText", "new_text", "text", "finding", "content")
        case "set_topic_summary": verb = "Saved a topic summary"; body = value("summary", "text", "content")
        default:
            verb = tool.replacingOccurrences(of: "_", with: " ").capitalized
            body = ""
            details = values.keys.sorted().filter { $0 != "project" }.prefix(8).map {
                Field(name: $0.replacingOccurrences(of: "_", with: " "), value: Self.plain(values[$0]!))
            }
        }
        // A malformed input never replaces the raw reader with invented data.
        fields = details
        var summary: String?, resultTitles: [String] = []
        if failed {
            summary = Self.nonempty(Self.firstLine(failure ?? result.map(Self.readable) ?? "")) ?? "Call failed"
        } else if tool == "search_knowledge", result != nil {
            let hits = data["results"] as? [Any] ?? data["hits"] as? [Any] ?? response as? [Any]
            if let hits {
                let count = data["count"] as? Int ?? data["total"] as? Int ?? hits.count
                summary = "\(count) \(count == 1 ? "memory" : "memories") found"
                resultTitles = hits.prefix(3).compactMap { hit in
                    if let item = hit as? [String: Any] {
                        return Self.nonempty(Self.firstLine(item["title"] ?? item["snippet"] ?? item["filename"] ?? item["text"] ?? ""))
                    }
                    return Self.nonempty(Self.firstLine(hit))
                }
            }
        } else if tool == "get_memory_detail", result != nil {
            summary = Self.nonempty(Self.firstLine(data["title"] ?? data["content"] ?? data["text"] ?? envelope["message"] ?? response ?? ""))
        }
        resultSummary = summary; titles = resultTitles
        issues = failed ? (envelope["issues"] as? [[String: Any]] ?? []).prefix(6).compactMap { issue in
            guard let message = issue["message"] as? String, !message.isEmpty else { return nil }
            let path = Self.plain(issue["path"] ?? "")
            return path.isEmpty ? message : "\(path): \(message)"
        } : []
        searchResults = tool == "search_knowledge" ? (data["results"] as? [Any] ?? data["hits"] as? [Any] ?? response as? [Any] ?? []).map { hit in
            guard let item = hit as? [String: Any] else { return SearchResult(title: "", text: Self.render(hit), source: nil) }
            let title = item["title"] as? String ?? ""
            let text = (item["content"] ?? item["text"] ?? item["snippet"]) as? String ?? ""
            let source = [item["project"] as? String, item["filename"] as? String].compactMap { $0 }.joined(separator: " · ")
            return SearchResult(title: title, text: text.isEmpty && title.isEmpty ? Self.render(item) : text,
                                source: source.isEmpty ? nil : source)
        } : []
        func string(_ object: [String: Any], _ keys: [String]) -> String? {
            keys.compactMap { object[$0] as? String }.first { !$0.isEmpty }
        }
        let store = string(values, ["store", "storeId", "storeID"]) ?? string(data, ["store", "storeId", "storeID"])
        let targetProject = project ?? string(data, ["project"])
        let kind: Target.Kind?
        switch tool {
        case "add_task", "manage_task", "complete_task", "update_task", "get_task": kind = .task
        case "add_finding", "revise_finding", "edit_finding", "get_memory_detail": kind = .finding
        case "search_knowledge": kind = .search
        default: kind = nil
        }
        if let kind, status == .succeeded, !["remove", "delete"].contains(action) {
            let record = (data["task"] ?? data["finding"] ?? data["item"]) as? [String: Any] ?? data
            let id = string(record, ["stableId", "stable_id", "taskId", "findingId", "id"])
                ?? string(values, ["finding_id", "findingId", "id", "memoryId", "memory_id"])
            let updates = values["updates"] as? [String: Any] ?? [:]
            let text = kind == .task ? (string(updates, ["text"]) ?? string(values, ["item", "task", "text"]))
                : string(values, ["new_text", "newText", "text", "finding", "content"])
            target = Target(kind: kind, store: store, project: targetProject, stableID: id, text: text)
        } else { target = nil }
    }

    /// Inspect result envelopes, never arbitrary data rows such as a recalled
    /// finding about an error. MCP may put the failure in any text block.
    private static func failure(_ value: Any, depth: Int = 0) -> String? {
        guard depth < 8 else { return nil }
        if let text = value as? String {
            if let parsed = object(text) { return failure(parsed, depth: depth + 1) }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.range(of: #"^(?:Error:|Tool error:|Error calling tool|MCP error)"#, options: [.regularExpression, .caseInsensitive]) != nil ? trimmed : nil
        }
        if let blocks = value as? [Any] {
            return blocks.lazy.compactMap { failure($0, depth: depth + 1) }.first
        }
        guard let dict = value as? [String: Any] else { return nil }
        if let data = dict["data"] as? [String: Any], let errors = data["errors"] as? [String], !errors.isEmpty {
            return errors.joined(separator: "; ")
        }
        let marked = dict["ok"] as? Bool == false || dict["success"] as? Bool == false
            || dict["isError"] as? Bool == true || dict["is_error"] as? Bool == true
            || ["failed", "error"].contains(dict["status"] as? String ?? "")
            || (dict["error"] != nil && !(dict["error"] is NSNull) && dict["ok"] as? Bool != true)
        for key in ["structuredContent", "content", "result", "text"] {
            if let nested = dict[key], let reason = failure(nested, depth: depth + 1) { return reason }
        }
        guard marked else { return nil }
        if let error = dict["error"] as? [String: Any], let message = error["message"] as? String { return message }
        for key in ["error", "message", "detail", "content"] {
            if let text = dict[key] as? String, !text.isEmpty { return readable(text) }
        }
        if let blocks = dict["content"] as? [[String: Any]] {
            let text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
            if !text.isEmpty { return readable(text) }
        }
        return "Call failed"
    }

    /// The full-output view of a phren call: MCP's `content` text blocks and
    /// the JSON string phren returns inside them, unwrapped and pretty-printed
    /// so a recalled memory reads as text rather than an escaped blob. Text
    /// that is not JSON comes back untouched.
    public static func readable(_ text: String) -> String {
        readable(text, depth: 0)
    }
    private static func readable(_ text: String, depth: Int) -> String {
        guard depth < 8 else { return text }
        guard let parsed = object(text) else { return text }
        // Show every text block, even when the envelope itself marks failure.
        if let dict = parsed as? [String: Any], dict["ok"] == nil, dict["data"] == nil,
           let blocks = dict["content"] as? [[String: Any]], !blocks.isEmpty {
            return blocks.compactMap { $0["text"] as? String }.map { readable($0, depth: depth + 1) }.joined(separator: "\n\n")
        }
        if let blocks = parsed as? [[String: Any]], !blocks.isEmpty,
           blocks.allSatisfy({ $0["type"] as? String == "text" }) {
            return blocks.compactMap { $0["text"] as? String }.map { readable($0, depth: depth + 1) }.joined(separator: "\n\n")
        }
        let value = unwrap(parsed)
        if let string = value as? String { return string }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let pretty = String(data: data, encoding: .utf8) else { return text }
        // phren's `message` is the human text; its data repeats it as JSON.
        if let dict = value as? [String: Any], let message = dict["message"] as? String, !message.isEmpty {
            return message
        }
        return pretty
    }
    private static func render(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]) else {
            return String(describing: value)
        }
        return String(decoding: data, as: UTF8.self)
    }
    private static func object(_ text: String) -> Any? {
        guard text.utf8.count <= 524_288 else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed)
    }
    private static func unwrap(_ value: Any, depth: Int = 0) -> Any {
        guard depth < 5 else { return value }
        if let text = value as? String, let parsed = object(text) { return unwrap(parsed, depth: depth + 1) }
        if let dict = value as? [String: Any] {
            // Retain ok/error metadata when this already is a phren response.
            if dict["ok"] != nil || dict["data"] != nil || dict["isError"] as? Bool == true { return dict }
            if let structured = dict["structuredContent"] { return unwrap(structured, depth: depth + 1) }
            if let content = dict["content"] { return unwrap(content, depth: depth + 1) }
        }
        if let blocks = value as? [[String: Any]], let first = blocks.first,
           first["type"] as? String == "text", let text = first["text"] as? String {
            return unwrap(text, depth: depth + 1)
        }
        return value
    }
    private static func nonempty(_ value: String) -> String? { value.isEmpty ? nil : value }
    private static func firstLine(_ value: Any) -> String {
        String(plain(value).split(whereSeparator: \.isNewline).first?.prefix(180) ?? "")
    }
    private static func plain(_ value: Any, depth: Int = 0) -> String {
        guard depth < 4 else { return "…" }
        if let text = value as? String { return String(text.prefix(1_200)).trimmingCharacters(in: .whitespacesAndNewlines) }
        if value is NSNull { return "-" }
        if let array = value as? [Any] { return array.prefix(8).map { plain($0, depth: depth + 1) }.joined(separator: ", ") }
        if let dict = value as? [String: Any] {
            return dict.keys.sorted().prefix(8).map { "\($0): \(plain(dict[$0]!, depth: depth + 1))" }.joined(separator: " · ")
        }
        return String(describing: value)
    }
}
