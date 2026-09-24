import Foundation
import PhrenKit

/// One row shape for what Memory lists: findings, notes, tasks and topics of
/// a scope, resolved to the loaded graph's nodes when they are drawn there.
struct MemoryItem: Identifiable, Equatable {
    enum Kind: String { case finding, note, task, topic, project }

    let kind: Kind
    /// Stable per kind: a finding's fid, a note's nid, a task's bid, a
    /// topic's slug, a project's name.
    let key: String
    let storeId: String
    let project: String
    let text: String
    let date: String?
    let typeTag: String?
    let section: PhrenTask.Section?
    /// A second caption on the meta line ("12 findings" on a topic).
    let detail: String?
    /// The graph node this row selects, when the loaded graph draws it.
    var nodeID: String?
    let finding: Finding?
    let task: PhrenTask?

    var id: String { "\(kind.rawValue):\(key)" }
    var rowIdentifier: String { "memory-row:\(id)" }
}

/// One content kind the Memory filters can show or hide. An empty set reads as
/// every kind; `MemoryKind.allCases` is the same full set.
enum MemoryKind: String, CaseIterable, Identifiable, Hashable {
    case findings = "Findings", notes = "Notes", tasks = "Tasks", topics = "Topics"

    var id: String { rawValue.lowercased() }

    var itemKind: MemoryItem.Kind {
        switch self {
        case .findings: return .finding
        case .notes: return .note
        case .tasks: return .task
        case .topics: return .topic
        }
    }
}

struct MemoryCounts: Equatable {
    var findings = 0
    var notes = 0
    var tasks = 0
    var topics = 0

    var isEmpty: Bool { findings == 0 && notes == 0 && tasks == 0 }

    /// "42 findings · 9 tasks · 6 topics". Notes remain available as
    /// rows but stay out of the compact scope summary.
    var line: String {
        let parts = [
            Self.count(findings, "finding"),
            Self.count(tasks, "task"),
            Self.count(topics, "topic"),
        ]
        return parts.joined(separator: " · ")
    }

    /// The counts line for the current kinds filter. An empty set (or all
    /// four) reads as the full line; a notes-only scope names its notes
    /// because no other kind would otherwise appear.
    func line(for kinds: Set<MemoryKind>) -> String {
        let effective = kinds.isEmpty ? Set(MemoryKind.allCases) : kinds
        var parts: [String] = []
        if effective.contains(.findings) { parts.append(Self.count(findings, "finding")) }
        if effective.contains(.tasks) { parts.append(Self.count(tasks, "task")) }
        if effective.contains(.topics) { parts.append(Self.count(topics, "topic")) }
        if parts.isEmpty, effective.contains(.notes) { parts.append(Self.count(notes, "note")) }
        return parts.joined(separator: " · ")
    }

    private static func count(_ value: Int, _ noun: String) -> String {
        "\(value) \(noun)\(value == 1 ? "" : "s")"
    }
}

/// A store's sync freshness as the panel header shows it.
struct MemoryFreshness: Equatable {
    var lastSyncedAt: Date?
    var isSyncing = false
    var hasError = false

    static let staleAfter: TimeInterval = 10 * 60

    func isStale(now: Date) -> Bool {
        if isSyncing { return false }
        guard let lastSyncedAt else { return true }
        return now.timeIntervalSince(lastSyncedAt) > Self.staleAfter
    }

    func text(now: Date) -> String {
        if hasError { return "sync error" }
        if isSyncing { return "syncing" }
        guard let lastSyncedAt else { return "not synced" }
        let minutes = max(0, Int(now.timeIntervalSince(lastSyncedAt) / 60))
        if minutes < 1 { return "updated just now" }
        if minutes < 60 { return "updated \(minutes)m ago" }
        return "updated \(minutes / 60)h ago"
    }
}

enum MemoryBrowsing {
    /// The join between the snapshot's rows and the renderer's nodes: a
    /// finding has no id in the graph beyond its project and text, a task's
    /// node id is minted from its positional id.
    struct NodeIndex: Equatable {
        private var byText: [String: String] = [:]
        private var ids: Set<String> = []

