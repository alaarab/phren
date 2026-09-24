package com.phren.android

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.phren.android.widget.WidgetBridge
import com.phren.kit.ColdDocRef
import com.phren.kit.ColdSummary
import com.phren.kit.Finding
import com.phren.kit.GitHubClient
import com.phren.kit.GitHubRepo
import com.phren.kit.GitHubUser
import com.phren.kit.KeychainStore
import com.phren.kit.LocalStore
import com.phren.kit.Note
import com.phren.kit.PendingOp
import com.phren.kit.PersistedState
import com.phren.kit.ProjectQueueItem
import com.phren.kit.QueuedOp
import com.phren.kit.SearchIndex
import com.phren.kit.Skill
import com.phren.kit.SkillPreferences
import com.phren.kit.GraphBuilder
import com.phren.kit.GraphPayload
import com.phren.kit.GitHubError
import com.phren.kit.MachineRegistry
import com.phren.kit.StorageIssue
import com.phren.kit.StorageIssueLog
import com.phren.kit.StoreDescriptor
import com.phren.kit.StoresManifest
import com.phren.kit.SyncEngine
import com.phren.kit.TaskDoc
import com.phren.kit.TeamBootstrap
import com.phren.kit.TopicDocument
import com.phren.kit.Truth
import com.phren.kit.VersionedList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** One attached store: its descriptor, local mirror, engine, and last parsed snapshot. */
class StoreContext(descriptor: StoreDescriptor, val store: LocalStore, val engine: SyncEngine) {
    var descriptor by mutableStateOf(descriptor)
        private set
    var snapshot by mutableStateOf(LocalStore.Snapshot.empty)
    var status by mutableStateOf(SyncEngine.Status())
    var coldSummaries by mutableStateOf<Map<String, ColdSummary>>(emptyMap())
    val id: String = descriptor.id

    fun updateCanPush(canPush: Boolean) { descriptor = descriptor.copy(canPush = canPush) }
}

data class StoreProject(val storeId: String, val storeName: String, val project: com.phren.kit.Project) {
    val id: String get() = "$storeId/${project.name}"
}

data class StoreQueueEntry(val storeId: String, val storeName: String, val entry: ProjectQueueItem) {
    val id: String get() = "$storeId/${entry.id}"
}

data class FailedOpEntry(val storeId: String, val storeName: String, val op: QueuedOp) {
    val id: String get() = op.id
}

data class StoreTaskDoc(val storeId: String, val storeName: String, val doc: TaskDoc)

/** The app's tabs, in MainTabView display order. */
enum class AppTab { PROJECTS, AGENTS, TASKS, MEMORY, SETTINGS }

/** A skill plus the store it came from. */
data class StoreSkill(val storeId: String, val storeName: String, val skill: Skill) {
    val id: String get() = "$storeId/${skill.path}"
}

sealed class StoreWriteError(message: String) : Exception(message) {
    class StoreNotOpen(id: String) : StoreWriteError("Store $id is not open.")
    class ReadOnly(name: String) : StoreWriteError("$name is read-only — your GitHub token can't push to it.")
}

/**
 * Root state (port of AppModel.swift): auth, attached stores, merged views,
 * sync status. Compose observes its snapshot-state fields directly.
 */
class AppModel(private val context: Context) {
    enum class Phase { LOADING, SIGNED_OUT, PICKING_REPO, INITIAL_SYNC, READY }

    val prefs = PrefsStore.of(context)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    var phase by mutableStateOf(Phase.LOADING)
        private set
    var user by mutableStateOf<GitHubUser?>(null)
        private set
    val storeContexts = mutableStateListOf<StoreContext>()
    var searchIndex by mutableStateOf(SearchIndex())
        private set
    var syncStatus by mutableStateOf(SyncEngine.Status())
        private set
    var storeFilter by mutableStateOf<String?>(null)
    var lastActionError by mutableStateOf<String?>(null)
    var storageIssues by mutableStateOf<List<StorageIssue>>(emptyList())
        private set
    private var lastSurfacedIssueId: String? = null
    var selectedTab by mutableStateOf(AppTab.PROJECTS)
    var authenticationMessage by mutableStateOf<String?>(null)
        private set
    private var authenticationGeneration = java.util.UUID.randomUUID()
    private var foreground = true
    private var liveGeneration = java.util.UUID.randomUUID()
    private var indexedSnapshots = mapOf<String, String>()
    var searchRevision by mutableStateOf(0)
        private set
    var pendingChatVersion by mutableStateOf(0)
    var pendingProjectVersion by mutableStateOf(0)
    data class PendingSchedule(val project: String, val scheduleID: String)
    var pendingSchedule by mutableStateOf<PendingSchedule?>(null)
        private set
    var pendingScheduleVersion by mutableStateOf(0)
    var showingMemoryMaintenance by mutableStateOf(false)
    var showingMemoryConnection by mutableStateOf(false)

