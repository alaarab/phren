import Foundation

/// A call to any MCP server other than phren — `mcp__github__get_pull_request`
/// — as its card reads it: the server, the tool as a verb, the input as
/// key/value rows, and the result's first lines. Phren's own tools keep
/// `PhrenToolPresentation`; this is the generalized fallback for the rest.
public struct MCPToolPresentation: Equatable, Sendable {
    public enum Status: String, Sendable { case running, succeeded, failed }
    public struct Field: Equatable, Sendable {
        public let name: String
        public let value: String
    }
    /// The server, humanized: `github` → "GitHub", `claude_ai_Gmail` → "Claude Ai Gmail".
    public let server: String
    /// The tool, humanized: `get_pull_request` → "Get pull request".
    public let verb: String
    /// The input, one row per key: scalars as text, objects as "{n fields}",
    /// arrays as "n items". At most `maximumFields`; the rest are counted.
    public let fields: [Field]
    public let hiddenFields: Int
    /// The result's first lines: an object as `key: value` lines (no braces
    /// at the top level), an array as its size and first items, text as it is.
    public let resultLines: [String]
    public let resultTruncated: Bool
    public let status: Status

    static let maximumFields = 8
    static let maximumResultLines = 6
    private static let knownServers = ["github": "GitHub", "gitlab": "GitLab", "openai": "OpenAI", "youtube": "YouTube", "linkedin": "LinkedIn"]

    /// `mcp__<server>__<tool>` from any provider, except phren's own.
    public static func recognizes(_ name: String?) -> Bool {
        parts(name) != nil
    }
    private static func parts(_ name: String?) -> (server: String, tool: String)? {
        let tool = String((name ?? "").split(separator: ".").last ?? "")
        let components = tool.components(separatedBy: "__")
        guard components.count >= 3, components[0] == "mcp", !components[1].isEmpty, components[1] != "phren",
              !components[2...].joined().isEmpty else { return nil }
        return (components[1], components.dropFirst(2).joined(separator: "_"))
    }

    public init?(name: String, input: String, result: String? = nil, isError: Bool = false) {
        guard let parts = Self.parts(name) else { return nil }
        server = Self.serverName(parts.server)
        verb = ToolCallText.sentence(parts.tool)
        // A malformed input never replaces the raw reader with invented rows.
        let values = ToolCallText.object(input) as? [String: Any] ?? [:]
        let keys = ToolCallText.orderedKeys(values)
        fields = keys.prefix(Self.maximumFields).map {
            Field(name: $0.replacingOccurrences(of: "_", with: " "), value: ToolCallText.plain(values[$0]!))
        }
        hiddenFields = max(0, keys.count - Self.maximumFields)
        let unwrapped = result.map { ToolCallText.unwrap($0) }
        let envelope = unwrapped as? [String: Any] ?? [:]
        let failed = isError || envelope["isError"] as? Bool == true || envelope["ok"] as? Bool == false
        status = result == nil ? .running : failed ? .failed : .succeeded
        guard let unwrapped else { resultLines = []; resultTruncated = false; return }
        if failed {
            // The error message, wherever the envelope keeps it.
            let message = envelope["error"] ?? envelope["message"] ?? (envelope["content"].map { ToolCallText.unwrap($0) }) ?? unwrapped
            let (lines, truncated) = ToolCallText.firstLines(ToolCallText.text(message), count: Self.maximumResultLines)
            resultLines = lines.isEmpty ? ["Call failed"] : lines; resultTruncated = truncated
        } else if let dict = unwrapped as? [String: Any] {
            let data = dict["data"] as? [String: Any] ?? dict
            let keys = ToolCallText.orderedKeys(data)
            resultLines = keys.prefix(Self.maximumResultLines).map { "\($0): \(ToolCallText.plain(data[$0]!, depth: 1, limit: 160))" }
            resultTruncated = keys.count > Self.maximumResultLines
        } else if let array = unwrapped as? [Any] {
            let shown = array.prefix(Self.maximumResultLines - 1).map { "· " + ToolCallText.plain($0, depth: 1, limit: 160) }
            resultLines = [ToolCallText.plain(array)] + shown
            resultTruncated = array.count > shown.count
        } else {
            let (lines, truncated) = ToolCallText.firstLines(ToolCallText.text(unwrapped), count: Self.maximumResultLines)
            resultLines = lines.filter { !$0.isEmpty }.isEmpty ? [] : lines; resultTruncated = truncated
        }
    }

    static func serverName(_ raw: String) -> String {
        if let known = knownServers[raw.lowercased()] { return known }
        return raw.split { $0 == "_" || $0 == "-" }.map { word -> String in
            word == word.lowercased() ? word.prefix(1).uppercased() + word.dropFirst() : String(word)
        }.joined(separator: " ")
    }
}
