package com.phren.kit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Models mirror the TypeScript shapes in packages/cli/src 1:1 (by way of
// apps/ios/PhrenKit/Sources/PhrenKit/Models/Models.swift) so the three
// implementations stay diffable field-by-field.

/** Mirrors `FindingLifecycleStatus` (packages/cli/src/finding/lifecycle.ts). */
@Serializable
enum class FindingLifecycleStatus(val rawValue: String) {
    @SerialName("active") ACTIVE("active"),
    @SerialName("superseded") SUPERSEDED("superseded"),
    @SerialName("contradicted") CONTRADICTED("contradicted"),
    @SerialName("stale") STALE("stale"),
    @SerialName("invalid_citation") INVALID_CITATION("invalid_citation"),
    @SerialName("retracted") RETRACTED("retracted");

    companion object {
        fun from(raw: String?): FindingLifecycleStatus? = entries.firstOrNull { it.rawValue == raw }
    }
}

/** Mirrors `FINDING_TYPES` (packages/cli/src/phren-core.ts). */
enum class FindingType(val rawValue: String) {
    DECISION("decision"), PITFALL("pitfall"), PATTERN("pattern"),
    TRADEOFF("tradeoff"), ARCHITECTURE("architecture"), BUG("bug");
}

/** Mirrors `FindingCitation` (packages/cli/src/content/citation.ts). */
@Serializable
data class FindingCitation(
    @SerialName("created_at") val createdAt: String,
    val repo: String? = null,
    val file: String? = null,
    val line: Int? = null,
    val commit: String? = null,
    val supersedes: String? = null,
    @SerialName("task_item") val taskItem: String? = null,
)

/** Mirrors `FindingProvenance` (packages/cli/src/content/citation.ts). */
@Serializable
data class FindingProvenance(
    val source: String? = null,
    val machine: String? = null,
    val actor: String? = null,
    val tool: String? = null,
    val model: String? = null,
    val sessionId: String? = null,
    val scope: String? = null,
) {
    val isEmpty: Boolean
        get() = source == null && machine == null && actor == null && tool == null &&
            model == null && sessionId == null && scope == null
}

/** Mirrors `FindingItem` (packages/cli/src/data/access.ts). */
@Serializable
data class Finding(
    /** Positional ID recomputed on every read (`L1`, `L2`, ...). */
    val id: String,
    /** Stable 8-char hex ID embedded as `<!-- fid:XXXXXXXX -->`. */
    val stableId: String? = null,
    val date: String,
    val text: String,
    val citation: String? = null,
    val citationData: FindingCitation? = null,
    val taskItem: String? = null,
    val confidence: Double? = null,
    val scope: String? = null,
    val machine: String? = null,
    val actor: String? = null,
    val supersededBy: String? = null,
    val supersedes: String? = null,
    val contradicts: List<String>? = null,
    val status: FindingLifecycleStatus = FindingLifecycleStatus.ACTIVE,
    val statusUpdated: String? = null,
    val statusReason: String? = null,
    val statusRef: String? = null,
    val archived: Boolean = false,
    /** The type tag parsed from a leading `[tag]` prefix, when present. */
    val typeTag: String? = null,
    /** Raw markdown line this finding was parsed from (mutation key). */
    val rawLine: String,
    /**
     * The `journal/YYYY-MM-DD-<actor>.md` this entry came from, or null for the
     * `FINDINGS.md` bullets. Also the read-only flag: the CLI's edit/remove
     * splice `FINDINGS.md` in every store, so an edit offered here would fail.
     */
    val journalFile: String? = null,
) {
    /** Append-only by construction: nothing rewrites a journal line in place. */
    val isJournalEntry: Boolean get() = journalFile != null
}

/** Mirrors `QueueItem` (packages/cli/src/data/access.ts). */
@Serializable
data class QueueItem(
    val id: String,
    val section: Section,
    val date: String,
    val text: String,
    /** The raw markdown line: the mutation key for approve/reject/edit. */
    val line: String,
    val confidence: Double? = null,
    val risky: Boolean = false,
    val machine: String? = null,
    val model: String? = null,
) {
    @Serializable
    enum class Section(val rawValue: String) {
        @SerialName("Review") REVIEW("Review"),
        @SerialName("Stale") STALE("Stale"),
        @SerialName("Conflicts") CONFLICTS("Conflicts");

        companion object {
            fun from(raw: String): Section? = entries.firstOrNull { it.rawValue == raw }
        }
    }
}

/** Mirrors `ProjectQueueItem` (packages/cli/src/data/access.ts). */
@Serializable
data class ProjectQueueItem(val project: String, val item: QueueItem) {
    val id: String get() = "$project/${item.id}/${item.line}"
}

/**
 * A pinned truth from a project's `truths.md` (tools/memory.ts `get_truths`).
 * `text` has phren's own `_(added …)_` bookkeeping lifted into [addedDate].
 */
@Serializable
data class Truth(val text: String, val addedDate: String? = null) {
    /** Content-addressed: `truths.md` carries no stable ids. */
    val id: String get() = text
}

/** Mirrors `NoteItem` (packages/cli/src/data/notes.ts). */
@Serializable
data class Note(
    /** `nid:xxxxxxxx` */
    val id: String,
    val stableId: String,
    val project: String,
    val date: String,
    /** Always normalized to `HH:MM:SS` on parse. */
    val time: String,
    val text: String,
    val promoted: Boolean,
)

/** Mirrors `TaskItem` (packages/cli/src/data/tasks.ts). */
@Serializable
data class PhrenTask(
    /** Positional ID (`A1`, `Q3`, `D2`) recomputed on every read. */
    val id: String,
    /** Stable 8-char hex ID embedded as `<!-- bid:XXXXXXXX -->`. */
    val stableId: String? = null,
    val section: Section,
    /** Clean task text with the bid comment stripped. */
    val line: String,
    val checked: Boolean,
    val priority: Priority? = null,
    val context: String? = null,
    val pinned: Boolean? = null,
    val githubIssue: Int? = null,
    val githubUrl: String? = null,
    val rank: Int? = null,
    val lastActivity: String? = null,
    val createdAt: String? = null,
    val sessionId: String? = null,
    val scope: String? = null,
    val childFindings: List<String>? = null,
    val speculative: Boolean? = null,
    val parentFinding: String? = null,
) {
    @Serializable
    enum class Section(val rawValue: String) {
        @SerialName("Active") ACTIVE("Active"),
        @SerialName("Queue") QUEUE("Queue"),
        @SerialName("Done") DONE("Done");

        companion object {
            fun from(raw: String): Section? = entries.firstOrNull { it.rawValue == raw }
        }
    }

    @Serializable
    enum class Priority(val rawValue: String) {
        @SerialName("high") HIGH("high"),
        @SerialName("medium") MEDIUM("medium"),
        @SerialName("low") LOW("low");

        companion object {
            fun from(raw: String?): Priority? = entries.firstOrNull { it.rawValue == raw }
        }
    }
}

/** Mirrors `TaskDoc` (packages/cli/src/data/tasks.ts). */
@Serializable
data class TaskDoc(
    val project: String,
    val title: String,
    val active: List<PhrenTask>,
    val queue: List<PhrenTask>,
    val done: List<PhrenTask>,
) {
    fun items(section: PhrenTask.Section): List<PhrenTask> = when (section) {
        PhrenTask.Section.ACTIVE -> active
        PhrenTask.Section.QUEUE -> queue
        PhrenTask.Section.DONE -> done
    }

    val allItems: List<PhrenTask> get() = active + queue + done
}

/** A project in the store: a top-level directory with markdown files. */
@Serializable
data class Project(
    val name: String,
    val findingCount: Int = 0,
    val taskCount: Int = 0,
    val noteCount: Int = 0,
    val reviewCount: Int = 0,
    /** Findings the CLI archived to reference/topics, per summary.md. */
    val archivedCount: Int = 0,
) {
    val id: String get() = name
    val totalFindingCount: Int get() = findingCount + archivedCount
}

sealed class PhrenKitError(override val message: String) : Exception(message) {
    class EmptyInput(m: String) : PhrenKitError(m)
    class NotFound(m: String) : PhrenKitError(m)
    class AmbiguousMatch(m: String) : PhrenKitError(m)
    class Validation(m: String) : PhrenKitError(m)
    class ArchivedReadOnly(m: String) : PhrenKitError(m)
    class SecretDetected(m: String) : PhrenKitError(m)
    class Duplicate(m: String) : PhrenKitError(m)

    override fun equals(other: Any?): Boolean =
        other is PhrenKitError && other::class == this::class && other.message == message

    override fun hashCode(): Int = 31 * this::class.hashCode() + message.hashCode()
}