    fun openScheduleHistory(project: String, scheduleID: String) {
        pendingSchedule = PendingSchedule(project, scheduleID)
        pendingScheduleVersion += 1
        selectedTab = AppTab.AGENTS
    }

    fun clearPendingSchedule() { pendingSchedule = null }
    var storesManifest by mutableStateOf(StoresManifest())
        private set
    private var lastRegistryRaw = mapOf<String, String>()
    val storeRoles = mutableStateMapOf<String, String>()
    private val appliedJournalRouting = mutableMapOf<String, Boolean>()

    val client = GitHubClient()

    val storeDescriptors: List<StoreDescriptor> get() = storeContexts.map { it.descriptor }
    val hasMultipleStores: Boolean get() = storeContexts.size > 1

    fun storeName(id: String): String = storeContexts.firstOrNull { it.id == id }?.descriptor?.displayName ?: id
    fun canPush(storeId: String): Boolean = storeContexts.firstOrNull { it.id == storeId }?.descriptor?.canPush ?: true
    fun canWrite(storeId: String, project: String): Boolean = canPush(storeId) && !LocalStore.isReadOnlyProject(project)
    val writableProjects: List<StoreProject> get() = mergedProjects.filter { canWrite(it.storeId, it.project.name) }
    fun usesTeamJournal(storeId: String): Boolean = storeRoles[storeId] == "team"

    private val filteredContexts: List<StoreContext>
        get() = storeFilter?.let { f -> storeContexts.filter { it.id == f } } ?: storeContexts.toList()

    val mergedProjects: List<StoreProject>
        get() = filteredContexts.flatMap { c -> c.snapshot.projects.map { StoreProject(c.id, c.descriptor.displayName, it) } }
            .sortedWith(compareBy({ it.project.name }, { it.storeName }))

    val mergedReviewQueue: List<StoreQueueEntry>
        get() = filteredContexts.flatMap { c -> c.snapshot.reviewQueue.map { c to it } }
            .sortedWith { a, b -> LocalStore.reviewQueueComparator.compare(a.second, b.second) }
            .map { (c, item) -> StoreQueueEntry(c.id, c.descriptor.displayName, item) }

    val mergedTaskDocs: List<StoreTaskDoc>
        get() = filteredContexts.flatMap { c -> c.snapshot.tasks.entries.sortedBy { it.key }.map { StoreTaskDoc(c.id, c.descriptor.displayName, it.value) } }

    fun snapshot(storeId: String): LocalStore.Snapshot = storeContexts.firstOrNull { it.id == storeId }?.snapshot ?: LocalStore.Snapshot.empty
    fun findings(storeId: String, project: String): List<Finding> = snapshot(storeId).findings[project] ?: emptyList()
    fun notes(storeId: String, project: String): List<Note> = snapshot(storeId).notes[project] ?: emptyList()
    fun truths(storeId: String, project: String): List<Truth> = snapshot(storeId).truths[project] ?: emptyList()
    fun summary(storeId: String, project: String): String? = snapshot(storeId).summaries[project]
    fun consolidatedDate(storeId: String, project: String): String? = snapshot(storeId).consolidated[project]

    val totalReviewCount: Int get() = storeContexts.sumOf { it.snapshot.reviewQueue.size }

    fun coldSummary(storeId: String, project: String): ColdSummary? = storeContexts.firstOrNull { it.id == storeId }?.coldSummaries?.get(project)

    suspend fun coldTopics(storeId: String, project: String): List<ColdDocRef> =
        storeContexts.firstOrNull { it.id == storeId }?.engine?.coldStore?.let { cs -> withContext(Dispatchers.IO) { cs.topics(project) } } ?: emptyList()

