import Foundation

/// On-device mirror of the phren store repo: plain markdown files under
/// Application Support, path-for-path with the repo, plus a manifest of blob
/// SHAs. Markdown text is the source of truth (matching the CLI), so no
/// database — parsing the whole store is trivial at phren's documented scale
/// (docs/performance.md: <1K findings is "small").
public actor LocalStore {
    /// **Persisted** as `manifest.json`. Less precious than the pending-ops
    /// queue — the cache it indexes can be refetched — but losing it silently
    /// forces a full re-download and hides real corruption, so it follows the
    /// same contract. See ``VersionedDocument`` before adding a field.
    public struct Manifest: Codable, Sendable, VersionedDocument {
        /// Still 1: adding `schemaVersion` is additive, and the shape shipped
        /// builds wrote (without the key) is version 1 by definition.
        public static let currentSchemaVersion = 1

        public var schemaVersion: Int = Manifest.currentSchemaVersion
        public var owner: String
        public var repo: String
        public var branch: String
        public var headSha: String?
        /// repo path → blob SHA (the optimistic-concurrency key for writes)
        public var blobShas: [String: String]
        public var lastSyncedAt: Date?

        /// What the user calls this file when it goes wrong.
        static let documentName = "offline cache records"

        public init(owner: String, repo: String, branch: String) {
            self.owner = owner
            self.repo = repo
            self.branch = branch
            self.blobShas = [:]
        }

        enum CodingKeys: String, CodingKey {
            case schemaVersion, owner, repo, branch, headSha, blobShas, lastSyncedAt
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            // Absent in every manifest written before versioning existed.
            schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion)
                ?? Self.initialSchemaVersion
            owner = try container.decode(String.self, forKey: .owner)
            repo = try container.decode(String.self, forKey: .repo)
            branch = try container.decode(String.self, forKey: .branch)
            headSha = try container.decodeIfPresent(String.self, forKey: .headSha)
            blobShas = try container.decodeIfPresent([String: String].self, forKey: .blobShas) ?? [:]
            lastSyncedAt = try container.decodeIfPresent(Date.self, forKey: .lastSyncedAt)
        }
    }

    /// Only these paths are ever written back to GitHub. Everything else in
    /// the store — `.config/` (except skill preferences), `phren.root.yaml`, `stores.yaml`,
    /// `.phren-team.yaml`, `summary.md`, `truths.md`, and `reference/` — is
    /// read-only. Authored skills and canonical CLAUDE.md instructions are
    /// explicitly writable in project directories and global/.
    ///
    /// `journal/YYYY-MM-DD-<actor>.md` is writable *and* gated on exactly the
    /// same ``isProjectDirName`` predicate as `FINDINGS.md`, which is what
    /// makes routing a team store's adds to the journal a no-op for every
    /// read-only tier: `global/journal/…` is refused for the same reason
    /// `global/FINDINGS.md` is.
    public static func isWritablePath(_ path: String) -> Bool {
        if path == SkillPreferences.path { return true }
        // Authored content is separate from global's read-only findings tier.
        if isSkillPath(path) || AgentInstructions.isPath(path) { return true }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 2, isProjectDirName(parts[0]) else { return false }
        if parts.count == 2 {
            return ["FINDINGS.md", "tasks.md", "review.md"].contains(parts[1])
        }
        if parts.count == 3, parts[1] == "notes" {
            return JSRegex(#"^\d{4}-\d{2}-\d{2}\.md$"#).test(parts[2])
        }
        if parts.count == 3, parts[1] == JournalFile.directoryName {
            return JournalFile.parseFileName(parts[2]) != nil
        }
        return false
    }

    /// Paths the sync engine mirrors locally — the **hot tier**. Skips
    /// `.config/` except skill preferences, and `reference/`; `reference/topics/` instead
    /// gets a lazily hydrated cold tier (``ColdStore``), and the rest is
    /// deliberately untouched.
    ///
    /// `global/FINDINGS.md` is hot but read-only: it is the
    /// consolidate skill's cross-project output — typically the largest
    /// findings file in a store — and hiding it was hiding the store's
    /// highest-value content. It is admitted here *without* being admitted to
    /// ``isProjectDirName``, because ``isWritablePath`` delegates to that
    /// predicate and would otherwise make the phone able to rewrite it.
    public static func isSyncedPath(_ path: String) -> Bool {
        if path == SkillPreferences.path { return true }
        if path == "phren.root.yaml" || path == "stores.yaml" { return true }
        // A team store repo describes itself: `.phren-team.yaml` is what the
        // CLI reads to decide the role it registers a joined store under
        // (cli/namespaces-store.ts:147), so it is also how the phone knows
        // whether this repo's finding-adds belong in the journal.
        if path == TeamBootstrap.fileName { return true }
        if isSkillPath(path) { return true }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return false }
        if parts[0] == globalDirName {
            // Findings plus the instructions that frame them. Nothing else
            // under `global/` is hot — its notes/tasks/review are CLI-side
            // machinery with no phone surface.
            return parts.count == 2 && ["FINDINGS.md", "CLAUDE.md"].contains(parts[1])
        }
        guard isProjectDirName(parts[0]) else { return false }
        if parts.count == 2 {
            return ["FINDINGS.md", "tasks.md", "review.md", "summary.md", "CLAUDE.md", "truths.md"].contains(parts[1])
        }
        if parts.count == 3, parts[1] == "notes" {
            return JSRegex(#"^\d{4}-\d{2}-\d{2}\.md$"#).test(parts[2])
        }
        // In a team store this is where the findings *are*: the CLI's add path
        // appends here and returns without touching FINDINGS.md
        // (tools/finding.ts:186). Leaving it out of the hot tier rendered a
        // project whose whole history lives in the journal as empty. Same
        // shape as `notes/` — one small file per day — with an actor suffix,
        // so it grows with the number of people writing, not with the size of
        // what they wrote.
        if parts.count == 3, parts[1] == JournalFile.directoryName {
            return JournalFile.parseFileName(parts[2]) != nil
        }
        return false
    }

    /// The two skill file shapes `collectSkills` recognizes
    /// (packages/cli/src/skill/registry.ts:97-102), under either
    /// `global/skills/` or `<project>/skills/`: a flat `<name>.md`, or a folder
    /// `<name>/SKILL.md`. Nothing else in a skill folder is synced —
    /// supporting files would need a whole-directory model the app lacks.
    public static func isSkillPath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 3, parts[1] == "skills" else { return false }
        guard parts[0] == globalDirName || isProjectDirName(parts[0]) else { return false }
        if parts.count == 3 {
            return parts[2].hasSuffix(".md") && isSkillNameSegment(String(parts[2].dropLast(3)))
        }
        if parts.count == 4 {
            return parts[3] == "SKILL.md" && isSkillNameSegment(parts[2])
        }
        return false
    }

    /// Guards the segments the app will mint or write. Deliberately stricter
    /// than the CLI's on-disk reader: it rejects dot-segments and separators,
    /// so a name typed in the editor can never escape `skills/`.
    static func isSkillNameSegment(_ name: String) -> Bool {
        JSRegex(#"^[A-Za-z0-9][A-Za-z0-9._-]*$"#).test(name) && !name.contains("..")
    }

    /// The cross-project tier: consolidated findings that apply everywhere,
    /// written by the CLI's consolidate skill and by nothing on the phone.
    public static let globalDirName = "global"

    /// Directory names phren reserves for infrastructure, so none of them is
    /// ever a project. Mirrors the CLI's `RESERVED_PROJECT_DIR_NAMES`
    /// (packages/cli/src/phren-core.ts:32) plus `scripts`, which
    /// `setupSparseCheckout` (packages/cli/src/link/link.ts:202) materializes
    /// at the store root next to `profiles` and `global`.
    ///
    /// The dot-prefixed names can't survive ``isProjectDirName``'s regex
    /// anyway; they are listed so this set stays diffable against the CLI's
    /// rather than silently drifting the next time either side gains an entry.
    static let reservedDirNames: Set<String> = [
        globalDirName, ".runtime", ".sessions", ".config", "profiles", "templates", "scripts",
    ]

    /// Project directory names mirror `isValidProjectName` (lowercase letters,
    /// numbers, hyphens), excluding reserved and archived dirs.
    ///
    /// **This is the writability predicate.** ``isWritablePath`` delegates to
    /// it, so admitting a name here makes that directory's findings/tasks/
    /// notes editable from the phone. Read-only tiers belong in
    /// ``isReadableProjectDirName``, never here.
    static func isProjectDirName(_ name: String) -> Bool {
        guard JSRegex(#"^[a-z0-9][a-z0-9-]*$"#).test(name) else { return false }
        return !reservedDirNames.contains(name) && !name.hasSuffix(".archived")
    }

    /// Directories the app *renders* as projects: the writable ones plus
    /// `global`. Split from ``isProjectDirName`` on purpose — see that
    /// predicate's note on why relaxing it instead would have made the
    /// cross-project tier writable.
    public static func isReadableProjectDirName(_ name: String) -> Bool {
        isProjectDirName(name) || name == globalDirName
    }

    /// True for a project the app shows but must never offer to edit. The UI
    /// asks this before drawing an add/edit/delete affordance; the sync engine
    /// enforces the same answer through ``isWritablePath`` at flush time.
    public static func isReadOnlyProject(_ name: String) -> Bool {
        isReadableProjectDirName(name) && !isProjectDirName(name)
    }

    private let root: URL
    private var manifest: Manifest
    private struct FileState: Equatable {
        let path: String
        let identity: String
        let modified: Date
        let size: Int
    }
    private var cachedSnapshot: (files: [FileState], value: Snapshot)?
    /// Persistence problems hit while opening this store. Kept for per-store
    /// attribution; the app surfaces them through `StorageIssueLog`, which
    /// already has them.
    public private(set) var storageIssues: [StorageIssue] = []

    public init(rootDirectory: URL, owner: String, repo: String, branch: String) throws {
        self.root = rootDirectory
        try FileManager.default.createDirectory(at: root.appendingPathComponent("files"),
                                                withIntermediateDirectories: true)
        let loaded = PersistedState.load(
            Manifest.self,
            from: rootDirectory.appendingPathComponent("manifest.json"),
            document: Manifest.documentName
        )
        if let issue = loaded.issue {
            self.storageIssues = [issue]
        }
        // An owner/repo mismatch is a reused directory, not corruption — the
        // path is keyed on `owner__repo`, so it takes a rename to get here.
        // Start clean rather than quarantine: nothing of this store's is lost.
        if let saved = loaded.value, saved.owner == owner, saved.repo == repo {
            self.manifest = saved
        } else {
            self.manifest = Manifest(owner: owner, repo: repo, branch: branch)
        }
    }

    public static func defaultDirectory(owner: String, repo: String) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("PhrenStore/\(owner)__\(repo)", isDirectory: true)
    }

    // MARK: - Manifest

    public var currentManifest: Manifest { manifest }

    private var manifestURL: URL { root.appendingPathComponent("manifest.json") }

    /// Throws on a failed write rather than reporting it: every caller here is
    /// already a throwing write path (`write`, `delete`), so a manifest that
    /// can't be persisted fails the mutation that needed it.
    public func updateManifest(_ mutate: (inout Manifest) -> Void) throws {
        mutate(&manifest)
        // Always stamped at the version we are actually writing, whatever the
        // file we loaded said — a v1 file re-serialized here is now current.
        manifest.schemaVersion = Manifest.currentSchemaVersion
        let data = try JSONEncoder().encode(manifest)
        try data.write(to: manifestURL, options: .atomic)
    }

    // MARK: - Files

    private func fileURL(_ path: String) -> URL {
        root.appendingPathComponent("files").appendingPathComponent(path)
    }

    public func read(_ path: String) -> String? {
        guard let data = try? Data(contentsOf: fileURL(path)) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ path: String, content: String, blobSha: String?) throws {
        cachedSnapshot = nil
        let url = fileURL(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(content.utf8).write(to: url, options: .atomic)
        try updateManifest { manifest in
            if let blobSha {
                manifest.blobShas[path] = blobSha
            }
        }
    }

    public func delete(_ path: String) throws {
        cachedSnapshot = nil
        try? FileManager.default.removeItem(at: fileURL(path))
        try updateManifest { $0.blobShas.removeValue(forKey: path) }
    }

    public func blobSha(for path: String) -> String? {
        manifest.blobShas[path]
    }

    public func allPaths() -> [String] {
        scanFiles().paths
    }

    /// One walk of `files/`: every regular file's relative path, plus the
    /// metadata the snapshot cache compares — fetched in the same
    /// `resourceValues` call as the regular-file check, so a cache probe costs
    /// one stat per file rather than two. `states` is nil when any file's
    /// metadata couldn't be read; the snapshot then reparses rather than trust
    /// stale data.
    private func scanFiles() -> (paths: [String], states: [FileState]?) {
        // Resolve the root once before prefix-stripping: enumerated URLs can
        // come back resolved (/private/var/…) while the stored root is the
        // unresolved alias (/var/…), and a naive substring replace mangles
        // the relative path. Each child is only resolved when its path does
        // not already carry the resolved prefix — a realpath per file was the
        // most expensive part of this walk.
        let filesRoot = root.appendingPathComponent("files").resolvingSymlinksInPath()
        let rootPrefix = filesRoot.path.hasSuffix("/") ? filesRoot.path : filesRoot.path + "/"
        let keys: Set<URLResourceKey> = [
            .isRegularFileKey, .fileResourceIdentifierKey, .contentModificationDateKey, .fileSizeKey,
        ]
        guard let enumerator = FileManager.default.enumerator(at: filesRoot, includingPropertiesForKeys: Array(keys)) else {
            return ([], nil)
        }
        var files: [FileState] = []
        var complete = true
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
            var filePath = url.path
            if !filePath.hasPrefix(rootPrefix) { filePath = url.resolvingSymlinksInPath().path }
            guard filePath.hasPrefix(rootPrefix) else { continue }
            let path = String(filePath.dropFirst(rootPrefix.count))
            if let identity = values.fileResourceIdentifier, let modified = values.contentModificationDate,
               let size = values.fileSize {
                files.append(FileState(path: path, identity: String(describing: identity), modified: modified, size: size))
            } else {
                complete = false
                files.append(FileState(path: path, identity: "", modified: .distantPast, size: -1))
            }
        }
        files.sort { $0.path < $1.path }
        return (files.map(\.path), complete ? files : nil)
    }

    public func wipe() throws {
        cachedSnapshot = nil
        try? FileManager.default.removeItem(at: root)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("files"),
                                                withIntermediateDirectories: true)
        manifest = Manifest(owner: manifest.owner, repo: manifest.repo, branch: manifest.branch)
        // The quarantined copies went with the directory, so stop telling the
        // user they're still recoverable in the app's data folder.
        storageIssues = []
    }

    // MARK: - Snapshot (parsed view for the UI)

    public struct Snapshot: Sendable {
        /// Stable while the cached files are unchanged; not persisted or synced.
        public let revision = UUID()
        public var projects: [Project]
        public var findings: [String: [Finding]]
        public var tasks: [String: TaskDoc]
        public var notes: [String: [Note]]
        public var reviewQueue: [ProjectQueueItem]
        public var summaries: [String: String]
        /// project → its pinned truths (`truths.md`). Downloaded since the
        /// first release; parsed into something as of this one.
        public var truths: [String: [Truth]] = [:]
        /// project → the date of its last consolidation, from the
        /// `<!-- consolidated: … -->` stamp in its FINDINGS.md. Present means
        /// findings have been moved to the cold tier; absent means the project
        /// has never been consolidated and nothing of it is hidden.
        public var consolidated: [String: String] = [:]
        /// Every synced skill, global and project-scoped, sorted by scope then
        /// name. Flat rather than keyed by project because `global` is not a
        /// project and the Skills UI lists both together.
        public var skills: [Skill] = []
        /// Canonical agent instructions, keyed by global/project scope.
        public var instructions: [String: String] = [:]
        /// Raw so malformed or newer settings cannot be mistaken for defaults.
        public var skillPreferencesContent: String? = nil

        public static let empty = Snapshot(projects: [], findings: [:], tasks: [:], notes: [:], reviewQueue: [], summaries: [:])
    }

    /// Reparse only after a cached file changes. Status/manifest timestamps alone
    /// do not invalidate content. Failed metadata reads never reuse stale data.
    /// Atomic writes from another LocalStore (for example an App Intent) change
    /// file identity even if byte count and modification date happen to match,
    /// which is why identity is part of the comparison.
    public func snapshot() -> Snapshot {
        let (paths, files) = scanFiles()
        if let files, let cachedSnapshot, files == cachedSnapshot.files { return cachedSnapshot.value }
        var findings: [String: [Finding]] = [:]
        var tasks: [String: TaskDoc] = [:]
        var notes: [String: [Note]] = [:]
        var summaries: [String: String] = [:]
        var truths: [String: [Truth]] = [:]
        var consolidated: [String: String] = [:]
        var queue: [ProjectQueueItem] = []
        var projectNames = Set<String>()
        var journals: [String: [JournalFile]] = [:]
        var skills: [Skill] = []
        var instructions: [String: String] = [:]

        for path in paths {
            let parts = path.split(separator: "/").map(String.init)

            // Skills come first: they are the only synced content that can sit
            // outside a project directory (`global/skills/…`), so the project
            // guard below would drop them.
            if Self.isSkillPath(path) {
                if let content = read(path), let skill = Skill.parse(path: path, content: content) {
                    skills.append(skill)
                    if case .project(let name) = skill.scope { projectNames.insert(name) }
                }
                continue
            }

            guard parts.count >= 2, Self.isReadableProjectDirName(parts[0]) else { continue }
            let project = parts[0]
            projectNames.insert(project)
            guard let content = read(path) else { continue }

            if parts.count == 2 {
                switch parts[1] {
                case "FINDINGS.md":
                    let file = FindingsFile(content: content)
                    findings[project] = file.parse()
                    // The consolidation stamp rides along in a file already
                    // parsed — the archive costs nothing to *notice*, only to
                    // read.
                    consolidated[project] = file.consolidatedDate
                case "tasks.md":
                    tasks[project] = TasksFile(project: project, content: content).doc
                case "review.md":
                    for item in ReviewFile(content: content).parse() {
                        queue.append(ProjectQueueItem(project: project, item: item))
                    }
                case "summary.md":
                    summaries[project] = content
                case "CLAUDE.md":
                    instructions[project] = content
                case "truths.md":
                    truths[project] = TruthsFile(content: content).truths
                default:
                    break
                }
            } else if parts.count == 3, parts[1] == "notes" {
                let date = String(parts[2].dropLast(3))
                let file = NotesFile(project: project, date: date, content: content)
                notes[project, default: []].append(contentsOf: file.notes)
            } else if parts.count == 3, parts[1] == JournalFile.directoryName,
                      let name = JournalFile.parseFileName(parts[2]) {
                journals[project, default: []]
                    .append(JournalFile(date: name.date, actor: name.actor, content: content))
            }
        }

        // journal.ts:184 — filenames sorted then reversed, i.e. newest
        // actor-day first. Appended after the FINDINGS.md bullets rather than
        // interleaved: every consumer groups by date anyway (the Findings tab
        // and `TopicDocument.groupedByDate` both do), and keeping the two
        // sources in blocks keeps `L…`/`J…` ids stable within each.
        for (project, files) in journals {
            var idOffset = 0
            for file in files.sorted(by: { $0.fileName > $1.fileName }) {
                let entries = file.findings(idOffset: idOffset)
                idOffset += entries.count
                findings[project, default: []].append(contentsOf: entries)
            }
        }

        // notes.ts:152 — newest first across days
        for project in notes.keys {
            notes[project]?.sort { "\($0.date)T\($0.time)" > "\($1.date)T\($1.time)" }
        }

        queue.sort(by: Self.reviewQueueOrder)

        let reviewCounts = Dictionary(grouping: queue, by: \.project).mapValues(\.count)
        let projects = projectNames.sorted().map { name in
            Project(
                name: name,
                findingCount: findings[name]?.count ?? 0,
                taskCount: tasks[name].map { $0.active.count + $0.queue.count } ?? 0,
                noteCount: notes[name]?.count ?? 0,
                reviewCount: reviewCounts[name] ?? 0
            )
        }

        // Global first, then projects alphabetically, then skill name — the
        // grouping order the Skills list renders in.
        skills.sort { left, right in
            if left.scope != right.scope {
                if case .global = left.scope { return true }
                if case .global = right.scope { return false }
                return left.scope.source < right.scope.source
            }
            return left.name.localizedStandardCompare(right.name) == .orderedAscending
        }

        let result = Snapshot(
            projects: projects, findings: findings, tasks: tasks,
            notes: notes, reviewQueue: queue, summaries: summaries,
            truths: truths, consolidated: consolidated, skills: skills, instructions: instructions,
            skillPreferencesContent: read(SkillPreferences.path)
        )
        cachedSnapshot = files.map { ($0, result) }
        return result
    }

    /// Raw material for the on-device graph. The payload builder works from the
    /// *unparsed* FINDINGS.md text because score keys are minted per bullet
    /// line, tag prefix included — reconstructing those lines from parsed
    /// `Finding` values would risk drifting from the CLI's keys.
    public func graphInput(storeName: String) -> GraphBuilder.Input {
        let snapshot = snapshot()
        var findingsMarkdown: [String: String] = [:]
        for (project, findings) in snapshot.findings {
            // Parsed findings retain their original bullet, including identity
            // tags. Journals travel separately so each source appears once.
            findingsMarkdown[project] = findings.filter { !$0.archived && !$0.isJournalEntry }
                .map { "## \($0.date)\n\($0.rawLine)" }.joined(separator: "\n")
        }

        return GraphBuilder.Input(
            findingsMarkdown: findingsMarkdown, tasks: snapshot.tasks,
            projects: snapshot.projects.map(\.name).sorted(), storeName: storeName,
            journalFindings: snapshot.findings.mapValues { $0.filter(\.isJournalEntry) }
        )
    }

    /// Resolves a graph node's score key to the FINDINGS.md bullet it was
    /// minted from. nil when the key no longer matches any line — the finding
    /// moved or was edited elsewhere — and the caller falls back to the node's
    /// displayed text.
    public func findingBulletText(project: String, scoreKey: String) -> String? {
        guard let markdown = read("\(project)/FINDINGS.md") else { return nil }
        return GraphBuilder.findBulletText(project: project, scoreKey: scoreKey, findingsMarkdown: markdown)
    }

    /// access.ts:797 — section order, then date desc, then project, then id.
    /// Shared with the app's cross-store merge so a multi-store queue sorts
    /// identically to a single-store one.
    public static func reviewQueueOrder(_ a: ProjectQueueItem, _ b: ProjectQueueItem) -> Bool {
        let sectionOrder: [QueueItem.Section: Int] = [.review: 0, .stale: 1, .conflicts: 2]
        let aDate = a.item.date == "unknown" ? "" : a.item.date
        let bDate = b.item.date == "unknown" ? "" : b.item.date
        if a.item.section != b.item.section {
            return sectionOrder[a.item.section]! < sectionOrder[b.item.section]!
        }
        if aDate != bDate { return aDate > bDate }
        if a.project != b.project { return a.project < b.project }
        return a.item.id < b.item.id
    }
}
