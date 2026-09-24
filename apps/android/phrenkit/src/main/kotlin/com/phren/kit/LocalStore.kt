package com.phren.kit

import kotlinx.serialization.Serializable
import java.io.File
import java.time.Instant

/**
 * On-device mirror of the phren store repo (port of LocalStore.swift): plain
 * markdown files path-for-path with the repo, plus a manifest of blob SHAs.
 * Thread-safe; all IO is blocking, so call it off the main thread.
 */
class LocalStore(private val root: File, owner: String, repo: String, branch: String) {
    /** **Persisted** as `manifest.json`. See [VersionedDocument]. */
    @Serializable
    data class Manifest(
        override val schemaVersion: Int = CURRENT_SCHEMA_VERSION,
        val owner: String,
        val repo: String,
        val branch: String,
        val headSha: String? = null,
        /** repo path → blob SHA (the optimistic-concurrency key for writes) */
        val blobShas: Map<String, String> = emptyMap(),
        @Serializable(with = InstantSerializer::class) val lastSyncedAt: Instant? = null,
    ) : VersionedDocument {
        companion object {
            const val CURRENT_SCHEMA_VERSION = 1
            const val DOCUMENT_NAME = "offline cache records"
        }
    }

    private val lock = Any()
    private var manifest: Manifest

    /** Persistence problems hit while opening this store. */
    var storageIssues: List<StorageIssue> = emptyList()
        private set

    init {
        File(root, "files").mkdirs()
        val loaded = PersistedState.load(Manifest.serializer(), Manifest.CURRENT_SCHEMA_VERSION, manifestFile, Manifest.DOCUMENT_NAME)
        loaded.issue?.let { storageIssues = listOf(it) }
        // An owner/repo mismatch is a reused directory, not corruption.
        val saved = loaded.value
        manifest = if (saved != null && saved.owner == owner && saved.repo == repo) saved
        else Manifest(owner = owner, repo = repo, branch = branch)
    }

    val currentManifest: Manifest get() = synchronized(lock) { manifest }

    private val manifestFile: File get() = File(root, "manifest.json")

    /** Throws on a failed write: every caller is already a throwing write path. */
    fun updateManifest(mutate: (Manifest) -> Manifest) = synchronized(lock) {
        manifest = mutate(manifest).copy(schemaVersion = Manifest.CURRENT_SCHEMA_VERSION)
        atomicWrite(manifestFile, persistJson.encodeToString(Manifest.serializer(), manifest))
    }

    // Files

    private fun fileFor(path: String) = File(File(root, "files"), path)

    fun read(path: String): String? = try {
        fileFor(path).takeIf { it.isFile }?.readText(Charsets.UTF_8)
    } catch (_: Exception) {
        null
    }

    fun write(path: String, content: String, blobSha: String?) = synchronized(lock) {
        atomicWrite(fileFor(path), content)
        updateManifest { m -> if (blobSha != null) m.copy(blobShas = m.blobShas + (path to blobSha)) else m }
    }

    fun delete(path: String) = synchronized(lock) {
        fileFor(path).delete()
        updateManifest { it.copy(blobShas = it.blobShas - path) }
    }

    fun blobSha(path: String): String? = synchronized(lock) { manifest.blobShas[path] }

    fun allPaths(): List<String> {
        val filesRoot = File(root, "files").canonicalFile
        val prefix = filesRoot.path + File.separator
        return filesRoot.walkTopDown()
            .filter { it.isFile && !it.name.endsWith(".tmp") }
            .map { it.canonicalPath }
            .filter { it.startsWith(prefix) }
            .map { it.removePrefix(prefix).replace(File.separatorChar, '/') }
            .sorted()
            .toList()
    }

    fun wipe() = synchronized(lock) {
        root.deleteRecursively()
        File(root, "files").mkdirs()
        manifest = Manifest(owner = manifest.owner, repo = manifest.repo, branch = manifest.branch)
        storageIssues = emptyList()
    }

    // Snapshot (parsed view for the UI)

    data class Snapshot(
        val projects: List<Project> = emptyList(),
        val findings: Map<String, List<Finding>> = emptyMap(),
        val tasks: Map<String, TaskDoc> = emptyMap(),
        val notes: Map<String, List<Note>> = emptyMap(),
        val reviewQueue: List<ProjectQueueItem> = emptyList(),
        val summaries: Map<String, String> = emptyMap(),
        /** project → its pinned truths (`truths.md`). */
        val truths: Map<String, List<Truth>> = emptyMap(),
        /** project → date of its last consolidation (`<!-- consolidated: … -->`). */
        val consolidated: Map<String, String> = emptyMap(),
    ) {
        companion object {
            val empty = Snapshot()
        }
    }