        init(payload: GraphPayload?) {
            guard let payload else { return }
            for node in payload.nodes {
                ids.insert(node.id)
                let key = Self.key(node.project, node.fullLabel)
                if byText[key] == nil { byText[key] = node.id }
            }
        }

        private static func key(_ project: String, _ text: String) -> String { "\(project)\u{1}\(text)" }

        var isEmpty: Bool { ids.isEmpty }
        func contains(_ id: String) -> Bool { ids.contains(id) }
        func nodeID(project: String, text: String) -> String? { byText[Self.key(project, text)] }
    }

    /// The finding without its leading `[tag]`; the chip carries the tag.
    static func displayText(_ finding: Finding) -> String {
        guard let tag = finding.typeTag else { return finding.text }
        let prefix = "[\(tag)]"
        guard finding.text.lowercased().hasPrefix(prefix) else { return finding.text }
        return String(finding.text.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    }

    static func topicLabel(_ slug: String) -> String {
        slug.replacingOccurrences(of: "-", with: " ").capitalized
    }

    static func taskText(_ task: PhrenTask) -> String {
        TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(task.line))
    }

    /// Everything saved in the scope: findings newest first, then notes
    /// newest first, then tasks (active, backlog, done), then topics.
    static func contents(snapshot: LocalStore.Snapshot, storeId: String, project: String?, nodes: NodeIndex) -> [MemoryItem] {
        let projects = project.map { [$0] } ?? snapshot.projects.map(\.name).sorted()
        var findings: [(String, MemoryItem)] = []
        var notes: [(String, MemoryItem)] = []
        var tasks: [MemoryItem] = []
        var topicCounts: [String: Int] = [:]
        for name in projects {
            for finding in snapshot.findings[name] ?? [] where !finding.archived {
                let text = displayText(finding)
                let node = nodes.nodeID(project: name, text: text) ?? nodes.nodeID(project: name, text: finding.text)
                findings.append((finding.date, MemoryItem(
                    kind: .finding, key: finding.stableId ?? "\(name)-\(finding.id)", storeId: storeId, project: name,
                    text: text, date: finding.date, typeTag: finding.typeTag, section: nil, detail: nil,
                    nodeID: node, finding: finding, task: nil
                )))
                topicCounts[finding.typeTag ?? "general", default: 0] += 1
            }
            for note in snapshot.notes[name] ?? [] {
                notes.append(("\(note.date) \(note.time)", MemoryItem(
                    kind: .note, key: note.stableId, storeId: storeId, project: name,
                    text: note.text, date: note.date, typeTag: nil, section: nil, detail: nil,
                    nodeID: nil, finding: nil, task: nil
                )))
            }
            guard let doc = snapshot.tasks[name] else { continue }
            for task in doc.allItems {
                let nodeID = "\(name):task:\(task.id)"
                tasks.append(MemoryItem(
                    kind: .task, key: task.stableId ?? "\(name)-\(task.id)", storeId: storeId, project: name,
                    text: taskText(task), date: task.createdAt.map { String($0.prefix(10)) },
                    typeTag: task.priority?.rawValue, section: task.section, detail: nil,
                    nodeID: nodes.contains(nodeID) ? nodeID : nil, finding: nil, task: task
                ))
            }
        }
        // Newest first; a tie keeps file order, so the sort is stable by index.
        func newestFirst(_ dated: [(String, MemoryItem)]) -> [MemoryItem] {
            dated.enumerated().sorted { left, right in
                left.element.0 != right.element.0 ? left.element.0 > right.element.0 : left.offset < right.offset
            }.map(\.element.1)
        }
        let topics = topicCounts.keys.sorted().map { slug in
            let count = topicCounts[slug] ?? 0
            return MemoryItem(
                kind: .topic, key: slug, storeId: storeId, project: project ?? "", text: topicLabel(slug),
                date: nil, typeTag: nil, section: nil, detail: "\(count) finding\(count == 1 ? "" : "s")",
                nodeID: nil, finding: nil, task: nil
            )
        }
        return newestFirst(findings) + newestFirst(notes) + tasks + topics
    }

