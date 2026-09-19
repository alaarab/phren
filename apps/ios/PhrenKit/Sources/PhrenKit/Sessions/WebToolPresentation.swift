import Foundation

/// A web fetch or search as the chat card reads it: where the agent went
/// (or what it asked), the prompt it fetched with, and the first lines of
/// what came back as Markdown. The whole result stays for "Read all".
public struct WebToolPresentation: Equatable, Sendable {
    public enum Kind: Sendable { case fetch, search }
    public enum Status: String, Sendable { case running, succeeded, failed }
    public let kind: Kind
    /// The card's name for the call: "Fetch" or "Search".
    public var title: String { kind == .fetch ? "Fetch" : "Search" }
    /// The fetched address as the agent gave it.
    public let url: String?
    /// The query as the agent gave it.
    public let query: String?
    /// What the collapsed card says: the host and path of the address —
    /// `developer.apple.com/documentation/swiftui` — or the query in quotes.
    public let location: String
    /// The instruction a fetch was made with; nil for searches.
    public let prompt: String?
    /// The result's first lines as Markdown. Claude Code's search result
    /// carries its sources as a `Links: [{title,url},…]` JSON line; that line
    /// becomes one bullet per link so the sources read (and tap) as links.
    public let resultMarkdown: String?
    public let resultTruncated: Bool
    /// The whole result, for the full reader.
    public let result: String?
    public let status: Status

    public static let previewLines = 12
    private static let fetchNames: Set<String> = ["webfetch", "web_fetch", "fetch_url", "fetch_webpage", "fetch_page"]
    private static let searchNames: Set<String> = ["websearch", "web_search"]

    static func kind(_ name: String?) -> Kind? {
        let tool = String((name ?? "").split(separator: ".").last ?? "").lowercased()
        return fetchNames.contains(tool) ? .fetch : searchNames.contains(tool) ? .search : nil
    }
    public static func recognizes(_ name: String?) -> Bool { kind(name) != nil }

    public init?(name: String, input: String, result: String? = nil, isError: Bool = false) {
        guard let kind = Self.kind(name) else { return nil }
        self.kind = kind
        let values = ToolCallText.object(input) as? [String: Any] ?? [:]
        func value(_ names: String...) -> String? {
            names.compactMap { values[$0] as? String }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first(where: { !$0.isEmpty })
        }
        url = kind == .fetch ? value("url", "uri", "link") : nil
        query = kind == .search ? value("query", "q", "search") : nil
        prompt = kind == .fetch ? value("prompt", "instructions", "question") : nil
        // A malformed input keeps the raw text as the location rather than
        // inventing an address; the full reader still has everything.
        let fallback = String(input.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        switch kind {
        case .fetch: location = url.map(Self.location) ?? fallback
        case .search: location = query.map { "“\($0)”" } ?? fallback
        }
        let unwrapped = result.map { ToolCallText.unwrap($0) }
        let failed = isError || (unwrapped as? [String: Any])?["isError"] as? Bool == true
        status = result == nil ? .running : failed ? .failed : .succeeded
        let text = unwrapped.map { ToolCallText.text($0) }
        self.result = text
        if let text {
            let (lines, truncated) = ToolCallText.firstLines(Self.linksAsMarkdown(text), count: Self.previewLines, characters: 400)
            let joined = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            resultMarkdown = joined.isEmpty ? nil : joined
            resultTruncated = truncated
        } else { resultMarkdown = nil; resultTruncated = false }
    }

    /// Host and path, without scheme, query, fragment or a trailing slash.
    static func location(_ url: String) -> String {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed), let host = components.host, !host.isEmpty else {
            return String(trimmed.prefix(200))
        }
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        return String((host + path).prefix(200))
    }

    /// `Links: [{"title":…,"url":…},…]` → one `• [title](url)` per link.
    static func linksAsMarkdown(_ text: String) -> String {
        guard text.contains("Links: [") else { return text }
        return text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map { line -> String in
            guard line.hasPrefix("Links: ["), let start = line.firstIndex(of: "["),
                  let links = ToolCallText.object(String(line[start...])) as? [[String: Any]], !links.isEmpty else { return String(line) }
            return links.prefix(8).compactMap { link -> String? in
                guard let url = link["url"] as? String, !url.isEmpty else { return nil }
                let title = (link["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? url
                return "• [\(Self.escaped(title))](\(url))"
            }.joined(separator: "\n")
        }.joined(separator: "\n")
    }
    private static func escaped(_ title: String) -> String {
        title.replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
    }
}
