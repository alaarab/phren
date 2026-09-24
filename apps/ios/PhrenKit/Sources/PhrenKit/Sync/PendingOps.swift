import Foundation

/// A user mutation, expressed as a domain operation rather than a file diff so
/// it can be re-applied onto fresh content after a remote change (the
/// refetch-reapply half of sha-conflict recovery).
///
/// **Persisted.** This enum is written into `pending-ops.json` and is the
/// single most breakage-prone type in the app: adding a case makes queues
/// written by the new build unreadable to every older build, and renaming one
/// makes queues written by *older* builds unreadable here. Either is a schema
/// break — see the contract on ``VersionedDocument``, and bump
/// ``PendingOpsQueue/currentSchemaVersion`` when you take one.
public enum PendingOp: Codable, Equatable, Sendable {
    case addFinding(project: String, text: String, type: String?)
    case editFinding(project: String, match: String, newText: String)
    case removeFinding(project: String, match: String)
    case approveQueue(project: String, line: String)
    case rejectQueue(project: String, line: String)
    case editQueue(project: String, line: String, newText: String)
    case addNote(project: String, date: String, time: String, text: String)
    case editNote(project: String, date: String, stableId: String, text: String)
    case removeNote(project: String, date: String, stableId: String)
    case promoteNote(project: String, date: String, stableId: String, findingType: String?)
    case addTask(project: String, text: String)
    case completeTask(project: String, match: String)
    case removeTask(project: String, match: String)
    case updateTask(project: String, match: String, text: String?, priority: String?, section: String?)
    /// Whole-file write of a skill (creates the file when it does not exist).
    /// Skills carry no line grammar, so the op stores the finished bytes rather
    /// than a diff — which also makes its postcondition exactly checkable.
    case updateSkill(path: String, content: String)
    case deleteSkill(path: String)
    case saveAuthoredFile(path: String, content: String, expectedContent: String?)
    case deleteAuthoredFile(path: String, expectedContent: String)
    case setSkillEnabled(scope: String, name: String, enabled: Bool, expectedEnabled: Bool?)
    /// Rewrites the five knobs in `<project>/phren.project.yaml`, leaving every
    /// sibling key (and any nested retention/workflow block) byte for byte.
    /// The op carries the full desired knob state rather than a diff so it can
    /// be re-applied onto fresh content after a remote change.
    case setProjectKnobs(project: String, knobs: ProjectKnobs, expectedContent: String?)
    /// Replaces `<project>/schedules.yaml` with bytes rendered from the
    /// editor's complete list. The expected bytes protect top-level keys a
    /// newer CLI may have added since the editor opened the file.
    case saveSchedules(project: String, content: String, expectedContent: String?)

    public var project: String {
        switch self {
        case .setSkillEnabled(let scope, _, _, _): return scope
        case .setProjectKnobs(let p, _, _): return p
        case .saveSchedules(let p, _, _): return p
        case .addFinding(let p, _, _), .editFinding(let p, _, _), .removeFinding(let p, _),
             .approveQueue(let p, _), .rejectQueue(let p, _), .editQueue(let p, _, _),
             .addNote(let p, _, _, _), .editNote(let p, _, _, _), .removeNote(let p, _, _),
             .promoteNote(let p, _, _, _),
             .addTask(let p, _), .completeTask(let p, _), .removeTask(let p, _),
             .updateTask(let p, _, _, _, _):
            return p
        case .updateSkill(let path, _), .deleteSkill(let path),
             .saveAuthoredFile(let path, _, _), .deleteAuthoredFile(let path, _):
            // "global" for a global skill — not a project, but the correct
            // commit-message scope, and the only place this value is read for
            // skill ops.
            return path.split(separator: "/").first.map(String.init) ?? "global"
        }
    }

    /// The `(kind)` token of the commit message — the session-stop hook's
    /// vocabulary (cli/session-stop.ts:354-378).
    public var commitKind: String {
        switch self {
        case .addFinding, .editFinding, .removeFinding: return "findings"
        case .approveQueue, .rejectQueue, .editQueue: return "update"
        case .addNote, .editNote, .removeNote, .promoteNote: return "update"
        case .addTask, .completeTask, .removeTask, .updateTask: return "task"
        case .updateSkill, .deleteSkill, .setSkillEnabled: return "skills"
        case .setProjectKnobs, .saveSchedules: return "update"
        case .saveAuthoredFile(let path, _, _), .deleteAuthoredFile(let path, _):
            return LocalStore.isSkillPath(path) ? "skills" : "update"
        }
    }

