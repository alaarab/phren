import Foundation

/// Parser + mutator for a project's review.md (the review queue).
///
/// Transcribes `readReviewQueue` / `parseQueueLine` / `approveQueueItem` /
/// `rejectQueueItem` / `editQueueItem` (packages/cli/src/data/access.ts:609-749)
/// and the queue text normalization from governance/policy.ts:706-741.
public struct ReviewFile: Sendable {
    public private(set) var content: String

    public init(content: String) {
        self.content = content
    }

    // MARK: - Queue text normalization (governance/policy.ts)

    /// policy.ts:19
    static let maxQueueEntryLength = 500

    /// policy.ts:710 `cleanQueueEntryText`
    static func cleanQueueEntryText(_ raw: String) -> String {
        var s = JSRegex(#"\r\n?"#).replaceAll(raw, with: "\n")
        s = s.replacingOccurrences(of: "\0", with: " ")
        // policy.ts uses /<!--[\s\S]*?-->/g (dot-matches-newline variant).
        s = JSRegex(#"<!--[\s\S]*?-->"#).replaceAll(s, with: " ")
        s = JSRegex(#"\\[nrt]"#).replaceAll(s, with: " ")
        s = s.replacingOccurrences(of: "\\\"", with: "\"")
        s = s.replacingOccurrences(of: "\\\\", with: "\\")
        s = JSRegex(#"\n+"#).replaceAll(s, with: " ")
        s = s.collapsedWhitespace
        return s.jsTrimmed
    }

    /// policy.ts:723 `normalizeQueueEntryText` with `{truncate: true}`.
    /// Lengths are measured in UTF-16 units to match JS `.length`/`.slice` —
    /// otherwise emoji shift the truncation boundary and break byte-identity.
    static func normalizeQueueEntryText(_ raw: String) -> String {
        let cleaned = cleanQueueEntryText(raw)
        if cleaned.utf16.count <= maxQueueEntryLength { return cleaned }
        let units = Array(cleaned.utf16.prefix(maxQueueEntryLength - 1))
        let sliced = String(utf16CodeUnits: units, count: units.count)
        return trimEnd(sliced) + "…"
    }

    // MARK: - Parse (access.ts:609 parseQueueLine, 631 readReviewQueue)

    struct ParsedQueueLine {
        var date: String?
        var text: String
        var confidence: Double?
        var machine: String?
        var model: String?
    }

    static func parseQueueLine(_ line: String) -> ParsedQueueLine {
        let dated = JSRegex(#"^- \[(\d{4}-\d{2}-\d{2})\]\s*(.+)$"#)
        var date: String?
        var rawText: String
        if let m = dated.firstMatch(in: line),
           let d = JSRegex.substring(line, m, 1),
           let t = JSRegex.substring(line, m, 2) {
            date = d
            rawText = t
        } else {
            rawText = JSRegex(#"^-\s+"#).replaceFirst(line, with: "").jsTrimmed
        }
        let confidence = JSRegex(#"\[confidence\s+([01](?:\.\d+)?)\]"#, caseInsensitive: true)
            .group(rawText).flatMap(Double.init)
        let source = parseSourceComment(line)
        let withoutConfidence = JSRegex(#"\s*\[confidence\s+[01](?:\.\d+)?\]"#, caseInsensitive: true)
            .replaceAll(rawText, with: "").jsTrimmed
        let text = normalizeQueueEntryText(withoutConfidence)
        return ParsedQueueLine(
            date: date, text: text, confidence: confidence,
            machine: source?.machine, model: source?.model
        )
    }

    public func parse() -> [QueueItem] {
        guard !content.isEmpty else { return [] }
        var items: [QueueItem] = []
        var section: QueueItem.Section = .review
        var index = 1

        for line in content.components(separatedBy: "\n") {
            let trimmed = line.jsTrimmed
            if let heading = JSRegex(#"^##\s+(.+?)[\s]*$"#, caseInsensitive: true).group(trimmed) {
                let token = heading.collapsedWhitespace.jsTrimmed.lowercased()
                if token == "review" { section = .review; continue }
                if token == "stale" { section = .stale; continue }
                if token == "conflicts" { section = .conflicts; continue }
            }
            guard line.hasPrefix("- ") else { continue }

            let parsed = Self.parseQueueLine(line)
            let risky = section != .review || (parsed.confidence.map { $0 < 0.7 } ?? false)
            items.append(QueueItem(
                id: "M\(index)",
                section: section,
                date: parsed.date ?? "unknown",
                text: parsed.text,
                line: line,
                confidence: parsed.confidence,
                risky: risky,
                machine: parsed.machine,
                model: parsed.model
            ))
            index += 1
        }
        return items
    }

    // MARK: - Line operations (access.ts:673-749)

    /// access.ts:674 `withQueueLineOp` — locate by trimmed-line equality.
    private func lineIndex(of lineText: String, in lines: [String]) throws -> Int {
        guard let idx = lines.firstIndex(where: { $0.jsTrimmed == lineText.jsTrimmed }) else {
            throw PhrenKitError.notFound("Queue item not found.")
        }
        return idx
    }

    /// Remove a queue line, touching nothing else.
    ///
    /// This is only the review.md half of approve or reject. Approve must also
    /// write the finding when it is not already there: `phren extract` queues
    /// every candidate below autoAcceptThreshold without writing it to
    /// FINDINGS.md, so for those the queue line is the only copy. SyncEngine
    /// composes this with `FindingsFile` (see `computeEdits`).
    public mutating func dequeue(lineText: String) throws {
        var lines = content.components(separatedBy: "\n")
        let idx = try lineIndex(of: lineText, in: lines)
        lines.remove(at: idx)
        content = FindingsFile.normalizeWrite(lines)
    }

    /// The review.md half of `approveQueueItemDetailed` (access.ts).
    public mutating func approve(lineText: String) throws {
        try dequeue(lineText: lineText)
    }

    /// The review.md half of `rejectQueueItem` (access.ts:709). The caller
    /// composes this with `FindingsFile.remove` using `findingsTextFor(lineText:)`,
    /// tolerating a not-found finding exactly like the CLI does.
    public mutating func reject(lineText: String) throws {
        try dequeue(lineText: lineText)
    }

    /// Capture provenance recorded on the queue line, if any. A promoted
    /// finding carries where the observation came from, not the device that
    /// approved it, as `approveQueueItemDetailed` does.
    public static func capturedProvenanceFor(lineText: String) -> FindingProvenance? {
        parseSourceComment(lineText)
    }

    /// The date the item was queued, recorded on a promoted finding as
    /// `<!-- phren:queued "YYYY-MM-DD" -->`.
    public static func queuedDateFor(lineText: String) -> String? {
        parseQueueLine(lineText).date
    }

    /// The parsed queue text used as the FINDINGS.md match needle for
    /// reject/edit (`parseQueueLine(lineText).text` in access.ts:717,732).
    public static func findingsTextFor(lineText: String) -> String {
        parseQueueLine(lineText).text
    }

    /// The review.md half of `editQueueItem` (access.ts:728) — rewrites the
    /// line preserving the `- [date] ` prefix. Returns the new-text needle for
    /// the tolerant FINDINGS.md edit.
    @discardableResult
    public mutating func edit(lineText: String, newText: String) throws -> String {
        let trimmed = JSRegex(#"[\r\n]+"#).replaceAll(newText, with: " ").jsTrimmed
        guard !trimmed.isEmpty else { throw PhrenKitError.emptyInput("New text cannot be empty.") }

        var lines = content.components(separatedBy: "\n")
        let idx = try lineIndex(of: lineText, in: lines)
        if let date = JSRegex(#"^- \[(\d{4}-\d{2}-\d{2})\]\s*"#).group(lines[idx]) {
            lines[idx] = "- [\(date)] \(trimmed)"
        } else {
            lines[idx] = "- \(trimmed)"
        }
        content = FindingsFile.normalizeWrite(lines)
        return trimmed
    }
}
