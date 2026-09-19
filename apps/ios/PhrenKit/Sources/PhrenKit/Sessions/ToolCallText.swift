import Foundation

/// Bounded, display-only decoding shared by the tool cards (web, skill, MCP).
/// Nothing here evaluates arguments; the raw text always stays on the
/// message for the full reader.
enum ToolCallText {
    static func object(_ text: String) -> Any? {
        guard text.utf8.count <= 524_288 else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed)
    }

    /// The tool's own answer out of the transport envelopes: a JSON string
    /// that is itself JSON, MCP's `{"content":[{"type":"text","text":…}]}`
    /// (with `structuredContent` preferred when present), and a bare list
    /// of text blocks. `isError` envelopes are kept so the caller can read
    /// the flag.
    static func unwrap(_ value: Any, depth: Int = 0) -> Any {
        guard depth < 5 else { return value }
        if let text = value as? String, let parsed = object(text) { return unwrap(parsed, depth: depth + 1) }
        if let dict = value as? [String: Any] {
            if dict["isError"] as? Bool == true { return dict }
            if let structured = dict["structuredContent"] { return unwrap(structured, depth: depth + 1) }
            if let content = dict["content"], dict.count <= 2 { return unwrap(content, depth: depth + 1) }
        }
        if let blocks = value as? [[String: Any]], !blocks.isEmpty,
           blocks.allSatisfy({ $0["text"] is String && ($0["type"] == nil || ["text", "input_text", "output_text"].contains($0["type"] as? String ?? "")) }) {
            let text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n\n")
            return blocks.count == 1 ? unwrap(text, depth: depth + 1) : text
        }
        return value
    }

    /// The text a result reads as: strings as they are, everything else as
    /// pretty-printed JSON — the reader's copy, never a summary.
    static func text(_ value: Any) -> String {
        if let text = value as? String { return text }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) {
            return String(decoding: data, as: UTF8.self)
        }
        return String(describing: value)
    }

    /// A scalar as it reads on a card; containers as their size, never their
    /// braces. `depth` lets a caller show one level of a nested object.
    static func plain(_ value: Any, depth: Int = 0, limit: Int = 200) -> String {
        if let text = value as? String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.count > limit ? String(trimmed.prefix(limit)) + "…" : trimmed
        }
        if value is NSNull { return "—" }
        if let number = value as? NSNumber {
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "true" : "false") : number.stringValue
        }
        if let array = value as? [Any] { return array.count == 1 ? "1 item" : "\(array.count) items" }
        if let dict = value as? [String: Any] {
            guard depth > 0 else { return dict.count == 1 ? "{1 field}" : "{\(dict.count) fields}" }
            return orderedKeys(dict).prefix(6).map { "\($0): \(plain(dict[$0]!, depth: depth - 1, limit: 60))" }.joined(separator: " · ")
        }
        return String(describing: value)
    }

    /// The keys a person looks for first, then the rest alphabetically —
    /// JSON decoding forgets the author's order, and alphabetical alone puts
    /// `active_lock_reason` above `title`.
    private static let preferredKeys = ["title", "name", "summary", "message", "query", "url", "path", "state", "status", "number", "id", "count", "total", "description", "body"]
    static func orderedKeys(_ dict: [String: Any]) -> [String] {
        let preferred = preferredKeys.filter { dict[$0] != nil }
        return preferred + dict.keys.filter { !preferred.contains($0) }.sorted()
    }

    /// `_`, `-` and camelCase seams become spaces; the first word is
    /// capitalized, the rest lowercased unless they read as an acronym.
    static func sentence(_ identifier: String) -> String {
        let spaced = identifier.replacingOccurrences(of: #"([a-z0-9])([A-Z])"#, with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        let words = spaced.split(whereSeparator: \.isWhitespace).map(String.init)
        return words.enumerated().map { index, word in
            if word.count >= 2, word == word.uppercased(), word.rangeOfCharacter(from: .letters) != nil { return word }
            return index == 0 ? word.prefix(1).uppercased() + word.dropFirst().lowercased() : word.lowercased()
        }.joined(separator: " ")
    }

    /// The first `count` lines, each bounded, and whether anything was left out.
    static func firstLines(_ text: String, count: Int, characters: Int = 200) -> (lines: [String], truncated: Bool) {
        var lines: [String] = [], truncated = false
        for line in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            if lines.count == count { truncated = true; break }
            if line.count > characters { lines.append(String(line.prefix(characters)) + "…"); truncated = true }
            else { lines.append(String(line)) }
        }
        return (lines, truncated)
    }
}
