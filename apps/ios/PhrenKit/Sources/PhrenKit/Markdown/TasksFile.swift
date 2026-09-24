import Foundation

/// Parser + renderer for a project's tasks.md.
///
/// Transcribes packages/cli/src/data/tasks.ts. Like notes files, the CLI fully
/// re-renders tasks.md on every mutation (`renderTask`, tasks.ts:332), so
/// whole-file re-serialization matches CLI behavior. Legacy files get
/// reordered into canonical Active/Queue/Done section order on first write —
/// same as the CLI.
public struct TasksFile: Sendable {
    public private(set) var doc: TaskDoc

    // tasks.ts:18-20 — heading aliases
    static let activeHeadings: Set<String> = ["active", "in progress", "in-progress", "current", "wip"]
    static let queueHeadings: Set<String> = ["queue", "queued", "task", "todo", "upcoming", "next"]
    static let doneHeadings: Set<String> = ["done", "completed", "finished", "archived"]

    // tasks.ts:166 METADATA_PATTERN
    static let metadataPattern = JSRegex(
        #"\s*<!--\s*bid:([a-z0-9]{8})(?:\s+rank:(\d+))?(?:\s+lastActivity:([^\s>]+))?(?:\s+created:([^\s>]+))?(?:\s+session:([^\s>]+))?(?:\s+scope:([^\s>]+))?(?:\s+findings:((?:[a-z0-9]{8}(?::[a-z0-9]{8})?|fid:[a-z0-9]{8})(?:,[a-z0-9a-z:]{3,})*))?(?:\s+parentFinding:([^\s>]+))?(\s+speculative)?\s*-->"#
    )

    public init(project: String, content: String?) {
        if let content {
            self.doc = Self.parseTaskContent(project: project, content: content)
        } else {
            self.doc = TaskDoc(project: project, title: "# \(project) tasks", active: [], queue: [], done: [])
        }
    }

    // MARK: - Parse (tasks.ts:260 parseTaskContent)

    static func parseTaskContent(project: String, content: String) -> TaskDoc {
        let lines = content.components(separatedBy: "\n")
        let title = lines.first?.jsTrimmed.isEmpty == false ? lines[0].jsTrimmed : "# \(project) tasks"
        var items: [PhrenTask.Section: [PhrenTask]] = [.active: [], .queue: [], .done: []]

        var section: PhrenTask.Section = .queue
        var counters: [PhrenTask.Section: Int] = [.active: 0, .queue: 0, .done: 0]
        var i = 0
        while i < lines.count {
            defer { i += 1 }
            let line = lines[i]
            if let heading = JSRegex(#"^##\s+(.+?)[\s]*$"#).group(line.jsTrimmed) {
                let token = heading.collapsedWhitespace.jsTrimmed.lowercased()
                if activeHeadings.contains(token) { section = .active }
                else if queueHeadings.contains(token) { section = .queue }
                else if doneHeadings.contains(token) { section = .done }
                continue
            }
            guard line.hasPrefix("- ") else { continue }

            let (checked, body) = stripBulletPrefix(line)
            let meta = stripBid(body)
            let pinned = detectPinned(meta.clean)
            let priority = normalizePriority(meta.clean)
            let continuation = parseContinuation(lines: lines, idx: i)
            let sectionPrefix = section == .active ? "A" : section == .queue ? "Q" : "D"
            counters[section]! += 1
            items[section]!.append(PhrenTask(
                id: "\(sectionPrefix)\(counters[section]!)",
                stableId: meta.bid,
                section: section,
                line: meta.clean,
                checked: checked || section == .done,
                priority: priority,
                context: continuation.context,
                pinned: pinned ? true : nil,
                githubIssue: continuation.githubIssue,
                githubUrl: continuation.githubUrl,
                rank: meta.rank,
                lastActivity: meta.lastActivity,
                createdAt: meta.createdAt,
                sessionId: meta.sessionId,
                scope: meta.scope,
                childFindings: meta.childFindings,
                speculative: meta.speculative,
                parentFinding: meta.parentFinding
            ))
            i += continuation.linesToSkip
        }

        // tasks.ts:319 — assign ranks to rank-less items
        for section in [PhrenTask.Section.active, .queue, .done] {
            assignMissingRanks(&items[section]!)
        }

        return TaskDoc(
            project: project, title: title,
            active: items[.active]!, queue: items[.queue]!, done: items[.done]!
        )
    }

