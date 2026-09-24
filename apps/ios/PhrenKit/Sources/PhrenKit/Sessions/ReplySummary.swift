import Foundation

/// The deterministic half of a spoken reply summary: an agent's markdown reply
/// reduced to its first one or two plain sentences. It is what Siri, the Live
/// Activity and notifications use when the on-device model is unavailable,
/// and the floor the model's answer is checked against.
public enum ReplySummary {
    /// Room for two short spoken sentences.
    public static let defaultLimit = 220

    /// The first sentences of `reply` as plain text, at most `limit`
    /// characters, never cut inside a word. Code blocks, tables, headings'
    /// marks, list bullets, emphasis and link targets are dropped; nil when
    /// nothing readable remains.
    public static func fallback(_ reply: String, limit: Int = defaultLimit) -> String? {
        let text = plainText(reply)
        guard !text.isEmpty else { return nil }
        var picked: [String] = []
        for sentence in sentences(text) {
            let candidate = (picked + [sentence]).joined(separator: " ")
            if candidate.count <= limit { picked.append(sentence) } else { break }
            if picked.count == 2 { break }
        }
        if !picked.isEmpty { return picked.joined(separator: " ") }
        return clipped(text, to: limit)
    }

    /// Whether a reply is long or structured enough to be worth summarizing
    /// before it is spoken; a short plain line is read as it is.
    public static func needsSummary(_ reply: String, limit: Int = defaultLimit) -> Bool {
        let plain = plainText(reply)
        return plain.count > limit || sentences(plain).count > 2 || reply.contains("```")
    }

    /// Markdown flattened to one line of prose.
    public static func plainText(_ markdown: String) -> String {
        var lines: [String] = []
        var inFence = false
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") { inFence.toggle(); continue }
            if inFence || line.isEmpty { continue }
            // Tables and rules carry no sentence to speak.
            if line.hasPrefix("|") || line.allSatisfy({ "-=*_|: ".contains($0) }) { continue }
            var stripped = line
            stripped = stripped.replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression)
            stripped = stripped.replacingOccurrences(of: #"^>\s*"#, with: "", options: .regularExpression)
            stripped = stripped.replacingOccurrences(of: #"^([-*+]|\d+[.)])\s+"#, with: "", options: .regularExpression)
            stripped = stripped.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            stripped = stripped.replacingOccurrences(of: #"(\*\*|__|~~)"#, with: "", options: .regularExpression)
            stripped = stripped.replacingOccurrences(of: #"(?<![\w*])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?![\w*])"#, with: "$1", options: .regularExpression)
            stripped = stripped.replacingOccurrences(of: "`", with: "")
            // A line without closing punctuation ends its own sentence, so a
            // bullet list does not run together into one.
            if let last = stripped.last, !".!?:;".contains(last) { stripped += "." }
            lines.append(stripped)
        }
        return lines.joined(separator: " ")
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    static func sentences(_ text: String) -> [String] {
        var result: [String] = []
        var current = ""
        let characters = Array(text)
        for (index, character) in characters.enumerated() {
            current.append(character)
            guard ".!?".contains(character) else { continue }
            let next = index + 1 < characters.count ? characters[index + 1] : " "
            // "v1.2", "e.g." inside a word, or a path's dot is not an end.
            guard next == " " else { continue }
            let sentence = current.trimmingCharacters(in: .whitespaces)
            if !sentence.isEmpty { result.append(sentence) }
            current = ""
        }
        let rest = current.trimmingCharacters(in: .whitespaces)
        if !rest.isEmpty { result.append(rest) }
        return result
    }

    static func clipped(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        let prefix = String(text.prefix(limit))
        let cut = prefix.lastIndex(of: " ").map { String(prefix[..<$0]) } ?? prefix
        return cut.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:-")) + "…"
    }
}