    /// Commit-message summary following the session-stop hook convention
    /// (`phren: <project>(findings)` — cli/session-stop.ts:354-378), suffixed
    /// with the app as the writing tool.
    public var commitMessage: String {
        "phren: \(project)(\(commitKind)) via ios"
    }

    /// Commit summary for a coalesced group of ops sharing one commit. A
    /// single op keeps the plain shape; a batch aggregates per project (in
    /// first-seen order) with per-kind counts, matching the session-stop
    /// hook's multi-project shape: a 12-item approve reads
    /// `phren: myproj(update x12) via ios`, and a cross-project batch reads
    /// `phren: proja(update x3) projb(update x2,task) via ios`.
    public static func commitMessage(for ops: [PendingOp]) -> String {
        guard let first = ops.first else { return "phren: sync via ios" }
        guard ops.count > 1 else { return first.commitMessage }

        var projectOrder: [String] = []
        var kindOrder: [String: [String]] = [:]
        var counts: [String: [String: Int]] = [:]
        for op in ops {
            if counts[op.project] == nil {
                projectOrder.append(op.project)
                kindOrder[op.project] = []
                counts[op.project] = [:]
            }
            if counts[op.project]?[op.commitKind] == nil {
                kindOrder[op.project]?.append(op.commitKind)
            }
            counts[op.project]?[op.commitKind, default: 0] += 1
        }

        let segments = projectOrder.map { project -> String in
            let kinds = (kindOrder[project] ?? []).map { kind -> String in
                let count = counts[project]?[kind] ?? 0
                return count > 1 ? "\(kind) x\(count)" : kind
            }
            return "\(project)(\(kinds.joined(separator: ",")))"
        }
        return "phren: \(segments.joined(separator: " ")) via ios"
    }

    /// The document this op owns. Ops that also touch a second file
    /// (reject/edit mirror into FINDINGS.md, promote writes both) are still
    /// identified by the file their domain operation addresses. The flush
    /// plan uses this to write secondary files before primaries; it is also
    /// the writability probe for `enqueue`.
    public var primaryPath: String {
        switch self {
        case .setSkillEnabled: return SkillPreferences.path
        case .setProjectKnobs(let project, _, _):
            return "\(project)/\(MachineRegistry.projectFile)"
        case .saveSchedules(let project, _, _):
            return "\(project)/\(SchedulesFile.fileName)"
        case .addFinding, .editFinding, .removeFinding:
            return "\(project)/FINDINGS.md"
        case .approveQueue, .rejectQueue, .editQueue:
            return "\(project)/review.md"
        case .addNote(_, let date, _, _), .editNote(_, let date, _, _),
             .removeNote(_, let date, _), .promoteNote(_, let date, _, _):
            return "\(project)/notes/\(date).md"
        case .addTask, .completeTask, .removeTask, .updateTask:
            return "\(project)/tasks.md"
        case .updateSkill(let path, _), .deleteSkill(let path),
             .saveAuthoredFile(let path, _, _), .deleteAuthoredFile(let path, _):
            return path
        }
    }

    /// Every file the op can write, in the order `SyncEngine.computeEdits`
    /// emits them. Only a fallback: the engine records the paths an op
    /// actually edited when it applies it, and queue entries written by an
    /// older build have none.
    public var editablePaths: [String] {
        switch self {
        case .rejectQueue, .editQueue:
            return [primaryPath, "\(project)/FINDINGS.md"]
        case .promoteNote:
            return ["\(project)/FINDINGS.md", primaryPath]
        default:
            return [primaryPath]
        }
    }

    /// A short human label for the pending/failed ops UI.
    public var label: String {
        switch self {
        case .addFinding(_, let text, _): return "Add finding: \(text.prefix(60))"
        case .editFinding: return "Edit finding"
        case .removeFinding: return "Delete finding"
        case .approveQueue: return "Approve review item"
        case .rejectQueue: return "Reject review item"
        case .editQueue: return "Edit review item"
        case .addNote(_, _, _, let text): return "Add note: \(text.prefix(60))"
        case .editNote: return "Edit note"
        case .removeNote: return "Delete note"
        case .promoteNote: return "Promote note to finding"
        case .addTask(_, let text): return "Add task: \(text.prefix(60))"
        case .completeTask: return "Complete task"
        case .removeTask: return "Delete task"
        case .updateTask: return "Update task"
        case .updateSkill(let path, _): return "Save skill: \(Self.skillLabel(path))"
        case .deleteSkill(let path): return "Delete skill: \(Self.skillLabel(path))"
        case .saveAuthoredFile(let path, _, _): return "Save: \(path)"
        case .deleteAuthoredFile(let path, _): return "Delete: \(path)"
        case .setSkillEnabled(let scope, let name, let enabled, _):
            return "\(enabled ? "Enable" : "Disable") skill: \(scope)/\(name)"
        case .setProjectKnobs: return "Update project knobs"
        case .saveSchedules: return "Save schedules"
        }
    }

