import Foundation

// Models mirror the TypeScript shapes in packages/cli/src 1:1 so the two
// implementations stay diffable field-by-field.

/// Mirrors `FindingLifecycleStatus` (packages/cli/src/finding/lifecycle.ts).
public enum FindingLifecycleStatus: String, Codable, CaseIterable, Sendable {
    case active
    case superseded
    case contradicted
    case stale
    case invalidCitation = "invalid_citation"
    case retracted
}

/// Mirrors `FINDING_TYPES` (packages/cli/src/phren-core.ts).
public enum FindingType: String, Codable, CaseIterable, Sendable {
    case decision, pitfall, pattern, tradeoff, architecture, bug
}

/// Mirrors `FindingCitation` (packages/cli/src/content/citation.ts).
public struct FindingCitation: Codable, Equatable, Sendable {
    public var createdAt: String
    public var repo: String?
    public var file: String?
    public var line: Int?
    public var commit: String?
    public var supersedes: String?
    public var taskItem: String?

    enum CodingKeys: String, CodingKey {
        case createdAt = "created_at"
        case repo, file, line, commit, supersedes
        case taskItem = "task_item"
    }

    public init(createdAt: String, repo: String? = nil, file: String? = nil, line: Int? = nil,
                commit: String? = nil, supersedes: String? = nil, taskItem: String? = nil) {
        self.createdAt = createdAt
        self.repo = repo
        self.file = file
        self.line = line
        self.commit = commit
        self.supersedes = supersedes
        self.taskItem = taskItem
    }
}

/// Mirrors `FindingProvenance` (packages/cli/src/content/citation.ts).
public struct FindingProvenance: Codable, Equatable, Sendable {
    public var source: String?
    public var machine: String?
    public var actor: String?
    public var tool: String?
    public var model: String?
    public var sessionId: String?
    public var scope: String?

    public init(source: String? = nil, machine: String? = nil, actor: String? = nil,
                tool: String? = nil, model: String? = nil, sessionId: String? = nil, scope: String? = nil) {
        self.source = source
        self.machine = machine
        self.actor = actor
        self.tool = tool
        self.model = model
        self.sessionId = sessionId
        self.scope = scope
    }

    public var isEmpty: Bool {
        source == nil && machine == nil && actor == nil && tool == nil
            && model == nil && sessionId == nil && scope == nil
    }
}

/// Mirrors `FindingItem` (packages/cli/src/data/access.ts).
public struct Finding: Codable, Equatable, Identifiable, Sendable {
    /// Positional ID recomputed on every read (`L1`, `L2`, ...).
    public var id: String
    /// Stable 8-char hex ID embedded as `<!-- fid:XXXXXXXX -->`.
    public var stableId: String?
    public var date: String
    public var text: String
    public var citation: String?
    public var citationData: FindingCitation?
    public var taskItem: String?
    public var confidence: Double?
    public var scope: String?
    public var machine: String?
    public var actor: String?
    public var supersededBy: String?
    public var supersedes: String?
    public var contradicts: [String]?
    public var status: FindingLifecycleStatus
    public var statusUpdated: String?
    public var statusReason: String?
    public var statusRef: String?
    public var archived: Bool
    /// The type tag parsed from a leading `[tag]` prefix, when present.
    public var typeTag: String?

    /// Raw markdown line this finding was parsed from (mutation key).
    public var rawLine: String

    /// The `journal/YYYY-MM-DD-<actor>.md` this entry came from, or nil for
    /// the `FINDINGS.md` bullets that make up every other finding.
    ///
    /// The one field here with no counterpart in `FindingItem`: the CLI keeps
    /// a journal entry's file/date/actor in the separate tuple
    /// `readTeamJournalEntries` returns (journal.ts:178) and never merges the
    /// two shapes. The app does merge them — one Findings list, whatever the
    /// store's role — so it has to carry the provenance the CLI keeps
    /// alongside. It is also the read-only flag: the CLI's `edit_finding` and
    /// `remove_finding` splice `FINDINGS.md` in every store, journal or not,
    /// so an edit offered here could only ever fail.
    public var journalFile: String?

