import Foundation

/// The one-line "what the agent is doing right now" for the working Live
/// Activity. Pure and bounded: the caller supplies the raw tool name, a short
/// human detail (a command or a file), and the status fallback. Nothing here
/// reads a transcript or touches the network.
public enum SessionActivityStep {
    public static let limit = 40

    /// The step text, or nil when there is neither a tool nor a status to show.
    public static func format(tool: String?, detail: String?, status: String?, limit: Int = limit) -> String? {
        let name = tool?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = firstLine(status)
        var value: String?
        if let name, !name.isEmpty {
            value = describe(tool: name, detail: firstLine(detail) ?? "")
        } else if let step = firstLine(detail), !step.isEmpty {
            // The Hook already phrased it ("Editing View.swift"); keep it.
            value = step
        }
        if value == nil, let fallback, !fallback.isEmpty { value = fallback }
        guard let value, !value.isEmpty else { return nil }
        return trim(value, to: limit)
    }

    private static func describe(tool: String, detail: String) -> String {
        switch tool.lowercased() {
        case "bash", "shell", "exec_command", "exec", "parallel", "tools", "write_stdin":
            return detail.isEmpty ? tool : "\(tool): \(detail)"
        case "edit", "multiedit", "write", "notebookedit", "patch", "apply_patch", "str_replace_editor", "str_replace":
            return "Editing \(fileName(detail) ?? "file")"
        case "read", "ls", "list":
            return "Reading \(fileName(detail) ?? "file")"
        case "grep", "glob", "search", "websearch", "browse":
            return detail.isEmpty ? tool : "Searching \(detail)"
        case "fetch", "webfetch":
            return detail.isEmpty ? tool : "Fetching \(detail)"
        case "task", "agent":
            return detail.isEmpty ? tool : "Delegating \(detail)"
        default:
            return detail.isEmpty ? tool : "\(tool): \(detail)"
        }
    }

    /// The first non-empty line, so a multi-line command or JSON input still
    /// reads as one step.
    private static func firstLine(_ text: String?) -> String? {
        guard let text else { return nil }
        for line in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    /// The last path component, dropping the " · note" a tool card appends.
    static func fileName(_ detail: String) -> String? {
        let path = detail.components(separatedBy: " · ").first ?? detail
        let name = path.split(separator: "/").last.map(String.init)?.trimmingCharacters(in: .whitespaces)
        return (name?.isEmpty == false) ? name : nil
    }

    static func trim(_ value: String, to limit: Int) -> String {
        guard limit > 1 else { return String(value.prefix(limit)) }
        return value.count > limit ? String(value.prefix(limit - 1)) + "…" : value
    }
}