    suspend fun coldDocument(storeId: String, path: String): TopicDocument {
        val c = storeContexts.firstOrNull { it.id == storeId } ?: throw StoreWriteError.StoreNotOpen(storeId)
        val document = c.engine.coldDocument(path)
        c.coldSummaries = withContext(Dispatchers.IO) { c.engine.coldStore.projectSummaries() }
        return document
    }

    /** `stores.yaml` claims this project for a different, non-primary store. */
    fun claimingStoreName(item: StoreProject): String? {
        val physical = storeContexts.firstOrNull { it.id == item.storeId }?.descriptor?.displayName
        return storesManifest.claimingEntry(item.project.name, physical)?.name
    }

    fun claimedElsewhere(storeId: String): List<Pair<String, Int>> {
        val c = storeContexts.firstOrNull { it.id == storeId } ?: return emptyList()
        val counts = sortedMapOf<String, Int>()
        c.snapshot.projects.forEach { p ->
            storesManifest.claimingEntry(p.name, c.descriptor.displayName)?.let { counts[it.name] = (counts[it.name] ?: 0) + 1 }
        }
        return counts.map { it.key to it.value }
    }

    /** Project names that differ only by `-`/`_`/case across attached stores. */
    val duplicateProjectGroups: List<List<String>>
        get() {
            val names = storeContexts.flatMap { c -> c.snapshot.projects.map { it.name } }.toSet()
            return names.groupBy { it.lowercase().replace("-", "").replace("_", "") }.values
                .filter { it.size > 1 }.map { it.sorted() }.sortedBy { it[0] }
        }

    private suspend fun refreshStoreRegistry() {
        val raws = mutableMapOf<String, String>()
        val manifests = mutableListOf<StoresManifest>()
        val bootstraps = mutableMapOf<String, TeamBootstrap>()
        for (c in storeContexts) {
            val registryRaw = withContext(Dispatchers.IO) { c.store.read("stores.yaml") }
            val bootstrapRaw = withContext(Dispatchers.IO) { c.store.read(TeamBootstrap.FILE_NAME) }
            raws[c.id] = "${registryRaw ?: ""}\u0000${bootstrapRaw ?: ""}"
            registryRaw?.let { StoresManifest.parse(it) }?.takeIf { it.stores.isNotEmpty() }?.let(manifests::add)
            bootstrapRaw?.let { TeamBootstrap.parse(it) }?.let { bootstraps[c.id] = it }
        }
        if (raws == lastRegistryRaw) return
        lastRegistryRaw = raws
        storesManifest = manifests.firstOrNull { m -> m.stores.any { it.isPrimary } } ?: manifests.firstOrNull() ?: StoresManifest.empty
        // A store's role: its own `.phren-team.yaml` first, then a matching
        // `stores.yaml` entry. A role nothing declares is left alone.
        storeRoles.clear()
        for (c in storeContexts) {
            val role = bootstraps[c.id]?.role ?: storesManifest.stores.firstOrNull { it.name == c.descriptor.displayName }?.role
            if (role != null) storeRoles[c.id] = role
        }
    }

    private suspend fun applyWriteContexts() {
        for (c in storeContexts) {
            val journal = usesTeamJournal(c.id)
            if (appliedJournalRouting[c.id] == journal) continue
            appliedJournalRouting[c.id] = journal
            c.engine.setWriteContext(SyncEngine.WriteContext(user?.login, deviceName(context), journal))
        }
    }

    // Lifecycle

    fun bootstrap() = scope.launch {
        if (phase != Phase.LOADING) return@launch
        val generation = authenticationGeneration
        val stored = withContext(Dispatchers.IO) { KeychainStore.load() }
        if (generation != authenticationGeneration) return@launch
        if (stored == null) {
            selectedTab = AppTab.AGENTS
            phase = Phase.SIGNED_OUT
            return@launch
        }
        client.setToken(stored.token)
        user = stored.user
        openSavedStores()
        // Local data and navigation are available even while /user is stalled.
        if (!refreshAccount()) return@launch
        refreshStorePermissions()
        pullAllAndGoLive()
    }