    /// Append-only by construction: nothing on either side rewrites a journal
    /// line in place.
    public var isJournalEntry: Bool { journalFile != nil }
}

/// Mirrors `QueueItem` (packages/cli/src/data/access.ts).
public struct QueueItem: Codable, Equatable, Identifiable, Sendable {
    public enum Section: String, Codable, CaseIterable, Sendable {
        case review = "Review"
        case stale = "Stale"
        case conflicts = "Conflicts"
    }

    public var id: String
    public var section: Section
    public var date: String
    public var text: String
    /// The raw markdown line — the mutation key for approve/reject/edit.
    public var line: String
    public var confidence: Double?
    public var risky: Bool
    public var machine: String?
    public var model: String?
}

/// Mirrors `ProjectQueueItem` (packages/cli/src/data/access.ts).
public struct ProjectQueueItem: Codable, Equatable, Identifiable, Sendable {
    public var project: String
    public var item: QueueItem
    public var id: String { "\(project)/\(item.id)/\(item.line)" }
}

/// A pinned truth from a project's `truths.md`: high-confidence memory the
/// CLI always injects and never decays (tools/memory.ts:52 `get_truths`).
///
/// The CLI has no struct for this — `get_truths` returns bare strings — so
/// this is the app's shape rather than a transcription. `text` is the pinned
/// memory with phren's own `_(added …)_` bookkeeping lifted out into
/// `addedDate`; see ``TruthsFile``.
public struct Truth: Codable, Equatable, Identifiable, Sendable {
    public var text: String
    public var addedDate: String?
    /// Content-addressed: `truths.md` carries no stable ids, and the text is
    /// what `upsertCanonical` dedups on anyway.
    public var id: String { text }

    public init(text: String, addedDate: String?) {
        self.text = text
        self.addedDate = addedDate
    }
}

/// Mirrors `NoteItem` (packages/cli/src/data/notes.ts).
public struct Note: Codable, Equatable, Identifiable, Sendable {
    /// `nid:xxxxxxxx`
    public var id: String
    public var stableId: String
    public var project: String
    public var date: String
    /// Always normalized to `HH:MM:SS` on parse.
    public var time: String
    public var text: String
    public var promoted: Bool
}

/// Mirrors `TaskItem` (packages/cli/src/data/tasks.ts).
public struct PhrenTask: Codable, Equatable, Identifiable, Sendable {
    public enum Section: String, Codable, CaseIterable, Sendable {
        case active = "Active"
        case queue = "Queue"
        case done = "Done"
    }
    public enum Priority: String, Codable, CaseIterable, Sendable {
        case high, medium, low
    }

    /// Positional ID (`A1`, `Q3`, `D2`) recomputed on every read.
    public var id: String
    /// Stable 8-char hex ID embedded as `<!-- bid:XXXXXXXX -->`.
    public var stableId: String?
    public var section: Section
    /// Clean task text with the bid comment stripped.
    public var line: String
    public var checked: Bool
    public var priority: Priority?
    public var context: String?
    public var pinned: Bool?
    public var githubIssue: Int?
    public var githubUrl: String?
    public var rank: Int?
    public var lastActivity: String?
    public var createdAt: String?
    public var sessionId: String?
    public var scope: String?
    public var childFindings: [String]?
    public var speculative: Bool?
    public var parentFinding: String?
}

/// Mirrors `TaskDoc` (packages/cli/src/data/tasks.ts).
public struct TaskDoc: Codable, Equatable, Sendable {
    public var project: String
    public var title: String
    public var active: [PhrenTask]
    public var queue: [PhrenTask]
    public var done: [PhrenTask]

    public func items(in section: PhrenTask.Section) -> [PhrenTask] {
        switch section {
        case .active: return active
        case .queue: return queue
        case .done: return done
        }
    }

    public var allItems: [PhrenTask] { active + queue + done }
}

