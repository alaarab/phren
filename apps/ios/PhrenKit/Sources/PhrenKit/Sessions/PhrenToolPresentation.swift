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
        (name ?? "").split(separator: ".").last?.hasPrefix("mcp__phren__") == true
    }

    public init?(name: String, input: String, result: String? = nil, isError: Bool = false) {
        guard Self.recognizes(name) else { return nil }
        let tool = String(name.split(separator: ".").last!.dropFirst("mcp__phren__".count))
        let values = Self.object(input) as? [String: Any] ?? [:]
        let response = result.map { Self.unwrap(Self.object($0) ?? $0) }
        let envelope = response as? [String: Any] ?? [:]
        let data = envelope["data"] as? [String: Any] ?? envelope
        func value(_ names: String...) -> String {
            names.compactMap { values[$0].map { Self.plain($0) } }.first(where: { !$0.isEmpty }) ?? ""
        }
        let failed = isError || envelope["ok"] as? Bool == false || envelope["isError"] as? Bool == true
        status = result == nil ? .running : failed ? .failed : .succeeded
        project = Self.nonempty(value("project"))
        tag = tool == "add_finding" ? Self.nonempty(value("findingType", "finding_type")) : nil
        var details: [Field] = []
        let action = value("action").lowercased()
        switch tool {
        case "add_finding": verb = "Saved a finding"; body = value("finding", "text", "content")
        case "add_task": verb = "Added a task"; body = value("task", "item", "text")
        case "complete_task": verb = "Completed a task"; body = value("item", "task", "id")
        case "manage_task":
            verb = ["complete", "done", "finish"].contains(action) ? "Completed a task"
                : ["remove", "delete"].contains(action) ? "Removed a task" : "Updated a task"
            body = value("item", "task", "id", "text")
            if !action.isEmpty { details.append(.init(name: "Action", value: action)) }
        case "search_knowledge": verb = "Recalled memories"; body = value("query", "q")
        case "get_memory_detail": verb = "Read a memory"; body = value("id", "memoryId", "memory_id")
        case "get_tasks": verb = "Read tasks"; body = value("status", "filter")
        case "get_project_summary": verb = "Project summary"; body = ""
        case "session":
            verb = ["end", "stop"].contains(action) ? "Session ended" : action == "start" ? "Session started" : "Session status"
            body = value("summary", "message", "name")
        case "phren_admin": verb = action.isEmpty ? "Phren admin" : "Admin: \(action)"; body = value("message", "value", "setting")
        case "revise_finding": verb = "Revised a finding"; body = value("newText", "new_text", "text", "finding", "content")
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
        if value is NSNull { return "—" }
        if let array = value as? [Any] { return array.prefix(8).map { plain($0, depth: depth + 1) }.joined(separator: ", ") }
        if let dict = value as? [String: Any] {
            return dict.keys.sorted().prefix(8).map { "\($0): \(plain(dict[$0]!, depth: depth + 1))" }.joined(separator: " · ")
        }
        return String(describing: value)
    }
}
