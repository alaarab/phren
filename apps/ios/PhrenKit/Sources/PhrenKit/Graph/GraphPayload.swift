import CryptoKit
import Foundation

/// The payload `window.phrenGraph.mount()` consumes, transcribed from the
/// `GraphPayload` the web memory UI receives (packages/cli/browser/graph/types.ts:37)
/// and produced by `buildGraph` (packages/cli/src/ui/data.ts:251).
///
/// On the web this JSON comes from the local phren HTTP server. The iOS app is
/// serverless, so the same shape is built on-device from the synced markdown.
///
/// **Deliberate divergences from `buildGraph`**, all consequences of what the
/// app syncs rather than of the renderer:
///
/// - No `entity` or `reference` nodes. Both are derived from `reference/` docs
///   and the FTS index, neither of which the app mirrors.
/// - Topics come from the finding's own `[tag]` rather than
///   `classifyTopicForText`. The CLI's topic set is *adaptive* — built from a
///   content signal over the whole store (project-topics.ts:636) — and a
///   half-transcribed version would silently disagree with the desktop graph.
///   Tag-derived topics are honest about being a different, simpler grouping.
/// - `scores` is empty: score journals live under `.config/`, unsynced.
///
/// Node ids, score keys, and link structure *do* match the CLI exactly, which
/// is what lets a node round-trip back to a FINDINGS.md bullet on save.
public struct GraphPayload: Codable, Equatable, Sendable {
    public struct Node: Codable, Equatable, Identifiable, Sendable {
        public var id: String
        public var label: String
        public var fullLabel: String
        public var group: String
        public var refCount: Int
        public var project: String
        public var store: String
        public var tagged: Bool
        public var scoreKey: String?
        public var scoreKeys: [String]?
        public var refDocs: [RefDoc]?
        public var topicSlug: String?
        public var topicLabel: String?
        public var date: String?
        public var priority: String?
        public var section: String?
        public var findingCount: Int?
        public var taskCount: Int?
        /// Everything the project knows: live findings, journal notes and the
        /// archive the CLI moved into topic files (read from summary.md).
        public var totalFindingCount: Int?
        /// Open tasks (active and queue), not only the ones drawn.
        public var openTaskCount: Int?
        /// The number beside a project's label for the current filter.
        public var labelCount: Int?
    }

    public struct RefDoc: Codable, Equatable, Sendable {
        public var doc: String
        public var project: String
        public var scoreKey: String?
    }

    public struct Link: Codable, Equatable, Sendable {
        public var source: String
        public var target: String
    }

    public struct Topic: Codable, Equatable, Sendable {
        public var slug: String
        public var label: String
    }

    public var nodes: [Node]
    public var links: [Link]
    public var topics: [Topic]
    public var total: Int

    // Public initializer for native graph views and derived slices.
    public init(nodes: [Node], links: [Link], topics: [Topic], total: Int) {
        self.nodes = nodes
        self.links = links
        self.topics = topics
        self.total = total
    }

