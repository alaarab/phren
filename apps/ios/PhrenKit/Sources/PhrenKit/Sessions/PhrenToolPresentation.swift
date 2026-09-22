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
        let failed = isError || envelope["ok"] as? Bool == false || envelope["isError"] as? Bool == true
        status = result == nil ? .running : failed ? .failed : .succeeded
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
            summary = Self.nonempty(Self.plain(envelope["error"] ?? envelope["message"] ?? "Call failed"))
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
    }

    /// The full-output view of a phren call: MCP's `content` text blocks and
    /// the JSON string phren returns inside them, unwrapped and pretty-printed
    /// so a recalled memory reads as text rather than an escaped blob. Text
    /// that is not JSON comes back untouched.
    public static func readable(_ text: String) -> String {
        guard let parsed = object(text) else { return text }
        let value = unwrap(parsed)
        if let string = value as? String { return string }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let pretty = String(data: data, encoding: .utf8) else { return text }
        // phren's `message` is the human line; put it first, then the data.
        if let dict = value as? [String: Any], let message = dict["message"] as? String, !message.isEmpty {
            return message + "\n\n" + pretty
        }
        return pretty
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
