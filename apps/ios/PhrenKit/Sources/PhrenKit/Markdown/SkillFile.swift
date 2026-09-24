import Foundation

/// A skill file in the store: `global/skills/<name>/SKILL.md`,
/// `global/skills/<name>.md`, `<project>/skills/<name>/SKILL.md`, or
/// `<project>/skills/<name>.md`.
///
/// Transcribed from `collectSkills` (packages/cli/src/skill/registry.ts:79-124)
/// and `parseSkillFrontmatter` (packages/cli/src/link/skills.ts:39).
///
/// Unlike findings/tasks/notes, a skill is edited as a *whole file* — the CLI
/// treats the markdown body as opaque authored prose, so there is no line
/// grammar to preserve and round-tripping is byte-identical by construction.
public struct SkillFile: Equatable, Sendable {
    /// Verbatim file contents. The serializer is the identity function.
    public var content: String

    public init(content: String) {
        self.content = content
    }

    /// `parseSkillFrontmatter` (link/skills.ts:39): strip BOM, normalize CRLF,
    /// then match a leading `---\n…\n---\n` block. A malformed block is not an
    /// error — the whole file is treated as body, matching the TS `catch`.
    public static func parseFrontmatter(_ rawContent: String) -> (frontmatter: [String: String]?, body: String) {
        var text = rawContent
        if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        text = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")

        guard text.hasPrefix("---\n") else { return (nil, text) }
        let afterOpen = text.index(text.startIndex, offsetBy: 4)
        guard let closeRange = text.range(of: "\n---\n", range: afterOpen..<text.endIndex)
            ?? text.range(of: "\n---", options: .backwards, range: afterOpen..<text.endIndex) else {
            return (nil, text)
        }
        let yaml = String(text[afterOpen..<closeRange.lowerBound])
        let body = String(text[closeRange.upperBound...])
        let parsed = parseScalarYAML(yaml)
        return (parsed.isEmpty ? nil : parsed, body)
    }

    /// Minimal YAML reader for the flat `key: value` frontmatter phren's own
    /// skills use. Nested structures (`hooks:`, `dependencies:`) are skipped
    /// rather than misparsed — the app only ever *reads* `name`/`description`
    /// and writes the file back verbatim, so an unsupported shape costs a
    /// display nicety, never data.
    static func parseScalarYAML(_ yaml: String) -> [String: String] {
        var result: [String: String] = [:]
        for rawLine in yaml.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            // Skip comments, list items, and continuation/nested lines.
            guard !line.hasPrefix("#"), !line.hasPrefix(" "), !line.hasPrefix("\t"),
                  !line.hasPrefix("-"), let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
            var value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty, !value.isEmpty else { continue }
            if (value.hasPrefix("\"") && value.hasSuffix("\"") && value.count >= 2)
                || (value.hasPrefix("'") && value.hasSuffix("'") && value.count >= 2) {
                let singleQuoted = value.hasPrefix("'")
                value = String(value.dropFirst().dropLast())
                if singleQuoted { value = value.replacingOccurrences(of: "''", with: "'") }
            }
            result[key] = value
        }
        return result
    }

    /// `REQUIRED_SKILL_FIELDS` (link/skills.ts:37) — a skill must carry a
    /// non-empty `name` and `description`. Returned as messages rather than
    /// thrown so the editor can warn without blocking a work-in-progress save.
    public static func frontmatterWarnings(for content: String) -> [String] {
        let (frontmatter, _) = parseFrontmatter(content)
        guard let frontmatter else { return ["missing or invalid YAML frontmatter"] }
        return ["name", "description"].compactMap { field in
            let value = frontmatter[field]?.trimmingCharacters(in: .whitespaces) ?? ""
            return value.isEmpty ? "missing required field \"\(field)\"" : nil
        }
    }

    /// Starter body for a newly created skill, matching the shape `phren link`
    /// validates.
    public static func template(name: String) -> String {
        """
        ---
        name: \(name)
        description:
        ---

        # \(name)

        """
    }

    public static func template(name: String, description: String, instructions: String) -> String {
        let summary = description.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\r\n", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "'", with: "''")
        return "---\nname: \(name)\ndescription: '\(summary)'\n---\n\n\(instructions)\n"
    }
}