    /** Debug launches only: the iOS UI-test stores, never synced. */
    fun bootstrapFixture(kind: String) = scope.launch {
        if (phase != Phase.LOADING) return@launch
        val owners = if (kind == "store-tour") listOf("sample") else listOf("sample", "team")
        for (owner in owners) {
            val dir = File(context.cacheDir, "ui-tests-${java.util.UUID.randomUUID()}")
            val (store, engine) = withContext(Dispatchers.IO) {
                val store = LocalStore(dir, owner, "brain", "main")
                when {
                    kind == "store-tour" -> com.phren.android.debug.UITestStores.populateTour(store)
                    kind == "memory" && owner == "sample" -> com.phren.android.debug.UITestStores.populateMemory(store)
                    else -> {
                        if (kind == "workflow") com.phren.android.debug.UITestStores.populateWorkflow(store, owner)
                        store.write("demo/FINDINGS.md", "# Findings\n\n- [pattern] Cache repeated requests for offline use\n- [pattern] Retry sync after reconnecting\n- [decision] Connect the phone graph to desktop memory\n", null)
                        store.write("demo/skills/audit.md", com.phren.kit.SkillFile.template(name = "audit", description = "Review the project", instructions = "Run the checks."), null)
                    }
                }
                store to SyncEngine(client, store, dir)
            }
            storeContexts += StoreContext(StoreDescriptor.of(owner, "brain", "main", true), store, engine)
        }
        refresh()
        phase = Phase.READY
    }

    private suspend fun openSavedStores() {
        PhrenCapture.releaseOffline()
        for (d in storedDescriptors()) if (storeContexts.none { it.id == d.id }) openContext(d)
        refresh()
        phase = if (storeContexts.isEmpty()) Phase.PICKING_REPO else Phase.READY
    }

    /**
     * Only an explicit credential rejection (401) invalidates a saved sign-in.
     * Offline, timeouts and server errors leave it; the sync loop retries.
     */
    private suspend fun refreshAccount(): Boolean {
        val generation = authenticationGeneration
        val stored = withContext(Dispatchers.IO) { KeychainStore.load() }
        if (stored == null || generation != authenticationGeneration) return false
        try {
            val verified = client.currentUser()
            if (generation != authenticationGeneration) return false
            user = verified
            try { withContext(Dispatchers.IO) { KeychainStore.save(stored.copy(user = verified)) } } catch (_: Exception) {}
            appliedJournalRouting.clear()
            applyWriteContexts()
        } catch (e: GitHubError.Http) {
            if (e.status != 401) return generation == authenticationGeneration
            if (generation != authenticationGeneration) return false
            val invalidation = java.util.UUID.randomUUID()
            authenticationGeneration = invalidation
            withContext(Dispatchers.IO) { KeychainStore.delete() }
            client.setToken(null)
            stopLiveAll()
            if (invalidation != authenticationGeneration) return false
            authenticationMessage = "GitHub no longer accepts your sign-in. Sign in again to reconnect. Your saved projects and pending changes are still here."
            phase = Phase.SIGNED_OUT
            return false
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            // A failed request says nothing about whether the token is valid.
        }
        return generation == authenticationGeneration
    }

    fun storedDescriptors(): List<StoreDescriptor> =
        PersistedState.load(registrySerializer, VersionedList.CURRENT, prefs, STORES_KEY, REGISTRY_DOCUMENT).value?.items ?: emptyList()

    private fun persistDescriptors(descriptors: List<StoreDescriptor>) {
        PersistedState.save(registrySerializer, VersionedList.CURRENT, VersionedList(descriptors), prefs, STORES_KEY, REGISTRY_DOCUMENT)
    }

    fun storeDirectory(d: StoreDescriptor): File = LocalStore.defaultDirectory(context.filesDir, d.owner, d.name)

    fun enterForeground() = scope.launch {
        foreground = true
        if (phase != Phase.READY) return@launch
        startLiveAll()
        refreshAccount()
    }

    fun enterBackground() = scope.launch { foreground = false; stopLiveAll() }

    private suspend fun stopLiveAll() {
        liveGeneration = java.util.UUID.randomUUID()
        storeContexts.forEach { it.engine.stopLive() }
    }

    /** Staggered by a second so N stores don't wake the radio together. */
    private suspend fun startLiveAll() {
        if (!foreground) return
        val generation = liveGeneration
        storeContexts.toList().forEachIndexed { i, c ->
            if (i > 0) delay(1_000)
            if (!foreground || liveGeneration != generation) return
            if (storeContexts.none { it === c }) return@forEachIndexed
            c.engine.startLive()
        }
    }

