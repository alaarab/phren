package com.phren.kit

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import java.io.File
import java.time.Instant
import java.util.UUID

/** ISO-8601 instant on disk. */
object InstantSerializer : KSerializer<Instant> {
    override val descriptor = PrimitiveSerialDescriptor("Instant", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())
    override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}

/**
 * A user mutation, expressed as a domain operation rather than a file diff so
 * it can be re-applied onto fresh content after a remote change (port of
 * PendingOps.swift).
 *
 * **Persisted** in `pending-ops.json` and the most breakage-prone type in the
 * app: adding a subclass makes queues written by the new build unreadable to
 * older ones. See [VersionedDocument]; bump [PendingOpsQueue.CURRENT_SCHEMA_VERSION].
 */
@Serializable
sealed class PendingOp {
    abstract val project: String

    @Serializable @SerialName("addFinding")
    data class AddFinding(override val project: String, val text: String, val type: String? = null) : PendingOp()

    @Serializable @SerialName("editFinding")
    data class EditFinding(override val project: String, val match: String, val newText: String) : PendingOp()

    @Serializable @SerialName("removeFinding")
    data class RemoveFinding(override val project: String, val match: String) : PendingOp()

    @Serializable @SerialName("approveQueue")
    data class ApproveQueue(override val project: String, val line: String) : PendingOp()

    @Serializable @SerialName("rejectQueue")
    data class RejectQueue(override val project: String, val line: String) : PendingOp()

    @Serializable @SerialName("editQueue")
    data class EditQueue(override val project: String, val line: String, val newText: String) : PendingOp()

    @Serializable @SerialName("addNote")
    data class AddNote(override val project: String, val date: String, val time: String, val text: String) : PendingOp()

    @Serializable @SerialName("editNote")
    data class EditNote(override val project: String, val date: String, val stableId: String, val text: String) : PendingOp()

    @Serializable @SerialName("removeNote")
    data class RemoveNote(override val project: String, val date: String, val stableId: String) : PendingOp()

    @Serializable @SerialName("promoteNote")
    data class PromoteNote(override val project: String, val date: String, val stableId: String, val findingType: String? = null) : PendingOp()

    @Serializable @SerialName("addTask")
    data class AddTask(override val project: String, val text: String) : PendingOp()

    @Serializable @SerialName("completeTask")
    data class CompleteTask(override val project: String, val match: String) : PendingOp()

    @Serializable @SerialName("removeTask")
    data class RemoveTask(override val project: String, val match: String) : PendingOp()

    @Serializable @SerialName("updateTask")
    data class UpdateTask(
        override val project: String,
        val match: String,
        val text: String? = null,
        val priority: String? = null,
        val section: String? = null,
    ) : PendingOp()

    @Serializable @SerialName("updateSkill")
    data class UpdateSkill(val path: String, val content: String) : PendingOp() { override val project get() = scopeOf(path) }

    @Serializable @SerialName("deleteSkill")
    data class DeleteSkill(val path: String) : PendingOp() { override val project get() = scopeOf(path) }

    @Serializable @SerialName("saveAuthoredFile")
    data class SaveAuthoredFile(val path: String, val content: String, val expectedContent: String? = null) : PendingOp() { override val project get() = scopeOf(path) }

    @Serializable @SerialName("deleteAuthoredFile")
    data class DeleteAuthoredFile(val path: String, val expectedContent: String) : PendingOp() { override val project get() = scopeOf(path) }

    @Serializable @SerialName("setSkillEnabled")
    data class SetSkillEnabled(val scope: String, val name: String, val enabled: Boolean, val expectedEnabled: Boolean? = null) : PendingOp() { override val project get() = scope }

    @Serializable @SerialName("setProjectKnobs")
    data class SetProjectKnobs(override val project: String, val knobs: ProjectKnobs, val expectedContent: String? = null) : PendingOp()

    @Serializable @SerialName("saveSchedules")
    data class SaveSchedules(override val project: String, val content: String, val expectedContent: String? = null) : PendingOp()

    /** The `(kind)` token of the commit message (cli/session-stop.ts:354-378). */
    val commitKind: String
        get() = when (this) {
            is AddFinding, is EditFinding, is RemoveFinding -> "findings"
            is ApproveQueue, is RejectQueue, is EditQueue -> "update"
            is AddNote, is EditNote, is RemoveNote, is PromoteNote -> "update"
            is AddTask, is CompleteTask, is RemoveTask, is UpdateTask -> "task"
            is UpdateSkill, is DeleteSkill, is SetSkillEnabled -> "skills"
            is SetProjectKnobs, is SaveSchedules -> "update"
            is SaveAuthoredFile -> if (LocalStore.isSkillPath(path)) "skills" else "update"
            is DeleteAuthoredFile -> if (LocalStore.isSkillPath(path)) "skills" else "update"
        }

    val commitMessage: String get() = "phren: $project($commitKind) via $COMMIT_TOOL"

    /** The document this op owns; also the writability probe for `enqueue`. */
    val primaryPath: String
        get() = when (this) {
            is AddFinding, is EditFinding, is RemoveFinding -> "$project/FINDINGS.md"
            is ApproveQueue, is RejectQueue, is EditQueue -> "$project/review.md"
            is AddNote -> "$project/notes/$date.md"
            is EditNote -> "$project/notes/$date.md"
            is RemoveNote -> "$project/notes/$date.md"
            is PromoteNote -> "$project/notes/$date.md"
            is AddTask, is CompleteTask, is RemoveTask, is UpdateTask -> "$project/tasks.md"
            is SetSkillEnabled -> SkillPreferences.PATH
            is SetProjectKnobs -> "$project/${MachineRegistry.PROJECT_FILE}"
            is SaveSchedules -> "$project/${SchedulesFile.FILE_NAME}"
            is UpdateSkill -> path
            is DeleteSkill -> path
            is SaveAuthoredFile -> path
            is DeleteAuthoredFile -> path
        }

