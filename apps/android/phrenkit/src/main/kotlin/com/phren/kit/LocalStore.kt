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
        cachedSnapshot = null
        atomicWrite(fileFor(path), content)
        updateManifest { m -> if (blobSha != null) m.copy(blobShas = m.blobShas + (path to blobSha)) else m }
    }

    fun delete(path: String) = synchronized(lock) {
        cachedSnapshot = null
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
        cachedSnapshot = null
        if (root.exists() && !root.deleteRecursively()) throw java.io.IOException("Could not remove ${root.path}")
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
        /** Global first, then projects alphabetically, then skill name. */
        val skills: List<Skill> = emptyList(),
        /** project → its AGENTS.md (or legacy CLAUDE.md) text. */
        val instructions: Map<String, String> = emptyMap(),
        val instructionPaths: Map<String, String> = emptyMap(),
        val skillPreferencesContent: String? = null,
        val machines: MachineRegistry = MachineRegistry.empty,
        val projectKnobs: Map<String, ProjectKnobs> = emptyMap(),
        val projectConfigs: Map<String, String> = emptyMap(),
        val schedules: Map<String, List<Schedule>> = emptyMap(),
        val schedulesContent: Map<String, String> = emptyMap(),
        /** Changes identity every parse, so views can key caches off it. */
        val revision: String = java.util.UUID.randomUUID().toString(),
    ) {
        companion object {
            val empty = Snapshot()
        }
    }

    private data class FileState(val path: String, val modified: Long, val size: Long)
    private var cachedSnapshot: Pair<List<FileState>, Snapshot>? = null

    private fun scanStates(): List<FileState> {
        val filesRoot = File(root, "files").canonicalFile
        val prefix = filesRoot.path + File.separator
        return filesRoot.walkTopDown().filter { it.isFile && !it.name.endsWith(".tmp") }
            .mapNotNull { f ->
                val path = f.path.takeIf { it.startsWith(prefix) } ?: f.canonicalPath.takeIf { it.startsWith(prefix) } ?: return@mapNotNull null
                FileState(path.removePrefix(prefix).replace(File.separatorChar, '/'), f.lastModified(), f.length())
            }
            .sortedBy { it.path }.toList()
    }

    /** Parses every cached file into the UI model (access.ts:797 queue order); reused while no file changed. */
    fun snapshot(): Snapshot {
        val states = scanStates()
        synchronized(lock) { cachedSnapshot?.let { (files, value) -> if (files == states) return value } }
        val findings = mutableMapOf<String, MutableList<Finding>>()
        val tasks = mutableMapOf<String, TaskDoc>()
        val notes = mutableMapOf<String, MutableList<Note>>()
        val summaries = mutableMapOf<String, String>()
        val truths = mutableMapOf<String, List<Truth>>()
        val consolidated = mutableMapOf<String, String>()
        val queue = mutableListOf<ProjectQueueItem>()
        val projectNames = sortedSetOf<String>()
        val journals = mutableMapOf<String, MutableList<JournalFile>>()
        val skills = mutableListOf<Skill>()
        val instructions = mutableMapOf<String, String>()
        val instructionPaths = mutableMapOf<String, String>()
        val machines = mutableMapOf<String, String>()
        val profiles = mutableMapOf<String, List<String>>()
        val sourcePaths = mutableMapOf<String, String>()
        val projectKnobs = mutableMapOf<String, ProjectKnobs>()
        val projectConfigs = mutableMapOf<String, String>()
        val schedules = mutableMapOf<String, List<Schedule>>()
        val schedulesContent = mutableMapOf<String, String>()

        for (path in states.map { it.path }) {
            val parts = path.split("/")
            if (path == MachineRegistry.MACHINES_FILE) {
                read(path)?.let { machines.putAll(MachineRegistry.parseMachines(it)) }
                continue
            }
            if (MachineRegistry.isProfilePath(path)) {
                read(path)?.let {
                    val (name, projects) = MachineRegistry.parseProfile(it)
                    profiles[name ?: parts[1].removeSuffix(".yaml")] = projects
                }
                continue
            }
            // Skills first: `global/skills/…` sits outside a project directory.
            if (isSkillPath(path)) {
                read(path)?.let { Skill.parse(path, it) }?.let { skill ->
                    skills += skill
                    (skill.scope as? Skill.Scope.Project)?.let { projectNames += it.name }
                }
                continue
            }
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
                    AgentInstructions.FILE_NAME -> { instructions[project] = content; instructionPaths[project] = path }
                    // AGENTS.md is canonical and wins regardless of listing order.
                    AgentInstructions.LEGACY_FILE_NAME -> if (project !in instructions) { instructions[project] = content; instructionPaths[project] = path }
                    "truths.md" -> truths[project] = TruthsFile(content).truths
                    MachineRegistry.PROJECT_FILE -> {
                        projectConfigs[project] = content
                        projectKnobs[project] = ProjectKnobs.parse(content)
                        MachineRegistry.parseSourcePath(content)?.let { sourcePaths[project] = it }
                    }
                    SchedulesFile.FILE_NAME -> {
                        schedulesContent[project] = content
                        schedules[project] = SchedulesFile.parse(content)
                    }
                }
            } else if (parts.size == 3 && parts[1] == "notes") {
                notes.getOrPut(project) { mutableListOf() } += NotesFile(project, parts[2].dropLast(3), content).notes
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
        notes.values.forEach { list -> list.sortByDescending { "${it.date}T${it.time}" } }
        queue.sortWith(reviewQueueComparator)
        val reviewCounts = queue.groupingBy { it.project }.eachCount()

        val projects = projectNames.map { name ->
            Project(
                name = name,
                findingCount = findings[name]?.size ?: 0,
                taskCount = tasks[name]?.let { it.active.size + it.queue.size } ?: 0,
                noteCount = notes[name]?.size ?: 0,
                reviewCount = reviewCounts[name] ?: 0,
                archivedCount = summaries[name]?.let(::archivedFindingCount) ?: 0,
            )
        }
        skills.sortWith(Comparator { a, b ->
            if (a.scope != b.scope) {
                if (a.scope is Skill.Scope.Global) return@Comparator -1
                if (b.scope is Skill.Scope.Global) return@Comparator 1
                return@Comparator a.scope.source.compareTo(b.scope.source)
            }
            String.CASE_INSENSITIVE_ORDER.compare(a.name, b.name)
        })
        val result = Snapshot(
            projects, findings, tasks, notes, queue, summaries, truths, consolidated,
            skills, instructions, instructionPaths, read(SkillPreferences.PATH),
            MachineRegistry(machines, profiles, sourcePaths), projectKnobs, projectConfigs, schedules, schedulesContent,
        )
        synchronized(lock) { cachedSnapshot = states to result }
        return result
    }

    /** The finding bullet whose graph score key matches, from the live FINDINGS.md. */
    fun findingBulletText(project: String, scoreKey: String): String? {
        val markdown = read("$project/FINDINGS.md") ?: return null
        return GraphBuilder.findBulletText(project, scoreKey, markdown)
    }

    /** The input the memory graph is built from (LocalStore.graphInput). */
    fun graphInput(storeName: String): GraphBuilder.Input {
        val snapshot = snapshot()
        val findingsMarkdown = snapshot.findings.mapValues { (_, list) ->
            list.filter { !it.archived && !it.isJournalEntry }.joinToString("\n") { "## ${it.date}\n${it.rawLine}" }
        }
        val totals = snapshot.projects.associate { p ->
            val live = (snapshot.findings[p.name] ?: emptyList()).count { !it.archived }
            p.name to live + (snapshot.summaries[p.name]?.let(::archivedFindingCount) ?: 0)
        }
        return GraphBuilder.Input(
            findingsMarkdown, snapshot.tasks, snapshot.projects.map { it.name }.sorted(), storeName,
            snapshot.findings.mapValues { (_, list) -> list.filter { it.isJournalEntry } }, totals,
        )
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
            if (path == SkillPreferences.PATH) return true
            // Admitted for their dedicated ops only.
            if (isProjectConfigPath(path) || isSchedulesPath(path)) return true
            // Authored content is separate from global's read-only findings tier.
            if (isSkillPath(path) || AgentInstructions.isPath(path)) return true
            val parts = path.split("/")
            if (parts.size < 2 || !isProjectDirName(parts[0])) return false
            if (parts.size == 2) return parts[1] in setOf("FINDINGS.md", "tasks.md", "review.md")
            if (parts.size == 3 && parts[1] == "notes") return NOTE_FILE.test(parts[2])
            if (parts.size == 3 && parts[1] == JournalFile.DIRECTORY_NAME) return JournalFile.parseFileName(parts[2]) != null
            return false
        }

        /** The hot tier: paths mirrored locally. */
        fun isSyncedPath(path: String): Boolean {
            if (path == SkillPreferences.PATH) return true
            if (path == "phren.root.yaml" || path == "stores.yaml" || path == MachineRegistry.MACHINES_FILE) return true
            if (MachineRegistry.isProfilePath(path)) return true
            if (isSkillPath(path)) return true
            if (path == TeamBootstrap.FILE_NAME) return true
            val parts = path.split("/")
            if (parts.size < 2) return false
            if (parts[0] == GLOBAL_DIR_NAME) return parts.size == 2 && parts[1] in setOf("FINDINGS.md", AgentInstructions.FILE_NAME, AgentInstructions.LEGACY_FILE_NAME)
            if (!isProjectDirName(parts[0])) return false
            if (parts.size == 2) return parts[1] in setOf(
                "FINDINGS.md", "tasks.md", "review.md", "summary.md", AgentInstructions.FILE_NAME,
                AgentInstructions.LEGACY_FILE_NAME, "truths.md", MachineRegistry.PROJECT_FILE, SchedulesFile.FILE_NAME,
            )
            if (parts.size == 3 && parts[1] == "notes") return NOTE_FILE.test(parts[2])
            if (parts.size == 3 && parts[1] == JournalFile.DIRECTORY_NAME) return JournalFile.parseFileName(parts[2]) != null
            return false
        }

        private val SKILL_NAME = JSRegex("""^[A-Za-z0-9][A-Za-z0-9._-]*$""")

        fun isSkillPath(path: String): Boolean {
            val parts = path.split("/")
            if (parts.size < 3 || parts[1] != "skills") return false
            if (!(parts[0] == GLOBAL_DIR_NAME || isProjectDirName(parts[0]))) return false
            if (parts.size == 3) return parts[2].endsWith(".md") && isSkillNameSegment(parts[2].dropLast(3))
            if (parts.size == 4) return parts[3] == "SKILL.md" && isSkillNameSegment(parts[2])
            return false
        }

        internal fun isSkillNameSegment(name: String) = SKILL_NAME.test(name) && !name.contains("..")

        fun isProjectConfigPath(path: String): Boolean {
            val parts = path.split("/")
            return parts.size == 2 && isProjectDirName(parts[0]) && parts[1] == MachineRegistry.PROJECT_FILE
        }

        fun isSchedulesPath(path: String): Boolean {
            val parts = path.split("/")
            return parts.size == 2 && isProjectDirName(parts[0]) && parts[1] == SchedulesFile.FILE_NAME
        }

        private val ARCHIVED_COUNT = Regex("""([0-9][0-9,]*) archived across""")

        /** The CLI's summary.md says how many findings it archived ("925 archived across 17 topics"). */
        fun archivedFindingCount(summary: String): Int? =
            ARCHIVED_COUNT.find(summary)?.groupValues?.get(1)?.filter { it.isDigit() }?.toIntOrNull()

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
