package com.phren.kit

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant

/**
 * Orchestrates GitHub ⇄ LocalStore sync (port of SyncEngine.swift).
 *
 * Reads: cheap ref poll (ETag'd, 304s are rate-limit-free) → recursive tree →
 * changed blobs only. Writes: offline-first — every mutation applies to the
 * local cache immediately, queues a domain op, and flushes FIFO with the whole
 * queue coalesced into one commit per file; a sha conflict triggers refetch →
 * re-apply → retry (bounded), then parks the ops individually.
 *
 * Swift's actor isolation is reproduced by confining every engine coroutine to
 * a single-threaded dispatcher: state is only touched there, and like an actor
 * it is re-entrant at suspension points.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SyncEngine(
    private val client: GitHubAPI,
    private val store: LocalStore,
    stateDirectory: File,
) {
    data class Status(
        val isSyncing: Boolean = false,
        val isLive: Boolean = false,
        val lastSyncedAt: Instant? = null,
        val pendingCount: Int = 0,
        val failedCount: Int = 0,
        val lastError: String? = null,
    )

    /**
     * Identity stamped into `<!-- source: -->` comments on findings written
     * from this device, plus how this store wants findings recorded.
     */
    data class WriteContext(
        /** The CLI's `getCurrentActor()` — on the phone, the GitHub login. */
        val actor: String? = null,
        /** The CLI's `getMachineName()` — the device name. */
        val machine: String? = null,
        /** `role: team`: finding-adds go to `journal/YYYY-MM-DD-<actor>.md`. */
        val usesTeamJournal: Boolean = false,
    )

    private val confined = Dispatchers.IO.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + confined)

    /** The cold tier's catalogue and cache; does its own locking. */
    val coldStore = ColdStore(stateDirectory)
    private val queueFile = File(stateDirectory, "pending-ops.json")
    private var queue: PendingOpsQueue
    private var status = Status()
    private var writeContext = WriteContext()
    private var liveJob: Job? = null
    private var flushJob: Job? = null
    private var pullTask: Deferred<Unit>? = null
    private var pullGeneration = 0
    /** Tests drive [flushNow] by hand. Always on in the app. */
    private var autoFlush = true

    /** Queue reads that had to be quarantined and queue writes that failed. */
    var storageIssues: List<StorageIssue> = emptyList()
        private set

    /** What changed: content (re-read the snapshot) or just status. */
    enum class Update { CONTENT, STATUS }

    @Volatile private var onUpdate: ((Update) -> Unit)? = null
    private var enqueueGeneration = 0

    init {
        val (loaded, issue) = PendingOpsQueue.load(queueFile)
        queue = loaded
        issue?.let { storageIssues = listOf(it) }
        status = status.copy(pendingCount = queue.pending.size, failedCount = queue.failed.size)
    }

    fun setOnUpdate(callback: (Update) -> Unit) { onUpdate = callback }

    suspend fun setWriteContext(context: WriteContext) = withContext(confined) { writeContext = context }

    suspend fun currentStatus(): Status = withContext(confined) { status }

    private fun notifyUpdate(update: Update = Update.CONTENT) { onUpdate?.invoke(update) }

    private fun setStatus(mutate: (Status) -> Status = { it }) {
        status = mutate(status).copy(pendingCount = queue.pending.size, failedCount = queue.failed.size)
        notifyUpdate(Update.STATUS)
    }

    fun close() { scope.coroutineContext[Job]?.cancel() }

    // Pull

    /**
     * One sync pass. `force` skips the ETag shortcut. Concurrent callers
     * serialize; a forced caller always runs its own pass.
     */
    suspend fun pull(force: Boolean = false) = pull(force, emptySet())

    private suspend fun pull(force: Boolean, overwritingPendingPaths: Set<String>): Unit = withContext(confined) {
        pullTask?.let { inFlight ->
            inFlight.await()
            if (!force) return@withContext
        }
        pullGeneration++
        val generation = pullGeneration
        val task = scope.async { performPull(force, overwritingPendingPaths) }
        pullTask = task
        task.await()
        if (pullGeneration == generation) pullTask = null
    }

    /** A queued edit's file is never overwritten by a pull, unless recovery asks. */
    private fun preservesPendingFile(path: String, overwriting: Set<String>) =
        path !in overwriting && queue.pending.any { path in it.editedPaths }

    private suspend fun performPull(force: Boolean, overwritingPendingPaths: Set<String>) {
        setStatus { it.copy(isSyncing = true, lastError = null) }
        try {
            val manifest = store.currentManifest
            val headSha = if (force) {
                client.headSha(manifest.owner, manifest.repo, manifest.branch) ?: manifest.headSha
            } else {
                client.headSha(manifest.owner, manifest.repo, manifest.branch)
            }
            if (headSha == null || (!force && headSha == manifest.headSha)) {
                // 304 — nothing changed; the poll was free.
                setStatus { it.copy(lastSyncedAt = Instant.now()) }
            } else {
                val tree = client.tree(manifest.owner, manifest.repo, headSha)
                // The tree already carries every cold blob's path, sha and size.
                coldStore.replaceCatalogue(tree.tree.mapNotNull { ColdDocRef.of(it) })
                val remote = LinkedHashMap<String, String>()
                tree.tree.filter { it.type == "blob" && LocalStore.isSyncedPath(it.path) }
                    .forEach { e -> e.sha?.let { remote.putIfAbsent(e.path, it) } }

                var changed = false
                for ((path, sha) in remote) {
                    if (store.blobSha(path) == sha) continue
                    if (preservesPendingFile(path, overwritingPendingPaths)) continue
                    val data = client.blob(manifest.owner, manifest.repo, sha)
                    // An edit can be queued while a blob request is in flight.
                    if (preservesPendingFile(path, overwritingPendingPaths)) continue
                    store.write(path, data.toString(Charsets.UTF_8), sha)
                    changed = true
                }
                for (path in store.allPaths()) {
                    if (path in remote || !LocalStore.isSyncedPath(path)) continue
                    if (preservesPendingFile(path, overwritingPendingPaths)) continue
                    // No blob sha = created locally and never synced; keep it.
                    if (store.blobSha(path) == null && path !in overwritingPendingPaths) continue
                    store.delete(path)
                    changed = true
                }
                store.updateManifest { it.copy(headSha = headSha, lastSyncedAt = Instant.now()) }
                setStatus { it.copy(lastSyncedAt = Instant.now()) }
                if (changed) notifyUpdate()
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            setStatus { it.copy(lastError = e.message ?: e.toString()) }
        } finally {
            setStatus { it.copy(isSyncing = false) }
            // An unchanged head still retries edits queued offline, once per pass.
            if (queue.pending.isNotEmpty()) scheduleFlush()
        }
    }

    // Cold tier

    /** Reads one archived-findings document, fetching only if the cache is stale. */
    suspend fun coldDocument(path: String): TopicDocument = withContext(confined) {
        val reference = coldStore.reference(path)
            ?: throw PhrenKitError.NotFound("That archive topic isn't in this store any more.")
        when (val h = coldStore.hydration(path)) {
            is ColdStore.Hydration.Cached -> TopicDocument(reference, h.text)
            ColdStore.Hydration.Unknown -> throw PhrenKitError.NotFound("That archive topic isn't in this store any more.")
            is ColdStore.Hydration.TooLarge -> throw PhrenKitError.Validation(
                "${reference.displayName} is ${megabytes(h.bytes)} of archived findings — too large to open on the phone. Read it from your computer.",
            )
            is ColdStore.Hydration.Fetch -> {
                val manifest = store.currentManifest
                val text = client.blob(manifest.owner, manifest.repo, h.sha).toString(Charsets.UTF_8)
                val document = TopicDocument(reference, text)
                coldStore.cache(path, text, h.sha, document.entries.size)
                document
            }
        }
    }

    // Live polling

    suspend fun startLive() = withContext(confined) {
        if (liveJob != null) return@withContext
        setStatus { it.copy(isLive = true) }
        liveJob = scope.launch {
            while (isActive) {
                pull()
                delay(LIVE_POLL_INTERVAL_MS)
            }
        }
    }

    suspend fun stopLive() = withContext(confined) {
        liveJob?.cancel()
        liveJob = null
        setStatus { it.copy(isLive = false) }
    }

    // Mutations

    private fun persistQueue() {
        val issue = queue.save(queueFile) ?: return
        storageIssues = storageIssues.filter { it.kind != StorageIssue.Kind.UNWRITABLE } + issue
    }

    /** Applies the op locally (instant UI), persists it, and schedules a flush. */
    suspend fun enqueue(op: PendingOp): Unit = withContext(confined) {
        // Writability first, while the user is still looking at what they did.
        if (!LocalStore.isWritablePath(op.primaryPath)) {
            throw PhrenKitError.Validation("\"${op.project}\" is read-only in the app — edit it with the phren CLI.")
        }
        // A domain error (empty, secret, ambiguous) surfaces now and nothing is queued.
        val queued = QueuedOp(op = op)
        val (paths, deletedShas) = applyLocally(op, queued.queuedAt)
        enqueueGeneration++
        queue = queue.copy(pending = queue.pending + queued.copy(paths = paths, deletedShas = deletedShas.ifEmpty { null }))
        persistQueue()
        setStatus()
        scheduleFlush()
    }

    /** Re-queues everything in "Needs attention", re-applying ops parked before their edit landed. */
    suspend fun retryFailed() = withContext(confined) {
        val retrying = queue.failed
        enqueueGeneration++
        queue = queue.copy(failed = emptyList())
        for (q in retrying) {
            var queued = q
            if (queued.paths?.isEmpty() == true) {
                try {
                    val (paths, deleted) = applyLocally(queued.op, queued.queuedAt)
                    queued = queued.copy(paths = paths, deletedShas = deleted.ifEmpty { null })
                } catch (e: Exception) {
                    queue = queue.copy(failed = queue.failed + queued.copy(lastError = e.message))
                    continue
                }
            }
            queue = queue.copy(pending = queue.pending + queued.copy(lastError = null))
        }
        persistQueue()
        setStatus()
        scheduleFlush()
    }

    suspend fun discardFailed(id: String) = withContext(confined) {
        queue = queue.copy(failed = queue.failed.filter { it.id != id })
        persistQueue()
        setStatus()
    }

    suspend fun failedOps(): List<QueuedOp> = withContext(confined) { queue.failed }

    /** Ops applied locally but not yet pushed. */
    suspend fun pendingOps(): List<QueuedOp> = withContext(confined) { queue.pending }

    private fun scheduleFlush() {
        if (!autoFlush || flushJob != null) return
        val generation = enqueueGeneration
        flushJob = scope.launch {
            flush()
            flushJob = null
            // Old work may have failed because we're offline; only newly
            // enqueued work warrants another immediate pass.
            if (enqueueGeneration != generation && queue.pending.isNotEmpty()) scheduleFlush()
        }
    }

    /** Moves a skill to another scope, carrying its enabled setting (SyncEngine.moveSkill). */
    suspend fun moveSkill(skill: Skill, scope: String) = withContext(confined) {
        if (scope == skill.scope.source) throw PhrenKitError.Validation("The skill is already in $scope.")
        val destination = if (skill.format == Skill.Format.FOLDER) "$scope/skills/${skill.name}/SKILL.md" else "$scope/skills/${skill.name}.md"
        if (!LocalStore.isSkillPath(destination)) throw PhrenKitError.Validation("Invalid skill scope or name.")
        val preferences = SkillPreferences.parse(store.read(SkillPreferences.PATH))
        val enabled = preferences.explicitSetting(skill.scope.source, skill.name)
        enqueue(PendingOp.SaveAuthoredFile(destination, skill.content, null))
        enqueue(PendingOp.DeleteAuthoredFile(skill.path, skill.content))
        if (enabled != null) {
            enqueue(PendingOp.SetSkillEnabled(scope, skill.name, enabled, preferences.explicitSetting(scope, skill.name)))
        }
    }

    private fun recordCacheFailure(document: String, location: String, error: Exception) {
        val issue = StorageIssue(
            kind = StorageIssue.Kind.UNWRITABLE, document = document, location = location, quarantineLocation = null,
            foundSchemaVersion = null, expectedSchemaVersion = 0, detail = error.toString(),
        ).also { StorageIssueLog.shared.record(it) }
        storageIssues = storageIssues.filter { !(it.kind == StorageIssue.Kind.UNWRITABLE && it.document == document) } + issue
    }

    /** Runs a flush pass to completion, awaiting one already in flight. */
    suspend fun flushNow() = withContext(confined) {
        flushJob?.join()
        flush()
    }

    internal suspend fun setAutoFlush(enabled: Boolean) = withContext(confined) { autoFlush = enabled }

    // Flush (coalesced writes)

    private data class Parked(val op: QueuedOp, val error: String)

    /**
     * FIFO flush with op coalescing: the whole queue rides one plan, ONE
     * Contents PUT per distinct file. Safe because ops were already applied
     * to the local cache in FIFO order at enqueue time.
     */
    private suspend fun flush() {
        while (true) {
            val group = queue.pending
            if (group.isEmpty()) return

            var plan = GroupPlan.of(group)
            val parked = mutableListOf<Parked>()
            var transient: Exception? = null
            var attempt = 0

            while (plan.paths.isNotEmpty()) {
                attempt++
                try {
                    write(plan)
                    break
                } catch (failure: PartialWriteFailure) {
                    // Retire files that already landed and the ops they complete.
                    plan = plan.retiring(failure.succeeded)
                    if (plan.paths.isEmpty() && plan.ops.isEmpty()) break
                    val underlying = failure.underlying
                    when {
                        underlying is GitHubError && underlying.isShaConflict -> {
                            if (attempt >= MAX_WRITE_ATTEMPTS) {
                                parked += plan.ops.map { Parked(it, underlying.message ?: "") }
                                plan = GroupPlan.EMPTY
                                break
                            }
                            forgetCachedShas(plan.paths)
                            pull(force = true, overwritingPendingPaths = plan.paths.toSet())
                            val (retryPlan, retryParked) = reapply(plan.ops)
                            plan = retryPlan
                            parked += retryParked
                            recordReapply(plan.ops)
                        }
                        underlying is PhrenKitError -> {
                            parked += plan.ops.map { Parked(it, underlying.message) }
                            plan = GroupPlan.EMPTY
                            break
                        }
                        else -> {
                            transient = underlying
                            break
                        }
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    transient = e
                    break
                }
            }

            if (transient != null) {
                // Network/API failure — keep the group queued; the next trigger retries.
                val msg = transient.message ?: transient.toString()
                queue = queue.copy(pending = queue.pending.mapIndexed { i, q ->
                    if (i < group.size) q.copy(attempts = q.attempts + 1, lastError = msg) else q
                })
                persistQueue()
                setStatus { it.copy(lastError = msg) }
                return
            }

            dropLeading(group)
            queue = queue.copy(failed = queue.failed + parked.map { it.op.copy(lastError = it.error) })
            persistQueue()
            setStatus()
        }
    }

    /** Removes the flushed group from the head of the queue (ids checked). */
    private fun dropLeading(group: List<QueuedOp>) {
        val pending = queue.pending.toMutableList()
        for (queued in group) {
            if (pending.firstOrNull()?.id != queued.id) break
            pending.removeAt(0)
        }
        queue = queue.copy(pending = pending)
    }

    /** Drops cached blob shas so the conflict pull really re-downloads them. */
    private fun forgetCachedShas(paths: List<String>) {
        try {
            store.updateManifest { it.copy(blobShas = it.blobShas - paths.toSet()) }
        } catch (e: Exception) {
            recordCacheFailure("cached file versions", "manifest", e)
        }
    }

    private fun recordReapply(ops: List<QueuedOp>) {
        val byId = ops.associateBy { it.id }
        queue = queue.copy(pending = queue.pending.map { q ->
            byId[q.id]?.let { q.copy(paths = it.paths, deletedShas = it.deletedShas) } ?: q
        })
    }

    /** The write plan for one coalesced group. */
    private data class GroupPlan(val ops: List<QueuedOp>, val paths: List<String>, val deletedShas: Map<String, String>) {
        /** The plan minus files already committed and every op they completed. */
        fun retiring(landed: List<String>): GroupPlan {
            if (landed.isEmpty()) return this
            val done = landed.toSet()
            return GroupPlan(
                ops = ops.filter { !done.containsAll(it.editedPaths) },
                paths = paths.filter { it !in done },
                deletedShas = deletedShas - done,
            )
        }

        companion object {
            val EMPTY = GroupPlan(emptyList(), emptyList(), emptyMap())

            fun of(ops: List<QueuedOp>): GroupPlan {
                val paths = LinkedHashSet<String>()
                val deleted = mutableMapOf<String, String>()
                for (q in ops) {
                    paths += q.editedPaths
                    q.deletedShas?.let { deleted.putAll(it) }
                }
                // Secondary files first: if a mirror write conflicts, the primary
                // file is still untouched remotely for the re-apply to find.
                val secondaries = ops.flatMap { q -> q.editedPaths.filter { it != q.op.primaryPath } }.toSet()
                val ordered = paths.filter { it in secondaries } + paths.filter { it !in secondaries }
                return GroupPlan(ops, ordered, deleted)
            }
        }
    }

    private class PartialWriteFailure(val underlying: Exception, val succeeded: List<String>) : Exception(underlying)

    /** One PUT (or DELETE) per file, all carrying the same commit message. */
    private suspend fun write(plan: GroupPlan) {
        val manifest = store.currentManifest
        val message = PendingOp.commitMessage(plan.ops.map { it.op })
        val succeeded = mutableListOf<String>()
        for (path in plan.paths) {
            try {
                if (!LocalStore.isWritablePath(path)) {
                    throw PhrenKitError.Validation("Refusing to write non-writable path $path.")
                }
                val content = store.read(path)
                if (content != null) {
                    // Skip a byte-identical PUT (GitHub would record an empty commit).
                    val known = store.blobSha(path)
                    if (known != null && known == GitBlob.sha(content)) {
                        succeeded += path
                        continue
                    }
                    val response = client.putFile(
                        manifest.owner, manifest.repo, path, manifest.branch,
                        content.toByteArray(Charsets.UTF_8), message, store.blobSha(path),
                    )
                    store.write(path, content, response.content?.sha)
                } else {
                    val sha = store.blobSha(path) ?: plan.deletedShas[path]
                    if (sha != null) {
                        client.deleteFile(manifest.owner, manifest.repo, path, manifest.branch, message, sha)
                        store.delete(path)
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                throw PartialWriteFailure(e, succeeded.toList())
            }
            succeeded += path
        }
    }

    /**
     * Refetch → re-apply: replays every op of a conflicted group against the
     * freshly pulled content. Ops whose target vanished come back for parking.
     */
    private fun reapply(ops: List<QueuedOp>): Pair<GroupPlan, List<Parked>> {
        val overlay = LinkedHashMap<String, String?>()
        val applied = mutableListOf<QueuedOp>()
        val parked = mutableListOf<Parked>()
        for (queued in ops) {
            try {
                val edits = computeEdits(queued.op, queued.queuedAt, overlay)
                edits.forEach { overlay[it.path] = it.content }
                applied += queued.copy(paths = edits.map { it.path }, deletedShas = null)
            } catch (e: Exception) {
                parked += Parked(queued.copy(paths = emptyList(), deletedShas = null), e.message ?: e.toString())
            }
        }
        // Materialize the batch so the UI keeps showing the user's edits.
        val deleted = mutableMapOf<String, String>()
        for ((path, content) in overlay) {
            try {
                if (content != null) store.write(path, content, null)
                else {
                    store.blobSha(path)?.let { deleted[path] = it }
                    store.delete(path)
                }
            } catch (e: Exception) {
                recordCacheFailure("local edits", path, e)
            }
        }
        notifyUpdate()
        val withShas = applied.map { q ->
            val shas = q.paths.orEmpty().mapNotNull { p -> deleted[p]?.let { p to it } }.toMap()
            q.copy(deletedShas = shas.ifEmpty { null })
        }
        return GroupPlan.of(withShas) to parked
    }

    // Op application

    private data class FileEdit(val path: String, /** null = delete the file */ val content: String?)

    /** Applies the op to local cached content only, reporting touched files. */
    private fun applyLocally(op: PendingOp, createdAt: Instant): Pair<List<String>, Map<String, String>> {
        val paths = mutableListOf<String>()
        val deletedShas = mutableMapOf<String, String>()
        for (edit in computeEdits(op, createdAt)) {
            paths += edit.path
            if (edit.content != null) store.write(edit.path, edit.content, null)
            else {
                store.blobSha(edit.path)?.let { deletedShas[edit.path] = it }
                store.delete(edit.path)
            }
        }
        notifyUpdate()
        return paths to deletedShas
    }

    /** Current content, honoring edits an earlier op in the same group already made. */
    private fun read(path: String, overlay: Map<String, String?>): String? =
        if (overlay.containsKey(path)) overlay[path] else store.read(path)

    /** The journal file today's adds belong in (journal.ts:153 — UTC date). */
    private fun journalTarget(project: String): Pair<String, JournalFile> {
        val actor = JournalFile.sanitizeActor(writeContext.actor)
        val date = FindingsFile.isoTimestamp(Instant.now()).take(10)
        return JournalFile.path(project, date, actor) to JournalFile(date, actor)
    }

    /** Appends one finding to this store's journal (tools/finding.ts:186). */
    private fun journalEdit(project: String, text: String, type: String?, overlay: Map<String, String?>): FileEdit {
        val finding = JournalFile.preparedFinding(text, type?.let { t -> FindingType.entries.firstOrNull { it.rawValue == t } })
        val (path, target) = journalTarget(project)
        val file = JournalFile(target.date, target.actor, read(path, overlay))
        file.append(finding, writeContext.machine)
        return FileEdit(path, file.content)
    }

    private fun provenance() = FindingProvenance(
        source = "human", machine = writeContext.machine, actor = writeContext.actor, tool = TOOL_NAME,
    )

    private fun findingType(raw: String?) = raw?.let { t -> FindingType.entries.firstOrNull { it.rawValue == t } }

    /** Maps a domain op to concrete file edits against current local content. */
    private fun computeEdits(op: PendingOp, createdAt: Instant, overlay: Map<String, String?> = emptyMap()): List<FileEdit> {
        val project = op.project
        val findingsPath = "$project/FINDINGS.md"
        val reviewPath = "$project/review.md"
        val tasksPath = "$project/tasks.md"
        return when (op) {
            is PendingOp.AddFinding -> {
                if (writeContext.usesTeamJournal) return listOf(journalEdit(project, op.text, op.type, overlay))
                val file = FindingsFile(read(findingsPath, overlay) ?: "")
                file.add(project, op.text, FindingsFile.AddOptions(type = findingType(op.type), provenance = provenance()))
                listOf(FileEdit(findingsPath, file.content))
            }
            is PendingOp.EditFinding -> {
                val file = FindingsFile(read(findingsPath, overlay) ?: "")
                file.edit(project, op.match, op.newText)
                listOf(FileEdit(findingsPath, file.content))
            }
            is PendingOp.RemoveFinding -> {
                val file = FindingsFile(read(findingsPath, overlay) ?: "")
                file.remove(project, op.match)
                listOf(FileEdit(findingsPath, file.content))
            }
            is PendingOp.ApproveQueue -> {
                // access.ts `approveQueueItemDetailed`: approve means "this belongs in memory",
                // so it writes the finding when it is not already live, then dequeues.
                // `phren extract` queues candidates below autoAcceptThreshold without
                // writing them to FINDINGS.md, so for those the queue line is the only copy.
                val review = ReviewFile(read(reviewPath, overlay) ?: "")
                val needle = ReviewFile.findingsTextFor(op.line)
                val edits = mutableListOf<FileEdit>()
                if (needle.isNotEmpty()) {
                    val findings = FindingsFile(read(findingsPath, overlay) ?: "")
                    if (!findings.existsAsLiveFinding(needle)) {
                        // Team stores never line-splice FINDINGS.md; the add goes to the journal.
                        if (writeContext.usesTeamJournal) edits += journalEdit(project, needle, null, overlay)
                        else try {
                            // The observation's own provenance, not this device's: approving is not authoring.
                            findings.add(project, needle, FindingsFile.AddOptions(
                                provenance = ReviewFile.capturedProvenanceFor(op.line), queuedDate = ReviewFile.queuedDateFor(op.line)))
                            edits += FileEdit(findingsPath, findings.content)
                        } catch (_: PhrenKitError.Duplicate) {
                            // Present only in an archive block (the CLI's already_archived): just dequeue.
                        }
                        // Any other failure (a secret in the text) propagates, so the queue
                        // line stays rather than being dequeued over content never promoted.
                    }
                }
                review.approve(op.line)
                edits += FileEdit(reviewPath, review.content)
                edits
            }
            is PendingOp.RejectQueue -> {
                // access.ts:709 — remove the queue line AND the finding (missing tolerated).
                val review = ReviewFile(read(reviewPath, overlay) ?: "")
                review.reject(op.line)
                val edits = mutableListOf(FileEdit(reviewPath, review.content))
                val needle = ReviewFile.findingsTextFor(op.line)
                if (needle.isNotEmpty()) {
                    val findings = FindingsFile(read(findingsPath, overlay) ?: "")
                    if (runCatching { findings.remove(project, needle) }.isSuccess) {
                        edits += FileEdit(findingsPath, findings.content)
                    }
                }
                edits
            }
            is PendingOp.EditQueue -> {
                // access.ts:728 — rewrite the queue line, tolerantly edit the finding.
                val review = ReviewFile(read(reviewPath, overlay) ?: "")
                val oldNeedle = ReviewFile.findingsTextFor(op.line)
                val trimmed = review.edit(op.line, op.newText)
                val edits = mutableListOf(FileEdit(reviewPath, review.content))
                if (oldNeedle.isNotEmpty()) {
                    val findings = FindingsFile(read(findingsPath, overlay) ?: "")
                    if (runCatching { findings.edit(project, oldNeedle, trimmed) }.isSuccess) {
                        edits += FileEdit(findingsPath, findings.content)
                    }
                }
                edits
            }
            is PendingOp.AddNote -> {
                val path = "$project/notes/${op.date}.md"
                val file = NotesFile(project, op.date, read(path, overlay))
                file.add(op.text, op.time)
                listOf(FileEdit(path, file.render()))
            }
            is PendingOp.EditNote -> {
                val path = "$project/notes/${op.date}.md"
                val file = NotesFile(project, op.date, read(path, overlay))
                file.edit(op.stableId, op.text)
                listOf(FileEdit(path, file.render()))
            }
            is PendingOp.RemoveNote -> {
                val path = "$project/notes/${op.date}.md"
                val file = NotesFile(project, op.date, read(path, overlay))
                file.remove(op.stableId)
                // render() returns null when the last note was removed → delete file.
                listOf(FileEdit(path, file.render()))
            }
            is PendingOp.PromoteNote -> {
                // core/note.ts:13 — refuse if promoted; add finding; mark note.
                val notePath = "$project/notes/${op.date}.md"
                val notesFile = NotesFile(project, op.date, read(notePath, overlay))
                val note = notesFile.notes.firstOrNull { it.stableId == op.stableId }
                    ?: throw PhrenKitError.NotFound("No note matching \"nid:${op.stableId}\" was found.")
                if (note.promoted) throw PhrenKitError.Validation("Note nid:${op.stableId} has already been promoted.")
                if (writeContext.usesTeamJournal) {
                    val journal = journalEdit(project, note.text, op.findingType, overlay)
                    notesFile.markPromoted(op.stableId)
                    return listOf(journal, FileEdit(notePath, notesFile.render()))
                }
                val findings = FindingsFile(read(findingsPath, overlay) ?: "")
                findings.add(project, note.text, FindingsFile.AddOptions(type = findingType(op.findingType), provenance = provenance()))
                notesFile.markPromoted(op.stableId)
                listOf(FileEdit(findingsPath, findings.content), FileEdit(notePath, notesFile.render()))
            }
            is PendingOp.AddTask -> {
                val file = TasksFile(project, read(tasksPath, overlay))
                file.add(op.text, createdAt = ISO8601Dates.string(createdAt, fractionalSeconds = true))
                listOf(FileEdit(tasksPath, file.render()))
            }
            is PendingOp.CompleteTask -> {
                val file = TasksFile(project, read(tasksPath, overlay))
                file.complete(op.match)
                listOf(FileEdit(tasksPath, file.render()))
            }
            is PendingOp.RemoveTask -> {
                val file = TasksFile(project, read(tasksPath, overlay))
                file.remove(op.match)
                listOf(FileEdit(tasksPath, file.render()))
            }
            is PendingOp.UpdateTask -> {
                val file = TasksFile(project, read(tasksPath, overlay))
                file.update(
                    op.match,
                    TasksFile.Updates(
                        text = op.text,
                        priority = PhrenTask.Priority.from(op.priority),
                        section = op.section?.let { PhrenTask.Section.from(it) },
                    ),
                )
                listOf(FileEdit(tasksPath, file.render()))
            }
            is PendingOp.SetSkillEnabled -> listOf(
                FileEdit(SkillPreferences.PATH, SkillPreferences.setting(read(SkillPreferences.PATH, overlay), op.scope, op.name, op.enabled, op.expectedEnabled)),
            )
            is PendingOp.SaveAuthoredFile -> {
                val current = read(op.path, overlay)
                AuthoredFile.validate(op.path, current, op.expectedContent, op.content)
                if (op.expectedContent == null && LocalStore.isSkillPath(op.path)) {
                    val paths = store.allPaths().toMutableSet()
                    overlay.forEach { (candidate, value) -> if (value == null) paths -= candidate else paths += candidate }
                    AuthoredFile.conflictingSkillPath(op.path, paths.toList())?.let {
                        throw PhrenKitError.Duplicate("A skill with that name already exists at $it.")
                    }
                }
                listOf(FileEdit(op.path, op.content))
            }
            is PendingOp.DeleteAuthoredFile -> {
                AuthoredFile.validate(op.path, read(op.path, overlay), op.expectedContent, null)
                listOf(FileEdit(op.path, null))
            }
            is PendingOp.UpdateSkill -> {
                // Authored prose: the op holds the finished bytes, so replay is deterministic.
                if (!LocalStore.isSkillPath(op.path)) throw PhrenKitError.Validation("${op.path} is not a skill path.")
                if (op.content.isEmpty()) throw PhrenKitError.Validation("Refusing to save an empty skill.")
                SecretScanner.scan(op.content)?.let { throw PhrenKitError.Validation(it) }
                listOf(FileEdit(op.path, op.content))
            }
            is PendingOp.DeleteSkill -> {
                if (!LocalStore.isSkillPath(op.path)) throw PhrenKitError.Validation("${op.path} is not a skill path.")
                listOf(FileEdit(op.path, null))
            }
            is PendingOp.SetProjectKnobs -> {
                val path = "$project/${MachineRegistry.PROJECT_FILE}"
                if (!LocalStore.isProjectConfigPath(path)) throw PhrenKitError.Validation("$path cannot hold project settings.")
                val current = read(path, overlay)
                val next = op.knobs.apply(current ?: "")
                if (!(current == op.expectedContent || current == next)) {
                    throw PhrenKitError.Validation("$path changed since you opened it. Review the latest version before saving again.")
                }
                // Every knob back to "inherit" with no file to edit is a no-op.
                if (current == null && next.isEmpty()) emptyList() else listOf(FileEdit(path, next))
            }
            is PendingOp.SaveSchedules -> {
                val path = "$project/${SchedulesFile.FILE_NAME}"
                if (!LocalStore.isSchedulesPath(path)) throw PhrenKitError.Validation("$path cannot hold schedules.")
                val current = read(path, overlay)
                if (!(current == op.expectedContent || current == op.content)) {
                    throw PhrenKitError.Validation("$path changed since you opened it. Review the latest version before saving again.")
                }
                listOf(FileEdit(path, op.content))
            }
        }
    }

    companion object {
        const val LIVE_POLL_INTERVAL_MS = 7_000L
        private const val MAX_WRITE_ATTEMPTS = 3
        /** Stamped as `tool:` in the source comment (`phren-ios` on iOS). */
        const val TOOL_NAME = "phren-android"

        private fun megabytes(bytes: Int) = "%.1f MB".format(bytes / 1_048_576.0)
    }
}