    /** Every file the op can write, in the order `computeEdits` emits them (fallback only). */
    val editablePaths: List<String>
        get() = when (this) {
            is RejectQueue, is EditQueue -> listOf(primaryPath, "$project/FINDINGS.md")
            is PromoteNote -> listOf("$project/FINDINGS.md", primaryPath)
            else -> listOf(primaryPath)
        }

    /** A short human label for the pending/failed ops UI. */
    val label: String
        get() = when (this) {
            is AddFinding -> "Add finding: ${text.take(60)}"
            is EditFinding -> "Edit finding"
            is RemoveFinding -> "Delete finding"
            is ApproveQueue -> "Approve review item"
            is RejectQueue -> "Reject review item"
            is EditQueue -> "Edit review item"
            is AddNote -> "Add note: ${text.take(60)}"
            is EditNote -> "Edit note"
            is RemoveNote -> "Delete note"
            is PromoteNote -> "Promote note to finding"
            is AddTask -> "Add task: ${text.take(60)}"
            is CompleteTask -> "Complete task"
            is RemoveTask -> "Delete task"
            is UpdateTask -> "Update task"
            is UpdateSkill -> "Save skill: ${skillLabel(path)}"
            is DeleteSkill -> "Delete skill: ${skillLabel(path)}"
            is SaveAuthoredFile -> "Save: $path"
            is DeleteAuthoredFile -> "Delete: $path"
            is SetSkillEnabled -> "${if (enabled) "Enable" else "Disable"} skill: $scope/$name"
            is SetProjectKnobs -> "Update project knobs"
            is SaveSchedules -> "Save schedules"
        }

    companion object {
        /** "global" for a global skill: the commit-message scope for skill ops. */
        internal fun scopeOf(path: String) = path.split("/").firstOrNull()?.takeIf { it.isNotEmpty() } ?: "global"

        /** `<scope>/skills/<name>.md` and `<scope>/skills/<name>/SKILL.md` both label as `<scope>/<name>`. */
        private fun skillLabel(path: String): String {
            val parts = path.split("/")
            if (parts.size < 3) return path
            val name = if (parts.size == 4) parts[2] else parts[2].dropLast(3)
            return "${parts[0]}/$name"
        }

        /** The writing tool named in every commit (`via ios` on iOS). */
        const val COMMIT_TOOL = "android"

        /**
         * Commit summary for a coalesced group sharing one commit: per project
         * (first-seen order) with per-kind counts, e.g.
         * `phren: proja(update x3) projb(update x2,task) via android`.
         */
        fun commitMessage(ops: List<PendingOp>): String {
            val first = ops.firstOrNull() ?: return "phren: sync via $COMMIT_TOOL"
            if (ops.size == 1) return first.commitMessage
            val counts = linkedMapOf<String, LinkedHashMap<String, Int>>()
            for (op in ops) {
                val kinds = counts.getOrPut(op.project) { linkedMapOf() }
                kinds[op.commitKind] = (kinds[op.commitKind] ?: 0) + 1
            }
            val segments = counts.map { (project, kinds) ->
                "$project(" + kinds.entries.joinToString(",") { (k, n) -> if (n > 1) "$k x$n" else k } + ")"
            }
            return "phren: ${segments.joinToString(" ")} via $COMMIT_TOOL"
        }
    }
}

/** **Persisted** inside `pending-ops.json`. Every field added later is optional. */
@Serializable
data class QueuedOp(
    val id: String = UUID.randomUUID().toString(),
    val op: PendingOp,
    @Serializable(with = InstantSerializer::class) val queuedAt: Instant = Instant.now(),
    val attempts: Int = 0,
    val lastError: String? = null,
    /** Repo paths this op actually edited when applied locally, in edit order. */
    val paths: List<String>? = null,
    /** Blob SHAs of files the op deleted locally, captured before the delete. */
    val deletedShas: Map<String, String>? = null,
) {
    /** Files the flush must push for this op. */
    val editedPaths: List<String> get() = paths ?: op.editablePaths
}

/**
 * FIFO durable queue persisted next to the manifest. **User data, not a
 * cache**: never discarded on a bad read.
 */
@Serializable
data class PendingOpsQueue(
    override val schemaVersion: Int = CURRENT_SCHEMA_VERSION,
    val pending: List<QueuedOp> = emptyList(),
    /** Ops that failed permanently — surfaced in Settings as "needs attention". */
    val failed: List<QueuedOp> = emptyList(),
) : VersionedDocument {
    fun save(file: File): StorageIssue? =
        PersistedState.save(serializer(), CURRENT_SCHEMA_VERSION, copy(schemaVersion = CURRENT_SCHEMA_VERSION), file, DOCUMENT_NAME)

    companion object {
        const val CURRENT_SCHEMA_VERSION = 1
        const val DOCUMENT_NAME = "unsynced changes"

        fun load(file: File): Pair<PendingOpsQueue, StorageIssue?> {
            val r = PersistedState.load(serializer(), CURRENT_SCHEMA_VERSION, file, DOCUMENT_NAME)
            return (r.value ?: PendingOpsQueue()) to r.issue
        }
    }
}