    private suspend fun pullAllAndGoLive() {
        pullAll()
        refresh()
        startLiveAll()
    }

    private suspend fun pullAll() {
        storeContexts.toList().map { c -> scope.async { c.engine.pull(force = true) } }.awaitAll()
    }

    suspend fun signIn(token: String, kind: KeychainStore.TokenKind) {
        val generation = java.util.UUID.randomUUID()
        authenticationGeneration = generation
        val trimmed = token.trim()
        client.setToken(trimmed)
        val u = client.currentUser()
        if (generation != authenticationGeneration) throw kotlinx.coroutines.CancellationException()
        withContext(Dispatchers.IO) { KeychainStore.save(KeychainStore.StoredToken(trimmed, kind, u)) }
        user = u
        authenticationMessage = null
        appliedJournalRouting.clear()
        openSavedStores()
        pullAllAndGoLive()
    }

    suspend fun signOut() {
        authenticationGeneration = java.util.UUID.randomUUID()
        liveGeneration = java.util.UUID.randomUUID()
        val wipeFailures = mutableListOf<String>()
        for (c in storeContexts) {
            c.engine.stopLive()
            c.engine.close()
            try { withContext(Dispatchers.IO) { c.store.wipe() } } catch (e: Exception) { wipeFailures += "${c.descriptor.displayName}: ${e.message}" }
        }
        KeychainStore.delete()
        prefs.remove(STORES_KEY)
        client.setToken(null)
        user = null
        authenticationMessage = null
        storeContexts.clear()
        storeFilter = null
        storesManifest = StoresManifest()
        storeRoles.clear()
        appliedJournalRouting.clear()
        lastRegistryRaw = emptyMap()
        searchIndex = SearchIndex()
        syncStatus = SyncEngine.Status()
        StorageIssueLog.shared.removeAll()
        storageIssues = emptyList()
        lastSurfacedIssueId = null
        indexedSnapshots = emptyMap()
        searchRevision += 1
        if (wipeFailures.isNotEmpty()) {
            authenticationMessage = "Signed out, but this device's copy couldn't be deleted (${wipeFailures.joinToString("; ")}). Its files are still in the app's data folder."
        }
        WidgetBridge.publish(context, this)
        phase = Phase.SIGNED_OUT
    }

    suspend fun addStore(repo: GitHubRepo) {
        val descriptor = StoreDescriptor.of(repo.owner.login, repo.name, repo.defaultBranch, repo.permissions?.push ?: true)
        if (storeContexts.any { it.id == descriptor.id }) return
        val firstStore = storeContexts.isEmpty()
        if (firstStore) phase = Phase.INITIAL_SYNC
        PhrenCapture.releaseOffline()
        openContext(descriptor)
        persistDescriptors(storeDescriptors)
        storeContexts.firstOrNull { it.id == descriptor.id }?.let { c ->
            c.engine.pull(force = true)
            refresh()
            c.engine.startLive()
        }
        if (firstStore) phase = if (storeContexts.isEmpty()) Phase.PICKING_REPO else Phase.READY
    }

    /** Deletes only this device's local copy. */
    suspend fun removeStore(id: String) {
        val c = storeContexts.firstOrNull { it.id == id } ?: return
        c.engine.stopLive()
        c.engine.close()
        try { withContext(Dispatchers.IO) { c.store.wipe() } } catch (e: Exception) {
            lastActionError = "Removed ${c.descriptor.displayName}, but its copy on this device couldn't be deleted: ${e.message}"
        }
        storeContexts.remove(c)
        if (storeFilter == id) storeFilter = null
        storeRoles.remove(id)
        appliedJournalRouting.remove(id)
        lastRegistryRaw = lastRegistryRaw - id
        persistDescriptors(storeDescriptors)
        refresh()
        if (storeContexts.isEmpty()) phase = Phase.PICKING_REPO
    }

    private suspend fun openContext(descriptor: StoreDescriptor) {
        try {
            val directory = storeDirectory(descriptor)
            val (store, engine) = withContext(Dispatchers.IO) {
                val store = LocalStore(directory, descriptor.owner, descriptor.name, descriptor.branch)
                store to SyncEngine(client, store, directory)
            }
            storeContexts += StoreContext(descriptor, store, engine)
            appliedJournalRouting.remove(descriptor.id)
            engine.setOnUpdate { update ->
                scope.launch { if (update == SyncEngine.Update.CONTENT) refresh() else refreshStatus() }
            }
        } catch (e: Exception) {
            lastActionError = e.message
        }
    }

