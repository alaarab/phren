import Foundation

/// Parser + mutator for a project's FINDINGS.md.
///
/// Parsing transcribes `readFindings` (packages/cli/src/data/access.ts:276);
/// mutations transcribe `addFindingToFile` (content/learning.ts:298),
/// `editFinding` (access.ts:558), and `removeFinding` (access.ts:462).
/// Mutations are surgical line edits followed by the CLI's exact
/// normalization pass — nothing else is rewritten.
public struct FindingsFile: Sendable {
    public private(set) var content: String

    public init(content: String) {
        self.content = content
    }

    public static func empty(project: String) -> FindingsFile {
        FindingsFile(content: "")
    }

    // MARK: - Parse (access.ts:276 readFindings)

    public func parse(includeArchived: Bool = false) -> [Finding] {
        guard !content.isEmpty else { return [] }
        let lines = content.components(separatedBy: "\n")
        var items: [Finding] = []
        var date = "unknown"
        var index = 1
        var inArchiveBlock = false
        var headingTag: String?

        var i = 0
        while i < lines.count {
            defer { i += 1 }
            let line = lines[i]
            if isArchiveStart(line) { inArchiveBlock = true; continue }
            if isArchiveEnd(line) { inArchiveBlock = false; continue }
            if inArchiveBlock && !includeArchived { continue }

            if let extracted = Self.extractDateHeading(line) {
                date = extracted
                continue
            }

            // access.ts:315 — heading-based findings: ## topic / ### title / paragraph
            if let h2Tag = JSRegex(#"^##\s+([a-z_-]+)\s*$"#, caseInsensitive: true).group(line),
               !JSRegex(#"^##\s+\d{4}"#).test(line) {
                headingTag = h2Tag.lowercased()
                continue
            }
            if let h3Title = JSRegex(#"^###\s+(.+)$"#).group(line), let tag = headingTag {
                var body = ""
                var j = i + 1
                while j < lines.count {
                    let next = lines[j].jsTrimmed
                    j += 1
                    if next.isEmpty { continue }
                    if next.hasPrefix("#") || next.hasPrefix("- ") { break }
                    body = next
                    break
                }
                let title = h3Title.jsTrimmed
                let syntheticText = body.isEmpty ? "[\(tag)] \(title)" : "[\(tag)] \(title) — \(body)"
                items.append(Finding(
                    id: "L\(index)", stableId: nil, date: date, text: syntheticText,
                    citation: nil, citationData: nil, taskItem: nil, confidence: nil,
                    scope: nil, machine: nil, actor: nil, supersededBy: nil,
                    supersedes: nil, contradicts: nil, status: .active,
                    statusUpdated: nil, statusReason: nil, statusRef: nil,
                    archived: inArchiveBlock, typeTag: tag, rawLine: line,
                    journalFile: nil
                ))
                index += 1
                continue
            }

            guard line.hasPrefix("- ") else { continue }

            let next = i + 1 < lines.count ? lines[i + 1] : ""
            let citation = isCitationLine(next) ? next.jsTrimmed : nil
            let citationData = citation.flatMap(parseCitationComment)
            let provenance = parseSourceComment(line)
            let scope = parseScopeComment(line) ?? provenance?.scope
            let stableId = parseFindingId(line)
            let rawText = JSRegex(#"^-\s+"#).replaceFirst(line, with: "").jsTrimmed
            let textWithoutComments = stripComments(rawText)
            let confRegex = JSRegex(#"\s*\[confidence\s+([01](?:\.\d+)?)\]\s*$"#, caseInsensitive: true)
            var confidence: Double?
            var text = textWithoutComments
            if let m = confRegex.firstMatch(in: textWithoutComments),
               let whole = JSRegex.substring(textWithoutComments, m, 0),
               let value = JSRegex.substring(textWithoutComments, m, 1) {
                confidence = Double(value)
                text = String(textWithoutComments.dropLast(whole.count)).jsTrimmed
            }

            let supersededByRef = MetadataRegex.supersededBy.group(line)
            let supersedesRef = MetadataRegex.supersedes.group(line)
            let contradictsRefs = parseAllContradictions(line)
            let lifecycle = parseFindingLifecycle(line)
            let typeTag = JSRegex(#"^\[([a-z][a-z0-9_-]*)\]"#, caseInsensitive: true).group(text)?.lowercased()

            items.append(Finding(
                id: "L\(index)",
                stableId: stableId,
                date: date,
                text: text,
                citation: citation,
                citationData: citationData,
                taskItem: citationData?.taskItem,
                confidence: confidence,
                scope: scope,
                machine: provenance?.machine,
                actor: provenance?.actor,
                supersededBy: supersededByRef,
                supersedes: supersedesRef,
                contradicts: contradictsRefs.isEmpty ? nil : contradictsRefs,
                status: lifecycle.status,
                statusUpdated: lifecycle.statusUpdated,
                statusReason: lifecycle.statusReason,
                statusRef: lifecycle.statusRef,
                archived: inArchiveBlock,
                typeTag: typeTag,
                rawLine: line,
                journalFile: nil
            ))
            if citation != nil { i += 1 }
            index += 1
        }
        return items
    }

    /// The date of the last consolidation, from the `<!-- consolidated: … -->`
    /// stamp `autoArchiveToReference` writes into the file it just emptied
    /// (content/archive.ts:236). Matching is the CLI's own
    /// (content/validate.ts:56) — leading whitespace tolerated, trailing text
    /// ignored — so a marker either side reads the same date.
    ///
    /// This is what lets the app tell "this project has never been
    /// consolidated" from "everything older than N findings moved to the cold
    /// tier", using a file it already syncs and at no extra cost.
    public var consolidatedDate: String? {
        JSRegex(#"<!--\s*consolidated:\s*(\d{4}-\d{2}-\d{2})"#).group(content)
    }

    /// access.ts:164 `extractDateHeading`
    static func extractDateHeading(_ line: String) -> String? {
        guard let raw = JSRegex(#"^##\s+(.+)$"#).group(line)?.jsTrimmed else { return nil }
        if let direct = JSRegex(#"^(\d{4}-\d{2}-\d{2})$"#).group(raw) { return direct }
        if let archived = JSRegex(#"^Archived\s+(\d{4}-\d{2}-\d{2})$"#, caseInsensitive: true).group(raw) {
            return archived
        }
        return nil
    }

    // MARK: - Add (learning.ts:160 prepareFinding + 244 insertFindingIntoContent)

    public struct AddOptions: Sendable {
        public var type: FindingType?
        public var scope: String?
        public var provenance: FindingProvenance?
        public var now: Date

        public init(type: FindingType? = nil, scope: String? = nil,
                    provenance: FindingProvenance? = nil, now: Date = Date()) {
            self.type = type
            self.scope = scope
            self.provenance = provenance
            self.now = now
        }
    }

    /// Adds a finding, mirroring the CLI's bullet construction. Intentional MVP
    /// divergences from `addFindingToFile` (documented in apps/ios/README.md):
    /// no coref resolution, no auto type detection, no semantic (Jaccard)
    /// dedup — only exact normalized-text dedup — and no auto-archive cap.
    /// The CLI tidies all of these on its next run.
    @discardableResult
    public mutating func add(project: String, text: String, options: AddOptions = AddOptions()) throws -> String {
        let learning = text.jsTrimmed
        guard !learning.isEmpty else { throw PhrenKitError.emptyInput("Finding text cannot be empty.") }
        if let secret = SecretScanner.scan(learning) {
            throw PhrenKitError.secretDetected(
                "Rejected: finding appears to contain a secret (\(secret)). Strip credentials before saving."
            )
        }

        let nowIso = Self.isoTimestamp(options.now)
        let today = String(nowIso.prefix(10))

        var normalizedLearning = learning
        // core/finding.ts:16-28 `applyFindingTypePrefix`: the test is anchored
        // and accepts any bracketed tag. `extractFindingType` is unanchored, so a
        // `[bug]` mid-sentence suppressed the caller's type, and it knows only the
        // decay types, so `[tradeoff]`/`[architecture]` were tagged twice.
        if let type = options.type, !Self.findingTagPrefix.test(normalizedLearning) {
            normalizedLearning = "[\(type.rawValue)] \(normalizedLearning)"
        }

        let fid = Self.randomHexId()
        var bullet = normalizedLearning.hasPrefix("- ") ? normalizedLearning : "- \(normalizedLearning)"
        bullet += " <!-- fid:\(fid) --> <!-- created: \(today) -->"
        let scopeComment = buildScopeComment(options.scope)
        if !scopeComment.isEmpty { bullet += " \(scopeComment)" }
        if let provenance = options.provenance {
            let sourceComment = buildSourceComment(provenance)
            if !sourceComment.isEmpty { bullet += " \(sourceComment)" }
        }

        if isDuplicate(of: bullet) {
            throw PhrenKitError.duplicate(
                "Skipped duplicate finding for \"\(project)\": already exists with similar wording."
            )
        }

        bullet += " " + buildLifecycleComments(
            FindingLifecycleMetadata(status: .active, statusUpdated: today),
            fallbackDate: today
        )
        let citationComment = "  " + buildCitationComment(FindingCitation(createdAt: nowIso))

        if content.isEmpty {
            // learning.ts:349 — brand-new FINDINGS.md
            content = "# \(project) Findings\n\n## \(today)\n\n\(bullet)\n\(citationComment)\n"
        } else {
            content = Self.insertFindingIntoContent(content, today: today, bullet: bullet, citationComment: citationComment)
        }
        return fid
    }

    /// Exact-normalized-text duplicate check against existing bullets — the
    /// minimal port of `isDuplicateFinding` (dedup.ts:394).
    private func isDuplicate(of bullet: String) -> Bool {
        let needle = normalizeFindingText(bullet)
        guard !needle.isEmpty else { return false }
        return content.components(separatedBy: "\n")
            .filter { $0.hasPrefix("- ") }
            .contains { normalizeFindingText($0) == needle }
    }

    /// learning.ts:244 `insertFindingIntoContent` — positional insertion; the
    /// today-header search starts after the last `</details>` so archived
    /// blocks with a matching date are never reused.
    static func insertFindingIntoContent(_ content: String, today: String, bullet: String, citationComment: String) -> String {
        let todayHeader = "## \(today)"
        let searchFrom: String.Index
        if let lastDetailsClose = content.range(of: "</details>", options: .backwards) {
            searchFrom = lastDetailsClose.lowerBound
        } else {
            searchFrom = content.startIndex
        }
        if let headerRange = content.range(of: todayHeader, range: searchFrom..<content.endIndex) {
            let insertAt = headerRange.upperBound
            return String(content[..<insertAt]) + "\n\n\(bullet)\n\(citationComment)" + String(content[insertAt...])
        }
        if let m = JSRegex(multiline: #"^## \d{4}-\d{2}-\d{2}"#).firstMatch(in: content),
           let firstHeading = Range(m.range, in: content) {
            return String(content[..<firstHeading.lowerBound])
                + "\(todayHeader)\n\n\(bullet)\n\(citationComment)\n\n"
                + String(content[firstHeading.lowerBound...])
        }
        return trimEnd(content) + "\n\n## \(today)\n\n\(bullet)\n\(citationComment)\n"
    }

    // MARK: - Edit (access.ts:558 editFinding)

    public mutating func edit(project: String, oldText: String, newText: String) throws {
        let newTextTrimmed = newText.jsTrimmed
        guard !newTextTrimmed.isEmpty else { throw PhrenKitError.emptyInput("New finding text cannot be empty.") }

        var lines = content.components(separatedBy: "\n")
        let idx = try matchBullet(lines: lines, match: oldText, project: project)

        // access.ts:588 — preserve every metadata comment as a re-appended
        // suffix, and keep the [tag] prefix unless the new text supplies one.
        let existing = lines[idx]
        let metaComments = MetadataRegex.anyComment.allMatches(existing)
        let metaSuffix = metaComments.isEmpty ? "" : " " + metaComments.joined(separator: " ")
        let existingTag = JSRegex(#"^-\s*(\[[a-z][a-z0-9_-]*\])\s"#).group(existing)
        let newHasTag = JSRegex(#"^\[[a-z][a-z0-9_-]*\]"#).test(newTextTrimmed)
        let tagPrefix = (existingTag != nil && !newHasTag) ? "\(existingTag!) " : ""
        lines[idx] = "- \(tagPrefix)\(newTextTrimmed)\(metaSuffix)"
        content = Self.normalizeWrite(lines)
    }

    // MARK: - Remove (access.ts:462 removeFinding)

    @discardableResult
    public mutating func remove(project: String, match: String) throws -> String {
        var lines = content.components(separatedBy: "\n")
        let idx = try matchBullet(lines: lines, match: match, project: project)

        let removeCount = (idx + 1 < lines.count && isCitationLine(lines[idx + 1])) ? 2 : 1
        let matched = lines[idx]
        lines.removeSubrange(idx..<(idx + removeCount))
        content = Self.normalizeWrite(lines)
        return matched
    }

    // MARK: - Matching (access.ts:184-248)

    private struct BulletLine {
        let line: String
        let i: Int
        let archived: Bool
    }

    private func collectBulletLines(_ lines: [String]) -> [BulletLine] {
        var bullets: [BulletLine] = []
        var inArchiveBlock = false
        for (i, line) in lines.enumerated() {
            if isArchiveStart(line) { inArchiveBlock = true; continue }
            if isArchiveEnd(line) { inArchiveBlock = false; continue }
            guard line.hasPrefix("- ") else { continue }
            bullets.append(BulletLine(line: line, i: i, archived: inArchiveBlock))
        }
        return bullets
    }

    /// access.ts:204 `bulletContentKey`
    private func bulletContentKey(_ line: String) -> String {
        MetadataRegex.anyComment.replaceAll(line, with: " ").collapsedWhitespace.jsTrimmed
    }

    /// access.ts:214 `resolveDuplicateMatches`
    private func resolveDuplicateMatches(_ matches: [BulletLine]) -> BulletLine? {
        guard let first = matches.first else { return nil }
        let key = bulletContentKey(first.line)
        return matches.allSatisfy { bulletContentKey($0.line) == key } ? first : nil
    }

    /// access.ts:219 `findMatchingFindingBullet` + the archived-check wrapper
    /// shared by editFinding/removeFinding.
    private func matchBullet(lines: [String], match: String, project: String) throws -> Int {
        let needle = normalizeFindingText(match)
        let bullets = collectBulletLines(lines)
        let active = bullets.filter { !$0.archived }
        let archived = bullets.filter { $0.archived }

        switch matchIn(active, needle: needle, match: match) {
        case .found(let idx):
            return idx
        case .ambiguous(let error):
            throw PhrenKitError.ambiguousMatch(error)
        case .notFound:
            switch matchIn(archived, needle: needle, match: match) {
            case .found, .ambiguous:
                throw PhrenKitError.archivedReadOnly(
                    "Finding \"\(match)\" is archived and read-only. Restore or re-add it before mutating history."
                )
            case .notFound:
                throw PhrenKitError.notFound("No finding matching \"\(match)\" in project \"\(project)\".")
            }
        }
    }

    private enum MatchResult {
        case found(Int)
        case ambiguous(String)
        case notFound
    }

    private func matchIn(_ bullets: [BulletLine], needle: String, match: String) -> MatchResult {
        let fidNeedle = needle.hasPrefix("fid:") ? String(needle.dropFirst(4)) : needle
        if JSRegex(#"^[a-z0-9]{8}$"#).test(fidNeedle) {
            let fidRegex = JSRegex("<!--\\s*fid:\(fidNeedle)\\s*-->")
            let fidMatches = bullets.filter { fidRegex.test($0.line) }
            if fidMatches.count == 1 { return .found(fidMatches[0].i) }
        }

        let exact = bullets.filter { normalizeFindingText($0.line) == needle }
        if exact.count == 1 { return .found(exact[0].i) }
        if exact.count > 1 {
            if let dup = resolveDuplicateMatches(exact) { return .found(dup.i) }
            return .ambiguous("\"\(match)\" is ambiguous (\(exact.count) exact matches). Use a more specific phrase.")
        }

        let partial = bullets.filter { normalizeFindingText($0.line).contains(needle) }
        if partial.count == 1 { return .found(partial[0].i) }
        if partial.count > 1 {
            if let dup = resolveDuplicateMatches(partial) { return .found(dup.i) }
            return .ambiguous("\"\(match)\" is ambiguous (\(partial.count) partial matches). Use a more specific phrase.")
        }
        return .notFound
    }

    // MARK: - Shared write normalization

    /// The CLI's exact post-write pass (access.ts:493 and equivalents):
    /// `lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"`.
    static func normalizeWrite(_ lines: [String]) -> String {
        normalizeContent(lines.joined(separator: "\n"))
    }

    static func normalizeContent(_ joined: String) -> String {
        trimEnd(JSRegex(#"\n{3,}"#).replaceAll(joined, with: "\n\n")) + "\n"
    }

    /// core/finding.ts:16 `FINDING_TAG_PREFIX_RE`.
    static let findingTagPrefix = JSRegex(#"^\s*\[[^\]]+\]\s*"#)

    static func randomHexId() -> String {
        // crypto.randomBytes(4).toString("hex")
        (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    static func isoTimestamp(_ date: Date) -> String {
        // new Date().toISOString(): yyyy-MM-dd'T'HH:mm:ss.SSS'Z'
        PhrenDateFormats.utc("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").string(from: date)
    }
}

/// JS `String.prototype.trimEnd()`.
func trimEnd(_ s: String) -> String {
    var view = Substring(s)
    while let last = view.last, last.isWhitespace || last.isNewline {
        view = view.dropLast()
    }
    return String(view)
}