    /// tasks.ts:86 `stripBulletPrefix`
    static func stripBulletPrefix(_ line: String) -> (checked: Bool, body: String) {
        let checked = JSRegex(#"^-\s*\[[xX]\]\s+"#).test(line)
        var body = JSRegex(#"^-\s*\[[ xX]\]\s+"#).replaceFirst(line, with: "")
        body = JSRegex(#"^-\s+"#).replaceFirst(body, with: "")
        return (checked, body.jsTrimmed)
    }

    struct BidMetadata {
        var clean: String
        var bid: String?
        var rank: Int?
        var lastActivity: String?
        var createdAt: String?
        var sessionId: String?
        var scope: String?
        var childFindings: [String]?
        var parentFinding: String?
        var speculative: Bool?
    }

    /// tasks.ts:174 `stripBid`
    static func stripBid(_ text: String) -> BidMetadata {
        guard let m = metadataPattern.firstMatch(in: text) else {
            return BidMetadata(clean: text)
        }
        func g(_ i: Int) -> String? { JSRegex.substring(text, m, i) }
        let childFindings = g(7)?.split(separator: ",").map(String.init).filter { !$0.isEmpty }
        return BidMetadata(
            clean: trimEnd(metadataPattern.replaceFirst(text, with: "")),
            bid: g(1),
            rank: g(2).flatMap(Int.init),
            lastActivity: g(3).flatMap { $0.isEmpty ? nil : $0 },
            createdAt: g(4).flatMap { $0.isEmpty ? nil : $0 },
            sessionId: g(5).flatMap { $0.isEmpty ? nil : $0 },
            scope: g(6).flatMap { $0.isEmpty ? nil : $0 },
            childFindings: (childFindings?.isEmpty == false) ? childFindings : nil,
            parentFinding: g(8).flatMap { $0.isEmpty ? nil : $0 },
            speculative: g(9) != nil ? true : nil
        )
    }

    /// tasks.ts:59 `normalizePriority`
    static func normalizePriority(_ text: String) -> PhrenTask.Priority? {
        let withoutPinned = JSRegex(#"\s*\[pinned\]"#, caseInsensitive: true).replaceAll(text, with: "")
        guard let raw = JSRegex(#"\[(high|medium|low)\]\s*$"#, caseInsensitive: true).group(withoutPinned) else {
            return nil
        }
        return PhrenTask.Priority(rawValue: raw.lowercased())
    }

    /// tasks.ts:65 `stripPriorityTag` — strips ALL trailing priority tags.
    public static func stripPriorityTag(_ text: String) -> String {
        var text = text
        var prev: String
        repeat {
            prev = text
            text = JSRegex(#"\s*\[(high|medium|low)\](?=\s*(?:\[pinned\])?\s*$)"#, caseInsensitive: true)
                .replaceAll(text, with: "")
        } while text != prev
        return JSRegex(#"\s{2,}"#).replaceAll(text, with: " ").jsTrimmed
    }

    /// tasks.ts:78 `detectPinned`
    static func detectPinned(_ text: String) -> Bool {
        JSRegex(#"\[pinned\]"#, caseInsensitive: true).test(text)
    }

    /// tasks.ts:82 `stripPinnedTag`
    public static func stripPinnedTag(_ text: String) -> String {
        JSRegex(#"\s*\[pinned\]"#, caseInsensitive: true).replaceAll(text, with: "").jsTrimmed
    }

    /// tasks.ts:95 `parseGitHubIssueReference`
    static func parseGitHubIssueReference(_ raw: String) -> (issue: Int?, url: String?) {
        let trimmed = raw.jsTrimmed
        guard !trimmed.isEmpty else { return (nil, nil) }
        let urlRegex = JSRegex(#"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/(\d+)(?:[?#][^\s]*)?"#)
        let urlMatch = urlRegex.firstMatch(in: trimmed)
        let issue: Int?
        if let m = urlMatch, let n = JSRegex.substring(trimmed, m, 1) {
            issue = Int(n)
        } else {
            issue = JSRegex(#"#?(\d+)"#).group(trimmed).flatMap(Int.init)
        }
        let url = urlMatch.flatMap { JSRegex.substring(trimmed, $0, 0) }
        return (issue, url)
    }

    struct Continuation {
        var context: String?
        var githubIssue: Int?
        var githubUrl: String?
        var linesToSkip: Int
    }

    /// tasks.ts:126 `parseContinuation`
    static func parseContinuation(lines: [String], idx: Int) -> Continuation {
        var result = Continuation(linesToSkip: 0)
        var cursor = idx + 1
        while cursor < lines.count {
            let raw = lines[cursor]
            cursor += 1
            guard raw.hasPrefix("  ") else { break }
            let trimmed = raw.jsTrimmed
            if trimmed.isEmpty { result.linesToSkip += 1; continue }
            if trimmed.hasPrefix("Context:") {
                result.context = String(trimmed.dropFirst("Context:".count)).jsTrimmed
                result.linesToSkip += 1
                continue
            }
            if trimmed.hasPrefix("GitHub:") {
                let parsed = parseGitHubIssueReference(String(trimmed.dropFirst("GitHub:".count)))
                result.githubIssue = parsed.issue
                result.githubUrl = parsed.url
                result.linesToSkip += 1
                continue
            }
            break
        }
        return result
    }

    /// tasks.ts:197 `assignMissingRanks`. JS Array.sort is stable and the CLI
    /// relies on it (equal-priority items keep file order); Swift's sort is
    /// not guaranteed stable, so tie-break on the original index.
    static func assignMissingRanks(_ items: inout [PhrenTask]) {
        let unrankedIndices = items.indices.filter { items[$0].rank == nil }
        guard !unrankedIndices.isEmpty else { return }
        let maxExisting = items.compactMap(\.rank).max() ?? 0
        let priorityOrder: [PhrenTask.Priority: Int] = [.high: 0, .medium: 1, .low: 2]
        func order(_ idx: Int) -> Int {
            items[idx].priority.flatMap { priorityOrder[$0] } ?? 3
        }
        let sorted = unrankedIndices.sorted { (order($0), $0) < (order($1), $1) }
        var next = maxExisting + 1
        for idx in sorted {
            items[idx].rank = next
            next += 1
        }
    }

    // MARK: - Render (tasks.ts:240 normalizeTaskItemLine, 332 renderTask)

    static func normalizeTaskItemLine(_ item: PhrenTask) -> String {
        var text = stripPinnedTag(item.line)
        text = JSRegex(#"(\s*\[(high|medium|low)\])+\s*$"#, caseInsensitive: true).replaceAll(text, with: "").jsTrimmed
        if let priority = item.priority { text = "\(text) [\(priority.rawValue)]" }
        if item.pinned == true { text = "\(text) [pinned]" }
        let prefix = (item.checked || item.section == .done) ? "- [x] " : "- [ ] "
        let bid = item.stableId ?? FindingsFile.randomHexId()
        var meta = "bid:\(bid)"
        if let rank = item.rank { meta += " rank:\(rank)" }
        if let v = item.lastActivity { meta += " lastActivity:\(v)" }
        if let v = item.createdAt { meta += " created:\(v)" }
        if let v = item.sessionId { meta += " session:\(v)" }
        if let v = item.scope { meta += " scope:\(v)" }
        if let v = item.childFindings, !v.isEmpty { meta += " findings:\(v.joined(separator: ","))" }
        if let v = item.parentFinding { meta += " parentFinding:\(v)" }
        if item.speculative == true { meta += " speculative" }
        return "\(prefix)\(text) <!-- \(meta) -->"
    }

    /// tasks.ts:119 `formatGitHubIssueReference`
    static func formatGitHubIssueReference(_ item: PhrenTask) -> String? {
        if let issue = item.githubIssue, let url = item.githubUrl { return "#\(issue) \(url)" }
        if let issue = item.githubIssue { return "#\(issue)" }
        return item.githubUrl
    }

    public func render() -> String {
        var out: [String] = [doc.title, ""]
        for section in [PhrenTask.Section.active, .queue, .done] {
            out.append("## \(section.rawValue)")
            out.append("")
            for item in doc.items(in: section) {
                out.append(Self.normalizeTaskItemLine(item))
                if let context = item.context { out.append("  Context: \(context)") }
                if let github = Self.formatGitHubIssueReference(item) { out.append("  GitHub: \(github)") }
            }
            out.append("")
        }
        return FindingsFile.normalizeWrite(out)
    }

    // MARK: - Matching (tasks.ts:347 findItemByMatch)

    private func findItem(_ match: String) throws -> (section: PhrenTask.Section, index: Int) {
        let needle = match.jsTrimmed.lowercased()
        guard !needle.isEmpty else {
            throw PhrenKitError.emptyInput("Please provide the item text or ID to match against.")
        }
        let sections: [PhrenTask.Section] = [.active, .queue, .done]

        // 1a) Stable ID (bid:XXXX or bare 8-char hex)
        let bidNeedle = needle.hasPrefix("bid:") ? String(needle.dropFirst(4)) : needle
        if JSRegex(#"^[a-f0-9]{8}$"#).test(bidNeedle) {
            for section in sections {
                if let idx = doc.items(in: section).firstIndex(where: { $0.stableId == bidNeedle }) {
                    return (section, idx)
                }
            }
        }
        // 1b) Positional ID (A1, Q2, D3)
        for section in sections {
            if let idx = doc.items(in: section).firstIndex(where: { $0.id.lowercased() == needle }) {
                return (section, idx)
            }
        }
        // 2) Exact line match
        var exact: [(PhrenTask.Section, Int)] = []
        for section in sections {
            for (idx, item) in doc.items(in: section).enumerated()
            where item.line.jsTrimmed.lowercased() == needle {
                exact.append((section, idx))
            }
        }
        if exact.count == 1 { return exact[0] }
        if exact.count > 1 {
            throw PhrenKitError.ambiguousMatch("\"\(match)\" is ambiguous (\(exact.count) exact matches). Use item ID.")
        }
        // 3) Unique substring fallback
        var partial: [(PhrenTask.Section, Int)] = []
        for section in sections {
            for (idx, item) in doc.items(in: section).enumerated()
            where item.line.lowercased().contains(needle) {
                partial.append((section, idx))
            }
        }
        if partial.count == 1 { return partial[0] }
        if partial.count > 1 {
            throw PhrenKitError.ambiguousMatch("\"\(match)\" is ambiguous (\(partial.count) partial matches). Use item ID.")
        }
        throw PhrenKitError.notFound("Item not found — no task matching \"\(match)\".")
    }

    private mutating func removeItem(at location: (section: PhrenTask.Section, index: Int)) -> PhrenTask {
        switch location.section {
        case .active: return doc.active.remove(at: location.index)
        case .queue: return doc.queue.remove(at: location.index)
        case .done: return doc.done.remove(at: location.index)
        }
    }

    private mutating func insertItem(_ item: PhrenTask, into section: PhrenTask.Section, atFront: Bool) {
        switch section {
        case .active: atFront ? doc.active.insert(item, at: 0) : doc.active.append(item)
        case .queue: atFront ? doc.queue.insert(item, at: 0) : doc.queue.append(item)
        case .done: atFront ? doc.done.insert(item, at: 0) : doc.done.append(item)
        }
    }

    // MARK: - Mutations (tasks.ts:485-735)

    /// tasks.ts:485 `addTask` — appends to Queue with a fresh bid.
    @discardableResult
    public mutating func add(_ item: String, createdAt: String? = nil, sessionId: String? = nil) throws -> PhrenTask {
        let line = JSRegex(#"^-\s*"#).replaceFirst(item, with: "").jsTrimmed
        guard !line.isEmpty else { throw PhrenKitError.emptyInput("Task text cannot be empty.") }
        let newItem = PhrenTask(
            id: "Q\(doc.queue.count + 1)",
            stableId: FindingsFile.randomHexId(),
            section: .queue,
            line: line,
            checked: false,
            priority: Self.normalizePriority(line),
            createdAt: createdAt ?? Date().ISO8601Format(.init(includingFractionalSeconds: true)),
            sessionId: sessionId
        )
        doc.queue.append(newItem)
        return newItem
    }

    /// tasks.ts:578 `completeTask` — moves to the top of Done, checked.
    @discardableResult
    public mutating func complete(_ match: String) throws -> PhrenTask {
        let location = try findItem(match)
        var item = removeItem(at: location)
        item.section = .done
        item.checked = true
        insertItem(item, into: .done, atFront: true)
        return item
    }

    /// tasks.ts:599 `removeTask`
    @discardableResult
    public mutating func remove(_ match: String) throws -> PhrenTask {
        let location = try findItem(match)
        return removeItem(at: location)
    }

    public struct Updates: Sendable {
        public var text: String?
        public var priority: PhrenTask.Priority?
        public var section: PhrenTask.Section?

        public init(text: String? = nil, priority: PhrenTask.Priority? = nil, section: PhrenTask.Section? = nil) {
            self.text = text
            self.priority = priority
            self.section = section
        }
    }

    /// tasks.ts:642 `updateTask`, limited to the fields the web UI sends
    /// (text / priority / section — server.ts handlePostTaskUpdate).
    @discardableResult
    public mutating func update(_ match: String, updates: Updates) throws -> PhrenTask {
        let location = try findItem(match)
        var item = doc.items(in: location.section)[location.index]

        if let text = updates.text {
            let nextText = text.jsTrimmed
            guard !nextText.isEmpty else { throw PhrenKitError.emptyInput("Task text cannot be empty.") }
            item.line = nextText
            item.priority = Self.normalizePriority(nextText)
            item.pinned = Self.detectPinned(nextText) ? true : nil
        }
        if let priority = updates.priority {
            item.priority = priority
            item.line = Self.stripPriorityTag(item.line)
            item.line = "\(item.line) [\(priority.rawValue)]"
        }

        // tasks.ts:720 — a section update always splices + unshifts into the
        // target, even when it's the same section (moves the item to the front).
        if let target = updates.section {
            _ = removeItem(at: location)
            item.section = target
            item.checked = target == .done
            insertItem(item, into: target, atFront: true)
        } else {
            switch location.section {
            case .active: doc.active[location.index] = item
            case .queue: doc.queue[location.index] = item
            case .done: doc.done[location.index] = item
            }
        }
        return item
    }
}