    private var refreshing = false
    private var refreshAgain = false

    /** Re-reads every store's snapshot and status. Coalesces bursts of engine updates. */
    suspend fun refresh() {
        if (refreshing) { refreshAgain = true; return }
        refreshing = true
        try {
            do {
                refreshAgain = false
                for (c in storeContexts.toList()) {
                    val (snap, status, cold) = withContext(Dispatchers.IO) {
                        Triple(c.store.snapshot(), c.engine.currentStatus(), c.engine.coldStore.projectSummaries())
                    }
                    if (c.snapshot.revision != snap.revision) c.snapshot = snap
                    if (c.status != status) c.status = status
                    if (c.coldSummaries != cold) c.coldSummaries = cold
                }
                val snapshots = storeContexts.map { it.id to it.snapshot }
                val revisions = snapshots.associate { it.first to it.second.revision }
                if (revisions != indexedSnapshots) {
                    searchIndex = withContext(Dispatchers.Default) { SearchIndex.of(snapshots) }
                    indexedSnapshots = revisions
                    com.phren.android.features.SpeechSettings.rememberProjects(prefs, snapshots.flatMap { it.second.projects.map { p -> p.name } })
                    searchRevision += 1
                }
                syncStatus = aggregateStatus()
                collectStorageIssues()
                refreshStoreRegistry()
                applyWriteContexts()
                WidgetBridge.publish(context, this)
                AppShortcuts.donateProjects(context, this)
            } while (refreshAgain)
        } finally {
            refreshing = false
        }
    }

    /** A status-only engine update: nothing in the local cache moved. */
    private suspend fun refreshStatus() {
        for (c in storeContexts.toList()) {
            val status = c.engine.currentStatus()
            if (c.status != status) c.status = status
        }
        val status = aggregateStatus()
        if (syncStatus != status) syncStatus = status
        collectStorageIssues()
        WidgetBridge.publish(context, this)
    }

    private fun collectStorageIssues() {
        val issues = StorageIssueLog.shared.issues
        val latest = issues.lastOrNull() ?: return
        if (latest.id == lastSurfacedIssueId) return
        storageIssues = issues
        lastSurfacedIssueId = latest.id
        lastActionError = latest.userMessage
    }

    private fun aggregateStatus(): SyncEngine.Status {
        if (storeContexts.isEmpty()) return SyncEngine.Status()
        val statuses = storeContexts.map { it.status }
        val timestamps = statuses.mapNotNull { it.lastSyncedAt }
        return SyncEngine.Status(
            isLive = statuses.all { it.isLive },
            isSyncing = statuses.any { it.isSyncing },
            lastSyncedAt = if (timestamps.size == statuses.size) timestamps.minOrNull() else null,
            pendingCount = statuses.sumOf { it.pendingCount },
            failedCount = statuses.sumOf { it.failedCount },
            lastError = statuses.firstNotNullOfOrNull { it.lastError },
        )
    }

    suspend fun pullToRefresh() {
        if (!refreshAccount()) return
        pullAll()
        refreshStorePermissions()
        refresh()
    }

    private suspend fun refreshStorePermissions() {
        var changed = false
        for (c in storeContexts) {
            val repo = try { client.repo(c.descriptor.owner, c.descriptor.name) } catch (_: Exception) { continue }
            val canPush = repo.permissions?.push ?: true
            if (canPush != c.descriptor.canPush) { c.updateCanPush(canPush); changed = true }
        }
        if (changed) persistDescriptors(storeDescriptors)
    }

    // Skills

    val mergedSkills: List<StoreSkill>
        get() = filteredContexts.flatMap { c -> c.snapshot.skills.map { StoreSkill(c.id, c.descriptor.displayName, it) } }

    suspend fun saveDocument(path: String, content: String, expectedContent: String?, storeId: String) {
        enqueue(PendingOp.SaveAuthoredFile(path, content, expectedContent), storeId)
        refresh()
    }