    static func counts(_ items: [MemoryItem]) -> MemoryCounts {
        var counts = MemoryCounts()
        for item in items {
            switch item.kind {
            case .finding: counts.findings += 1
            case .note: counts.notes += 1
            case .task: counts.tasks += 1
            case .topic: counts.topics += 1
            case .project: break
            }
        }
        return counts
    }

    /// The kinds filter: an empty set keeps every content row; a chosen set
    /// keeps only those kinds. Project result rows are never filtered out.
    static func filter(_ items: [MemoryItem], kinds: Set<MemoryKind>) -> [MemoryItem] {
        guard !kinds.isEmpty, kinds != Set(MemoryKind.allCases) else { return items.filter { $0.kind != .project } }
        let allowed = Set(kinds.map(\.itemKind))
        return items.filter { $0.kind == .project || allowed.contains($0.kind) }
    }

    /// What the graph draws for the chosen kinds; notes are native-only, so a
    /// notes-only scope still leaves the findings graph in place.
    static func graphFilter(kinds: Set<MemoryKind>) -> GraphPayload.ContentFilter {
        let effective = kinds.isEmpty ? Set(MemoryKind.allCases) : kinds
        let findings = effective.contains(.findings) || effective.contains(.topics)
        let tasks = effective.contains(.tasks)
        switch (findings, tasks) {
        case (true, true): return .all
        case (true, false): return .findings
        case (false, true): return .tasks
        case (false, false): return .all
        }
    }

    /// Search results: the on-phone index's hits in rank order, mapped onto
    /// the scope's rows (so each carries its node), then the projects the
    /// graph's own search matched, which the index does not carry.
    static func results(hits: [SearchIndex.Result], graphMatches: [GraphPayload.Node],
                        contents: [MemoryItem], storeId: String) -> [MemoryItem] {
        var byKey: [String: MemoryItem] = [:]
        for item in contents {
            let raw: String
            switch item.kind {
            case .finding: raw = item.finding?.text ?? item.text
            case .task: raw = item.task?.line ?? item.text
            default: raw = item.text
            }
            byKey["\(item.kind.rawValue)\u{1}\(item.project)\u{1}\(raw)"] = item
        }
        var seen: Set<String> = []
        var items: [MemoryItem] = []
        for hit in hits {
            let kind: MemoryItem.Kind
            switch hit.kind {
            case .finding: kind = .finding
            case .note: kind = .note
            case .task: kind = .task
            case .summary, .truth: continue
            }
            guard let item = byKey["\(kind.rawValue)\u{1}\(hit.project)\u{1}\(hit.text)"],
                  seen.insert(item.id).inserted else { continue }
            items.append(item)
        }
        for node in graphMatches where node.group == "project" && seen.insert("project:\(node.id)").inserted {
            let findings = node.findingCount ?? 0, tasks = node.taskCount ?? 0
            items.append(MemoryItem(
                kind: .project, key: node.id, storeId: storeId, project: node.project, text: node.label,
                date: nil, typeTag: nil, section: nil,
                detail: "\(findings) finding\(findings == 1 ? "" : "s") · \(tasks) task\(tasks == 1 ? "" : "s")",
                nodeID: node.id, finding: nil, task: nil
            ))
        }
        return items
    }

    /// Rows by project in order of first appearance, for results across a store.
    static func grouped(_ items: [MemoryItem]) -> [(project: String, rows: [MemoryItem])] {
        var order: [String] = []
        var groups: [String: [MemoryItem]] = [:]
        for item in items {
            if groups[item.project] == nil { order.append(item.project) }
            groups[item.project, default: []].append(item)
        }
        return order.map { (project: $0, rows: groups[$0] ?? []) }
    }
}