/// A project in the store: a top-level directory with markdown files.
public struct Project: Codable, Equatable, Identifiable, Sendable {
    public var name: String
    public var findingCount: Int
    public var taskCount: Int
    public var noteCount: Int
    public var reviewCount: Int
    /// Findings the CLI archived into topic files, as summary.md reports them.
    public var archivedCount: Int
    public var id: String { name }
    /// Everything the project knows: live findings plus the archive.
    public var totalFindingCount: Int { findingCount + archivedCount }

    public init(name: String, findingCount: Int = 0, taskCount: Int = 0, noteCount: Int = 0, reviewCount: Int = 0, archivedCount: Int = 0) {
        self.name = name
        self.findingCount = findingCount
        self.taskCount = taskCount
        self.noteCount = noteCount
        self.reviewCount = reviewCount
        self.archivedCount = archivedCount
    }

    private enum CodingKeys: String, CodingKey { case name, findingCount, taskCount, noteCount, reviewCount, archivedCount }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        findingCount = try c.decode(Int.self, forKey: .findingCount)
        taskCount = try c.decode(Int.self, forKey: .taskCount)
        noteCount = try c.decode(Int.self, forKey: .noteCount)
        reviewCount = try c.decode(Int.self, forKey: .reviewCount)
        // Snapshots cached by older builds have no archive count.
        archivedCount = try c.decodeIfPresent(Int.self, forKey: .archivedCount) ?? 0
    }
}

public enum PhrenKitError: Error, LocalizedError, Equatable {
    case emptyInput(String)
    case notFound(String)
    case ambiguousMatch(String)
    case validation(String)
    case archivedReadOnly(String)
    case secretDetected(String)
    case duplicate(String)

    public var errorDescription: String? {
        switch self {
        case .emptyInput(let m), .notFound(let m), .ambiguousMatch(let m),
             .validation(let m), .archivedReadOnly(let m), .secretDetected(let m),
             .duplicate(let m):
            return m
        }
    }
}
/// A skill file surfaced in the app. Mirrors `SkillEntry`
/// (packages/cli/src/skill/registry.ts:8), minus the fields that only mean
/// something to the local resolver (`enabled`, `aliases`, `command`) — those
/// come from `.config/` and profile state the app does not sync.
public struct Skill: Identifiable, Equatable, Sendable {
    public enum Scope: Equatable, Sendable {
        case global
        case project(String)

        /// `SkillEntry.source` — "global" or the project name.
        public var source: String {
            switch self {
            case .global: return "global"
            case .project(let name): return name
            }
        }
    }

    /// `SkillEntry.format` — a flat `<name>.md` or a folder `<name>/SKILL.md`.
    public enum Format: String, Equatable, Sendable {
        case flat, folder
    }

    /// Repo-relative path, which is also the identity.
    public var path: String
    public var name: String
    public var scope: Scope
    public var format: Format
    public var title: String?
    public var summary: String?
    public var content: String

    public var id: String { path }

    public init(path: String, name: String, scope: Scope, format: Format,
                title: String? = nil, summary: String? = nil, content: String) {
        self.path = path
        self.name = name
        self.scope = scope
        self.format = format
        self.title = title
        self.summary = summary
        self.content = content
    }

    /// Parses a synced file into a skill, deriving name/format from the path
    /// exactly as `collectSkills` derives them from the directory entry.
    public static func parse(path: String, content: String) -> Skill? {
        let parts = path.split(separator: "/").map(String.init)
        // <scope>/skills/<name>.md  or  <scope>/skills/<name>/SKILL.md
        guard parts.count >= 3, parts[1] == "skills" else { return nil }
        let scope: Scope = parts[0] == "global" ? .global : .project(parts[0])

        let name: String
        let format: Format
        if parts.count == 3, parts[2].hasSuffix(".md") {
            name = String(parts[2].dropLast(3))
            format = .flat
        } else if parts.count == 4, parts[3] == "SKILL.md" {
            name = parts[2]
            format = .folder
        } else {
            return nil
        }

        let (frontmatter, _) = SkillFile.parseFrontmatter(content)
        return Skill(
            path: path, name: name, scope: scope, format: format,
            title: frontmatter?["name"], summary: frontmatter?["description"],
            content: content
        )
    }
}