    /// `<scope>/skills/<name>.md` and `<scope>/skills/<name>/SKILL.md` both
    /// label as `<scope>/<name>`.
    private static func skillLabel(_ path: String) -> String {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 3 else { return path }
        let name = parts.count == 4 ? parts[2] : String(parts[2].dropLast(3))
        return "\(parts[0])/\(name)"
    }
}

/// **Persisted** inside `pending-ops.json`. Every field added since the first
/// release is optional on purpose — see the contract on ``VersionedDocument``.
public struct QueuedOp: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let op: PendingOp
    public let queuedAt: Date
    public var attempts: Int
    public var lastError: String?
    /// Repo paths this op actually edited when it was applied to the local
    /// cache, in edit order. The flush pushes exactly these files, so a
    /// tolerated no-op (a reject whose finding was already gone) never sends
    /// an unchanged file. Nil for entries persisted before this was recorded —
    /// `editedPaths` then falls back to the op's static shape.
    public var paths: [String]?
    /// Blob SHAs of files the op deleted locally, captured before the delete:
    /// `LocalStore.delete` drops the manifest entry, so the remote DELETE
    /// would otherwise have no sha to send.
    public var deletedShas: [String: String]?

    public init(op: PendingOp) {
        self.id = UUID()
        self.op = op
        self.queuedAt = Date()
        self.attempts = 0
    }

    /// Files the flush must push for this op.
    public var editedPaths: [String] {
        paths ?? op.editablePaths
    }
}

/// FIFO durable queue persisted next to the manifest.
///
/// **This file is user data, not a cache.** It holds mutations that exist
/// nowhere else until a flush reaches GitHub, so it is never discarded on a
/// bad read — see the contract on ``VersionedDocument`` before changing this
/// type or ``PendingOp``.
public struct PendingOpsQueue: Codable, Sendable, VersionedDocument {
    /// Version 3 adds per-skill settings, version 4 adds per-project knobs, and
    /// version 5 adds scheduled prompts. All legacy operations remain decodable.
    public static let currentSchemaVersion = 5

    public var schemaVersion: Int = PendingOpsQueue.currentSchemaVersion
    public var pending: [QueuedOp] = []
    /// Ops that failed permanently (ambiguous / not-found after a remote
    /// change) — surfaced in Settings as "needs attention".
    public var failed: [QueuedOp] = []

    /// What the user calls this file when it goes wrong.
    static let documentName = "unsynced changes"

    public init() {}

    enum CodingKeys: String, CodingKey {
        case schemaVersion, pending, failed
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Absent in every queue written before versioning existed. That shape
        // is version 1, and it has to keep decoding forever.
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion)
            ?? Self.initialSchemaVersion
        pending = try container.decodeIfPresent([QueuedOp].self, forKey: .pending) ?? []
        failed = try container.decodeIfPresent([QueuedOp].self, forKey: .failed) ?? []
    }

    /// Reads the queue, reporting rather than dropping anything unreadable:
    /// a file that can't be decoded is moved aside by ``PersistedState`` and
    /// the caller starts empty from there, with an issue to show the user.
    static func load(from url: URL) -> (queue: PendingOpsQueue, issue: StorageIssue?) {
        let result = PersistedState.load(PendingOpsQueue.self, from: url, document: documentName)
        var queue = result.value ?? PendingOpsQueue()
        queue.schemaVersion = Self.currentSchemaVersion
        return (queue, result.issue)
    }

    /// Returns the failure instead of swallowing it — a queue that can't be
    /// written is offline work that dies when the app is killed, and the user
    /// gets to know that before it happens.
    @discardableResult
    func save(to url: URL) -> StorageIssue? {
        PersistedState.save(self, to: url, document: Self.documentName)
    }
}