    public func jsonString() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let json = String(data: try encoder.encode(self), encoding: .utf8) else {
            throw PhrenKitError.validation("Graph payload is not encodable as UTF-8.")
        }
        return json
    }

    public enum ContentFilter: String, Codable, CaseIterable, Sendable {
        case all = "All", findings = "Findings", tasks = "Tasks"
    }

    /// Keep project hubs so the filtered leaves retain their relationships.
    public func filtered(by filter: ContentFilter) -> GraphPayload {
        let filtered = nodes.filter { node in
            filter == .all || node.group == "project"
                || (filter == .findings && node.group.hasPrefix("topic:"))
                || (filter == .tasks && node.group.hasPrefix("task-"))
        }.map { node -> Node in
            // A project's number counts what the filter shows, and all of it:
            // with Tasks it is open tasks, otherwise every finding the project
            // holds, not just the recent ones the graph draws.
            guard node.group == "project" else { return node }
            var labeled = node
            labeled.labelCount = filter == .tasks ? (node.openTaskCount ?? node.taskCount) : (node.totalFindingCount ?? node.findingCount)
            return labeled
        }
        let ids = Set(filtered.map(\.id))
        return GraphPayload(nodes: filtered, links: links.filter { ids.contains($0.source) && ids.contains($0.target) },
                            topics: topics, total: filtered.count)
    }

    public func search(_ query: String) -> [Node] {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !terms.isEmpty else { return [] }
        return nodes.filter { node in
            let text = "\(node.fullLabel) \(node.project) \(node.topicLabel ?? "")"
            return terms.allSatisfy { text.localizedCaseInsensitiveContains($0) }
        }
    }

    /// Traverse actual edges in either direction; never invent similarity links.
    /// A missing anchor returns the current graph so a deleted bookmark cannot
    /// strand the viewer on an empty canvas.
    public func neighborhood(of nodeID: String, steps: Int = 1) -> GraphPayload {
        guard nodes.contains(where: { $0.id == nodeID }) else { return self }
        let available = Set(nodes.map(\.id))
        var neighbors: [String: Set<String>] = [:]
        for link in links where available.contains(link.source) && available.contains(link.target) {
            neighbors[link.source, default: []].insert(link.target)
            neighbors[link.target, default: []].insert(link.source)
        }
        var included: Set<String> = [nodeID]
        var frontier = included
        for _ in 0..<min(2, max(1, steps)) {
            let next = Set(frontier.flatMap { neighbors[$0] ?? [] }).subtracting(included)
            included.formUnion(next)
            frontier = next
        }
        let slice = nodes.filter { included.contains($0.id) }
        return GraphPayload(nodes: slice,
                            links: links.filter { included.contains($0.source) && included.contains($0.target) },
                            topics: topics, total: slice.count)
    }
}