    /** Parses every cached file into the UI model (access.ts:797 queue order). */
    fun snapshot(): Snapshot {
        val findings = mutableMapOf<String, MutableList<Finding>>()
        val tasks = mutableMapOf<String, TaskDoc>()
        val notes = mutableMapOf<String, MutableList<Note>>()
        val summaries = mutableMapOf<String, String>()
        val truths = mutableMapOf<String, List<Truth>>()
        val consolidated = mutableMapOf<String, String>()
        val queue = mutableListOf<ProjectQueueItem>()
        val projectNames = sortedSetOf<String>()
        val journals = mutableMapOf<String, MutableList<JournalFile>>()

        for (path in allPaths()) {
            val parts = path.split("/")
            if (parts.size < 2 || !isReadableProjectDirName(parts[0])) continue
            val project = parts[0]
            projectNames += project
            val content = read(path) ?: continue
            if (parts.size == 2) {
                when (parts[1]) {
                    "FINDINGS.md" -> {
                        val file = FindingsFile(content)
                        findings[project] = file.parse().toMutableList()
                        file.consolidatedDate?.let { consolidated[project] = it }
                    }
                    "tasks.md" -> tasks[project] = TasksFile(project, content).doc
                    "review.md" -> ReviewFile(content).parse().forEach { queue += ProjectQueueItem(project, it) }
                    "summary.md" -> summaries[project] = content
                    "truths.md" -> truths[project] = TruthsFile(content).truths
                }
            } else if (parts.size == 3 && parts[1] == "notes") {
                val date = parts[2].dropLast(3)
                notes.getOrPut(project) { mutableListOf() } += NotesFile(project, date, content).notes
            } else if (parts.size == 3 && parts[1] == JournalFile.DIRECTORY_NAME) {
                JournalFile.parseFileName(parts[2])?.let { (date, actor) ->
                    journals.getOrPut(project) { mutableListOf() } += JournalFile(date, actor, content)
                }
            }
        }

        // journal.ts:184 — newest actor-day first, appended after FINDINGS.md.
        for ((project, files) in journals) {
            var idOffset = 0
            for (file in files.sortedByDescending { it.fileName }) {
                val entries = file.findings(idOffset)
                idOffset += entries.size
                findings.getOrPut(project) { mutableListOf() } += entries
            }
        }
        // notes.ts:152 — newest first across days
        notes.values.forEach { list -> list.sortByDescending { "${it.date}T${it.time}" } }
        queue.sortWith(reviewQueueComparator)

        val projects = projectNames.map { name ->
            Project(
                name = name,
                findingCount = findings[name]?.size ?: 0,
                taskCount = tasks[name]?.let { it.active.size + it.queue.size } ?: 0,
                noteCount = notes[name]?.size ?: 0,
                reviewCount = queue.count { it.project == name },
            )
        }
        return Snapshot(projects, findings, tasks, notes, queue, summaries, truths, consolidated)
    }

    companion object {
        /** The cross-project tier: read-only on the phone. */
        const val GLOBAL_DIR_NAME = "global"

        /** `RESERVED_PROJECT_DIR_NAMES` (phren-core.ts:32) plus `scripts`. */
        internal val reservedDirNames = setOf(GLOBAL_DIR_NAME, ".runtime", ".sessions", ".config", "profiles", "templates", "scripts")

        private val PROJECT_NAME = JSRegex("""^[a-z0-9][a-z0-9-]*$""")
        private val NOTE_FILE = JSRegex("""^\d{4}-\d{2}-\d{2}\.md$""")

        /**
         * Only these paths are ever written back to GitHub. `journal/` is
         * gated on the same project-directory predicate as FINDINGS.md.
         */
        fun isWritablePath(path: String): Boolean {
            val parts = path.split("/")
            if (parts.size < 2 || !isProjectDirName(parts[0])) return false
            if (parts.size == 2) return parts[1] in setOf("FINDINGS.md", "tasks.md", "review.md")
            if (parts.size == 3 && parts[1] == "notes") return NOTE_FILE.test(parts[2])
            if (parts.size == 3 && parts[1] == JournalFile.DIRECTORY_NAME) return JournalFile.parseFileName(parts[2]) != null
            return false
        }

        /** The hot tier: paths mirrored locally. */
        fun isSyncedPath(path: String): Boolean {
            if (path == "phren.root.yaml" || path == "stores.yaml") return true
            if (path == TeamBootstrap.FILE_NAME) return true
            val parts = path.split("/")
            if (parts.size < 2) return false
            if (parts[0] == GLOBAL_DIR_NAME) return parts.size == 2 && parts[1] in setOf("FINDINGS.md", "CLAUDE.md")
            if (!isProjectDirName(parts[0])) return false
            if (parts.size == 2) return parts[1] in setOf("FINDINGS.md", "tasks.md", "review.md", "summary.md", "CLAUDE.md", "truths.md")
            if (parts.size == 3 && parts[1] == "notes") return NOTE_FILE.test(parts[2])
            if (parts.size == 3 && parts[1] == JournalFile.DIRECTORY_NAME) return JournalFile.parseFileName(parts[2]) != null
            return false
        }

        /** **The writability predicate** (`isValidProjectName` minus reserved/archived). */
        fun isProjectDirName(name: String): Boolean {
            if (!PROJECT_NAME.test(name)) return false
            return name !in reservedDirNames && !name.endsWith(".archived")
        }

        /** Directories rendered as projects: the writable ones plus `global`. */
        fun isReadableProjectDirName(name: String): Boolean = isProjectDirName(name) || name == GLOBAL_DIR_NAME

        /** A project shown but never offered for editing. */
        fun isReadOnlyProject(name: String): Boolean = isReadableProjectDirName(name) && !isProjectDirName(name)

        fun defaultDirectory(base: File, owner: String, repo: String) = File(base, "PhrenStore/${owner}__$repo")

        /** access.ts:797 — section order, then date desc, then project, then id. */
        val reviewQueueComparator: Comparator<ProjectQueueItem> = Comparator { a, b ->
            if (a.item.section != b.item.section) return@Comparator a.item.section.ordinal - b.item.section.ordinal
            val aDate = if (a.item.date == "unknown") "" else a.item.date
            val bDate = if (b.item.date == "unknown") "" else b.item.date
            if (aDate != bDate) return@Comparator bDate.compareTo(aDate)
            if (a.project != b.project) return@Comparator a.project.compareTo(b.project)
            a.item.id.compareTo(b.item.id)
        }
    }
}