    suspend fun deleteSkill(entry: StoreSkill) {
        enqueue(PendingOp.DeleteAuthoredFile(entry.skill.path, entry.skill.content), entry.storeId)
        refresh()
    }

    /** Moves a skill to `global` or another project within its own store. */
    suspend fun moveSkill(entry: StoreSkill, scope: String) {
        val c = storeContexts.firstOrNull { it.id == entry.storeId } ?: throw StoreWriteError.StoreNotOpen(entry.storeId)
        if (!c.descriptor.canPush) throw StoreWriteError.ReadOnly(c.descriptor.displayName)
        c.engine.moveSkill(entry.skill, scope)
        refresh()
    }

    fun instructions(scope: String, storeId: String): String? = snapshot(storeId).instructions[scope]
    fun instructionsPath(scope: String, storeId: String): String =
        snapshot(storeId).instructionPaths[scope] ?: "$scope/${com.phren.kit.AgentInstructions.FILE_NAME}"
    fun skills(storeId: String): List<Skill> = snapshot(storeId).skills
    fun skillPreferences(storeId: String): SkillPreferences = SkillPreferences.parse(snapshot(storeId).skillPreferencesContent)

    suspend fun setSkillEnabled(entry: StoreSkill, enabled: Boolean) {
        val current = skillPreferences(entry.storeId)
        val scope = entry.skill.scope.source
        enqueue(PendingOp.SetSkillEnabled(scope, entry.skill.name, enabled, current.explicitSetting(scope, entry.skill.name)), entry.storeId)
        refresh()
    }

    fun machineRegistry(storeId: String): MachineRegistry = snapshot(storeId).machines

    // Graph

    /** One store at a time; node identities stay CLI-compatible. */
    suspend fun graphPayload(storeId: String, focusProject: String?): GraphPayload {
        val c = storeContexts.firstOrNull { it.id == storeId } ?: throw StoreWriteError.StoreNotOpen(storeId)
        val input = withContext(Dispatchers.IO) { c.store.graphInput(c.id) }
        if (focusProject != null && focusProject !in input.projects) return GraphPayload(emptyList(), emptyList(), emptyList(), 0)
        return withContext(Dispatchers.Default) { GraphBuilder.build(input, focusProject) }
    }

    // Mutations

    /** Fire-and-forget from a view: errors land in [lastActionError]. */
    fun perform(op: PendingOp, storeId: String) = scope.launch { performNow(op, storeId) }

    suspend fun performNow(op: PendingOp, storeId: String) {
        try {
            enqueue(op, storeId)
            lastActionError = null
        } catch (e: StoreWriteError) {
            lastActionError = e.message
            return
        } catch (e: Exception) {
            lastActionError = e.message
        }
        refresh()
    }

    suspend fun enqueue(op: PendingOp, storeId: String) {
        val c = storeContexts.firstOrNull { it.id == storeId } ?: throw StoreWriteError.StoreNotOpen(storeId)
        if (!c.descriptor.canPush) throw StoreWriteError.ReadOnly(c.descriptor.displayName)
        c.engine.enqueue(op)
    }

    suspend fun retryFailedOps() {
        storeContexts.forEach { it.engine.retryFailed() }
        refresh()
    }

    suspend fun discardFailedOp(storeId: String, id: String) {
        storeContexts.firstOrNull { it.id == storeId }?.engine?.discardFailed(id)
        refresh()
    }

    suspend fun failedOps(): List<FailedOpEntry> = storeContexts.flatMap { c ->
        c.engine.failedOps().map { FailedOpEntry(c.id, c.descriptor.displayName, it) }
    }

    suspend fun pendingOps(): List<Pair<String, PendingOp>> = storeContexts.flatMap { c ->
        c.engine.pendingOps().map { c.id to it.op }
    }

    companion object {
        private const val STORES_KEY = "phren.stores"
        private const val REGISTRY_DOCUMENT = "store settings"
        private val registrySerializer = VersionedList.serializer(StoreDescriptor.serializer())
        private val NOTE_STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss").withZone(ZoneOffset.UTC)

        /** UTC date + time for a new note — `new Date().toISOString()` sliced like the CLI. */
        fun nowNoteTimestamp(): Pair<String, String> {
            val iso = NOTE_STAMP.format(Instant.now())
            return iso.take(10) to iso.takeLast(8)
        }
    }
}