/// Builds a `GraphPayload` from cached markdown.
public enum GraphBuilder {
    /// `entryScoreKey` (packages/cli/src/governance/scores.ts:247) — the key
    /// the CLI mints per bullet, and the handle the app uses to resolve a
    /// graph node back to its exact FINDINGS.md line.
    public static func entryScoreKey(project: String, filename: String, snippet: String) -> String {
        let short = String(snippet.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).prefix(200))
        let digest = Insecure.SHA1.hash(data: Data("\(project):\(filename):\(short)".utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "\(project)/\(filename):\(hex.prefix(12))"
    }

    /// `findingStableId` (packages/cli/src/finding-graph-id.ts:12).
    public static func findingStableId(scoreKey: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(scoreKey.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "finding:\(hex.prefix(12))"
    }

    static let taggedBullet = JSRegex(#"^-\s+\[([a-z_-]+)\]\s+(.+?)(?:\s*<!--.*-->)?$"#)
    static let plainBullet = JSRegex(#"^-\s+(.+?)(?:\s*<!--.*-->)?$"#)
    static let dateHeading = JSRegex(#"^##\s+(\d{4}-\d{2}-\d{2})"#)
    static let minPlainLength = 10

    /// data.ts:351 — unfocused graphs are capped; focusing a project lifts the
    /// cap for that project.
    static let maxTagged = 200
    static let maxUntagged = 100
    static let maxTasks = 50

    /// `label` truncation, data.ts:426.
    static func truncate(_ text: String) -> String {
        text.count > 55 ? "\(text.prefix(52))..." : text
    }

    public struct Input: Sendable {
        /// project → raw FINDINGS.md
        public var findingsMarkdown: [String: String]
        public var tasks: [String: TaskDoc]
        public var projects: [String]
        public var storeName: String
        public var journalFindings: [String: [Finding]]
        /// project → every finding it holds, archive included; absent when
        /// the project has no summary to say how many are archived.
        public var findingTotals: [String: Int]

        public init(findingsMarkdown: [String: String], tasks: [String: TaskDoc],
                    projects: [String], storeName: String, journalFindings: [String: [Finding]] = [:],
                    findingTotals: [String: Int] = [:]) {
            self.findingsMarkdown = findingsMarkdown
            self.tasks = tasks
            self.projects = projects
            self.storeName = storeName
            self.journalFindings = journalFindings
            self.findingTotals = findingTotals
        }
    }

    public static func build(_ input: Input, focusProject: String? = nil) -> GraphPayload {
        var nodes: [GraphPayload.Node] = []
        var links: [GraphPayload.Link] = []
        var usedFindingIds: [String: Int] = [:]
        var topics: [String: String] = [:]
        var findingCounts: [String: Int] = [:]
        var taskCounts: [String: Int] = [:]

        let projectSet = Set(input.projects)
        let considered = focusProject.map { [$0] } ?? input.projects
        let isFocused = focusProject != nil

        // data.ts:291 — a repeated score key (two identical bullets) gets a
        // `-2`, `-3` suffix so node ids stay unique.
        func uniqueFindingId(_ id: String) -> String {
            let seen = usedFindingIds[id] ?? 0
            usedFindingIds[id] = seen + 1
            return seen == 0 ? id : "\(id)-\(seen + 1)"
        }

        for project in considered.sorted() {
            let markdown = input.findingsMarkdown[project]
            nodes.append(GraphPayload.Node(
                id: project, label: project, fullLabel: project, group: "project",
                refCount: markdown == nil ? 0 : 1, project: project, store: input.storeName,
                tagged: false, findingCount: 0, taskCount: 0
            ))

            var taggedCount = 0
            var untaggedAdded = 0
            var currentDate: String?

            for rawLine in (markdown ?? "").split(separator: "\n", omittingEmptySubsequences: false) {
                let line = String(rawLine)
                if let date = dateHeading.group(line, 1) {
                    currentDate = date
                    continue
                }

                var text: String?
                var tag: String?
                if let matchedTag = taggedBullet.group(line, 1) {
                    tag = matchedTag
                    text = taggedBullet.group(line, 2)?.trimmingCharacters(in: .whitespaces)
                } else {
                    text = plainBullet.group(line, 1)?.trimmingCharacters(in: .whitespaces)
                }
                guard let text, !text.isEmpty else { continue }

                let isTagged = tag != nil
                if isTagged {
                    if !isFocused && taggedCount >= maxTagged { continue }
                } else {
                    if text.count < minPlainLength { continue }
                    if !isFocused && untaggedAdded >= maxUntagged { continue }
                }

                // data.ts:429 — the score key is minted over the bullet
                // *including* its tag prefix, which is what disambiguates two
                // findings differing only by tag.
                let snippet = tag.map { "[\($0)] \(text)" } ?? text
                let scoreKey = entryScoreKey(project: project, filename: "FINDINGS.md", snippet: snippet)
                let nodeId = uniqueFindingId(findingStableId(scoreKey: scoreKey))

                let slug = tag ?? "general"
                topics[slug] = topics[slug] ?? slug.replacingOccurrences(of: "-", with: " ").capitalized

                if isTagged { taggedCount += 1 } else { untaggedAdded += 1 }
                nodes.append(GraphPayload.Node(
                    id: nodeId, label: truncate(text), fullLabel: text,
                    group: "topic:\(slug)", refCount: isTagged ? taggedCount : untaggedAdded,
                    project: project, store: input.storeName, tagged: isTagged,
                    scoreKey: scoreKey, scoreKeys: [scoreKey],
                    refDocs: [GraphPayload.RefDoc(doc: "\(project)/FINDINGS.md", project: project, scoreKey: scoreKey)],
                    topicSlug: slug, topicLabel: topics[slug], date: currentDate
                ))
                links.append(GraphPayload.Link(source: project, target: nodeId))

                // data.ts:412 — an exact mention of another project's name
                // links the two projects.
                for other in exactProjectMentions(text, projectSet: projectSet, current: project) {
                    links.append(GraphPayload.Link(source: project, target: other))
                }
            }
            // Team findings live in append-only journals. They have distinct
            // identities and no FINDINGS.md score key, so they cannot be
            // routed to that file's edit/delete operations.
            for finding in input.journalFindings[project] ?? [] {
                guard !finding.archived, let file = finding.journalFile else { continue }
                if !isFocused && taggedCount + untaggedAdded >= maxTagged + maxUntagged { break }
                let slug = finding.typeTag ?? "general"
                topics[slug] = topics[slug] ?? slug.replacingOccurrences(of: "-", with: " ").capitalized
                let key = entryScoreKey(project: project, filename: file, snippet: finding.rawLine)
                let id = uniqueFindingId("journal:\(findingStableId(scoreKey: key))")
                nodes.append(GraphPayload.Node(
                    id: id, label: truncate(finding.text), fullLabel: finding.text,
                    group: "topic:\(slug)", refCount: 0, project: project, store: input.storeName,
                    tagged: finding.typeTag != nil, topicSlug: slug, topicLabel: topics[slug], date: finding.date
                ))
                links.append(GraphPayload.Link(source: project, target: id))
                if finding.typeTag == nil { untaggedAdded += 1 } else { taggedCount += 1 }
            }
            findingCounts[project] = taggedCount + untaggedAdded

            // ── Tasks (data.ts:497) ──
            if let doc = input.tasks[project] {
                var taskCount = 0
                for section in [PhrenTask.Section.active, .queue] {
                    let group = section == .active ? "task-active" : "task-queue"
                    for item in doc.items(in: section) {
                        if !isFocused && taskCount >= maxTasks { break }
                        let scoreKey = entryScoreKey(project: project, filename: "tasks.md", snippet: item.line)
                        nodes.append(GraphPayload.Node(
                            id: "\(project):task:\(item.id)", label: truncate(item.line), fullLabel: item.line,
                            group: group, refCount: 0, project: project, store: input.storeName,
                            tagged: false, scoreKey: scoreKey, scoreKeys: [scoreKey],
                            refDocs: [GraphPayload.RefDoc(doc: "\(project)/tasks.md", project: project, scoreKey: scoreKey)],
                            priority: item.priority?.rawValue, section: item.section.rawValue
                        ))
                        links.append(GraphPayload.Link(source: project, target: "\(project):task:\(item.id)"))
                        taskCount += 1
                    }
                }
                taskCounts[project] = taskCount
            }
        }

        // Fold the per-project tallies back onto the project nodes.
        for index in nodes.indices where nodes[index].group == "project" {
            let id = nodes[index].id
            nodes[index].findingCount = findingCounts[id] ?? 0
            nodes[index].taskCount = taskCounts[id] ?? 0
            nodes[index].totalFindingCount = input.findingTotals[id] ?? findingCounts[id] ?? 0
            nodes[index].openTaskCount = input.tasks[id].map { $0.items(in: .active).count + $0.items(in: .queue).count } ?? 0
        }

        // Drop links pointing at projects outside the focused slice.
        let nodeIds = Set(nodes.map(\.id))
        links = links.filter { nodeIds.contains($0.source) && nodeIds.contains($0.target) }

        let topicList = topics
            .map { GraphPayload.Topic(slug: $0.key, label: $0.value) }
            .sorted { $0.slug < $1.slug }

        return GraphPayload(nodes: nodes, links: links, topics: topicList, total: nodes.count)
    }

    /// `findBulletTextByScoreKey` (packages/cli/src/ui/server.ts:1232) —
    /// resolve a node's score key back to the exact FINDINGS.md bullet,
    /// *including* its `[tag]` prefix, which is the string the finding
    /// mutators match on. Returns nil when the key does not resolve, so
    /// callers fall back to text matching exactly as the server does.
    public static func findBulletText(project: String, scoreKey: String, findingsMarkdown: String) -> String? {
        for rawLine in findingsMarkdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let entry: String?
            if let tag = taggedBullet.group(line, 1), let text = taggedBullet.group(line, 2) {
                entry = "[\(tag)] \(text.trimmingCharacters(in: .whitespaces))"
            } else if let text = plainBullet.group(line, 1) {
                entry = text.trimmingCharacters(in: .whitespaces)
            } else {
                entry = nil
            }
            guard let entry, !entry.isEmpty else { continue }
            if entryScoreKey(project: project, filename: "FINDINGS.md", snippet: entry) == scoreKey {
                return entry
            }
        }
        return nil
    }

    /// `exactProjectMentions` (data.ts:101) — tokenize on `[a-z0-9_-]+` and
    /// match a whole token, so "phren" in "phrenology" is not a mention.
    static let projectToken = JSRegex(#"[a-z0-9_-]+"#)

    static func exactProjectMentions(_ text: String, projectSet: Set<String>, current: String) -> [String] {
        let tokens = Set(projectToken.allMatches(text.lowercased()))
        return projectSet
            .filter { $0 != current && tokens.contains($0.lowercased()) }
            .sorted()
    }
}
