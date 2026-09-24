package com.phren.android

import com.phren.kit.ContentsPutResponse
import com.phren.kit.GitHubAPI
import com.phren.kit.GitTree
import com.phren.kit.InstantSerializer
import com.phren.kit.KeyValueStore
import com.phren.kit.LocalStore
import com.phren.kit.PendingOp
import com.phren.kit.PersistedState
import com.phren.kit.StoreDescriptor
import com.phren.kit.SyncEngine
import com.phren.kit.VersionedDocument
import com.phren.kit.VersionedList
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.UUID

// Port of Capture/CaptureTargets.swift, Capture/CaptureLog.swift and
// Intents/PhrenCapture.swift.

@Serializable
private data class CaptureTargetRef(
    override val schemaVersion: Int = 1,
    val storeId: String,
    val project: String,
) : VersionedDocument

private const val CAPTURE_SETTINGS_DOCUMENT = "quick capture settings"

data class StoreProjectRef(val storeId: String, val project: String)

/** The Settings-chosen default for voice/shortcut captures with no project named. */
object QuickCaptureDefault {
    private const val KEY = "phren.capture.defaultTarget"

    fun load(prefs: KeyValueStore): StoreProjectRef? =
        PersistedState.load(CaptureTargetRef.serializer(), 1, prefs, KEY, CAPTURE_SETTINGS_DOCUMENT).value?.let { StoreProjectRef(it.storeId, it.project) }

    fun save(prefs: KeyValueStore, storeId: String, project: String) {
        PersistedState.save(CaptureTargetRef.serializer(), 1, CaptureTargetRef(storeId = storeId, project = project), prefs, KEY, CAPTURE_SETTINGS_DOCUMENT)
    }

    fun clear(prefs: KeyValueStore) = prefs.remove(KEY)
}

/** The last project anything was captured into — written by every capture surface. */
object VoiceCaptureLastTarget {
    private const val KEY = "phren.voiceCapture.lastTarget"

    fun load(prefs: KeyValueStore): StoreProjectRef? =
        PersistedState.load(CaptureTargetRef.serializer(), 1, prefs, KEY, CAPTURE_SETTINGS_DOCUMENT).value?.let { StoreProjectRef(it.storeId, it.project) }

    fun save(prefs: KeyValueStore, storeId: String, project: String) {
        PersistedState.save(CaptureTargetRef.serializer(), 1, CaptureTargetRef(storeId = storeId, project = project), prefs, KEY, CAPTURE_SETTINGS_DOCUMENT)
    }
}

@Serializable
data class CaptureLogEntry(
    val id: String = UUID.randomUUID().toString(),
    @Serializable(with = InstantSerializer::class) val at: Instant = Instant.now(),
    val kind: Kind,
    val storeId: String,
    val project: String,
    val snippet: String,
    val source: Source,
) {
    @Serializable
    enum class Kind {
        @SerialName("note") NOTE, @SerialName("task") TASK;
        val label get() = if (this == NOTE) "Note" else "Task"
    }

    @Serializable
    enum class Source {
        /** Assistant, app shortcuts, or the quick-settings tile — the Siri/Shortcuts analogue. */
        @SerialName("siri") SIRI,
        @SerialName("app") APP;
        val label get() = if (this == SIRI) "Assistant / Shortcuts" else "In app"
    }

    val fingerprint: String get() = CaptureLog.fingerprint(kind, storeId, project, snippet)
}

/** The last 20 captures, for Settings → Recent captures. */
object CaptureLog {
    const val LIMIT = 20
    const val SNIPPET_LENGTH = 80
    private const val KEY = "phren.capture.log"
    private const val DOCUMENT = "recent captures"
    private val serializer = VersionedList.serializer(CaptureLogEntry.serializer())

    fun entries(prefs: KeyValueStore): List<CaptureLogEntry> =
        PersistedState.load(serializer, VersionedList.CURRENT, prefs, KEY, DOCUMENT).value?.items ?: emptyList()

    fun record(prefs: KeyValueStore, kind: CaptureLogEntry.Kind, storeId: String, project: String, text: String, source: CaptureLogEntry.Source) {
        val entry = CaptureLogEntry(kind = kind, storeId = storeId, project = project, snippet = snippet(text), source = source)
        PersistedState.save(serializer, VersionedList.CURRENT, VersionedList((listOf(entry) + entries(prefs)).take(LIMIT)), prefs, KEY, DOCUMENT)
    }

    fun clear(prefs: KeyValueStore) = prefs.remove(KEY)

    fun snippet(text: String): String {
        val collapsed = text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        return if (collapsed.length > SNIPPET_LENGTH) collapsed.take(SNIPPET_LENGTH) + "…" else collapsed
    }

    fun fingerprint(storeId: String, op: PendingOp): String? = when (op) {
        is PendingOp.AddNote -> fingerprint(CaptureLogEntry.Kind.NOTE, storeId, op.project, snippet(op.text))
        is PendingOp.AddTask -> fingerprint(CaptureLogEntry.Kind.TASK, storeId, op.project, snippet(op.text))
        else -> null
    }

    fun fingerprint(kind: CaptureLogEntry.Kind, storeId: String, project: String, snippet: String) =
        "${kind.name.lowercase()}|$storeId|$project|$snippet"
}

enum class CaptureSyncState(val label: String) { SYNCED("synced"), QUEUED("waiting to sync"), FAILED("needs attention") }

data class CaptureQueueState(val pending: Set<String> = emptySet(), val failed: Set<String> = emptySet()) {
    fun state(entry: CaptureLogEntry): CaptureSyncState = when (entry.fingerprint) {
        in failed -> CaptureSyncState.FAILED
        in pending -> CaptureSyncState.QUEUED
        else -> CaptureSyncState.SYNCED
    }

    companion object {
        suspend fun sample(model: AppModel): CaptureQueueState = CaptureQueueState(
            pending = model.pendingOps().mapNotNull { (storeId, op) -> CaptureLog.fingerprint(storeId, op) }.toSet(),
            failed = model.failedOps().mapNotNull { CaptureLog.fingerprint(it.storeId, it.op.op) }.toSet(),
        )
    }
}

/** A (store, project) a capture can land in. */
data class PhrenCaptureTarget(val storeId: String, val storeName: String, val project: String, val qualified: Boolean) {
    val entityId: String get() = "$storeId|$project"
    val displayName: String get() = if (qualified) "$project · $storeName" else project
    val spokenName: String get() = if (qualified) "$project in $storeName" else project
}

class PhrenCaptureException(message: String) : Exception(message) {
    companion object {
        val notSetUp get() = PhrenCaptureException("phren isn't set up yet — open the app to connect your store.")
        val noWritableStore get() = PhrenCaptureException("Your phren store is read-only. Your GitHub token needs Contents: Read and write on the store repo.")
        val nothingSynced get() = PhrenCaptureException("phren hasn't synced your store yet — open the app once and try again.")
        fun unknownProject(name: String) = PhrenCaptureException("phren has no project called $name.")
        fun rejected(reason: String) = PhrenCaptureException("phren couldn't save that: $reason")
    }
}

/**
 * The capture path shared by the in-app voice sheet, app shortcuts, the
 * assistant and the quick-settings tile. Works with the model alive (normal
 * enqueue) or cold (opens the store itself with an engine that refuses the
 * network, so the op lands in `pending-ops.json` for the next foreground sync).
 */
object PhrenCapture {
    sealed interface Resolution {
        data class Resolved(val target: PhrenCaptureTarget) : Resolution
        data class Ask(val prompt: String) : Resolution
    }

    suspend fun targets(model: AppModel): List<PhrenCaptureTarget> {
        if (model.storeContexts.isNotEmpty()) {
            return model.storeContexts.flatMap { c ->
                if (!c.descriptor.canPush) emptyList()
                else c.snapshot.projects.filter { !LocalStore.isReadOnlyProject(it.name) }
                    .map { PhrenCaptureTarget(c.id, c.descriptor.displayName, it.name, model.hasMultipleStores) }
            }.sortedWith(compareBy({ it.project }, { it.storeName }))
        }
        val descriptors = model.storedDescriptors()
        val qualified = descriptors.size > 1
        return descriptors.filter { it.canPush }.flatMap { d ->
            val store = openStore(model, d)
            store.allPaths().mapNotNull { it.split("/").takeIf { p -> p.size >= 2 }?.get(0) }
                .filter { !LocalStore.isReadOnlyProject(it) && LocalStore.isReadableProjectDirName(it) }
                .toSortedSet()
                .map { PhrenCaptureTarget(d.id, d.displayName, it, qualified) }
        }.sortedWith(compareBy({ it.project }, { it.storeName }))
    }

    /** Named project → that; else the Settings default; else ask. */
    suspend fun resolveTarget(model: AppModel, projectName: String?): Resolution {
        val available = targets(model)
        if (available.isEmpty()) {
            val descriptors = model.storedDescriptors()
            if (descriptors.isEmpty()) throw PhrenCaptureException.notSetUp
            throw if (descriptors.any { it.canPush }) PhrenCaptureException.nothingSynced else PhrenCaptureException.noWritableStore
        }
        if (projectName != null) {
            val matches = ProjectMatcher.candidates(projectName, available)
            return when (matches.size) {
                0 -> throw PhrenCaptureException.unknownProject(projectName)
                1 -> Resolution.Resolved(matches.single())
                else -> Resolution.Ask("Which project?")
            }
        }
        val preferred = QuickCaptureDefault.load(model.prefs) ?: return Resolution.Ask("Which project?")
        val match = available.firstOrNull { it.storeId == preferred.storeId && it.project == preferred.project }
            ?: return Resolution.Ask("Your default capture project ${preferred.project} isn't available any more. Which project?")
        return Resolution.Resolved(match)
    }

    suspend fun capture(model: AppModel, op: PendingOp, target: PhrenCaptureTarget, source: CaptureLogEntry.Source) {
        try {
            if (model.storeContexts.any { it.id == target.storeId }) {
                model.enqueue(op, target.storeId)
                model.refresh()
            } else {
                val descriptor = model.storedDescriptors().firstOrNull { it.id == target.storeId } ?: throw PhrenCaptureException.notSetUp
                if (!descriptor.canPush) throw StoreWriteError.ReadOnly(descriptor.displayName)
                offlineEngine(model, descriptor).enqueue(op)
            }
        } catch (e: StoreWriteError) {
            throw e
        } catch (e: PhrenCaptureException) {
            throw e
        } catch (e: Exception) {
            throw PhrenCaptureException.rejected(e.message ?: e.toString())
        }
        VoiceCaptureLastTarget.save(model.prefs, target.storeId, target.project)
        when (op) {
            is PendingOp.AddNote -> CaptureLog.record(model.prefs, CaptureLogEntry.Kind.NOTE, target.storeId, target.project, op.text, source)
            is PendingOp.AddTask -> CaptureLog.record(model.prefs, CaptureLogEntry.Kind.TASK, target.storeId, target.project, op.text, source)
            else -> {}
        }
    }

    private val offlineStores = mutableMapOf<String, LocalStore>()
    private val offlineEngines = mutableMapOf<String, SyncEngine>()

    private fun openStore(model: AppModel, d: StoreDescriptor): LocalStore = synchronized(offlineStores) {
        offlineStores.getOrPut(d.id) { LocalStore(model.storeDirectory(d), d.owner, d.name, d.branch) }
    }

    private fun offlineEngine(model: AppModel, d: StoreDescriptor): SyncEngine = synchronized(offlineEngines) {
        offlineEngines.getOrPut(d.id) { SyncEngine(OfflineGitHubAPI, openStore(model, d), model.storeDirectory(d)) }
    }

    /** Forget cold-path handles once the live model owns the stores. */
    fun releaseOffline() = synchronized(offlineEngines) {
        offlineEngines.values.forEach { it.close() }
        offlineEngines.clear()
        synchronized(offlineStores) { offlineStores.clear() }
    }
}

/**
 * Spoken project names (ProjectEntityQuery.entities(matching:)): everything
 * but letters and digits is stripped from both sides, so "alpha lens"
 * matches `alphalens`. Every candidate that survives comes back ranked —
 * more than one means ask, never guess.
 */
object ProjectMatcher {
    fun normalized(value: String) = value.lowercase().filter { it.isLetterOrDigit() }

    fun candidates(spoken: String, available: List<PhrenCaptureTarget>): List<PhrenCaptureTarget> {
        val needle = normalized(spoken)
        if (needle.isEmpty()) return available
        val ranked = available.mapNotNull { target ->
            val name = normalized(target.project)
            if (target.qualified) {
                val store = normalized(target.storeName)
                if (needle == name + store) return@mapNotNull 0 to target
                if (store.isNotEmpty() && needle.contains(name) && needle.contains(store)) return@mapNotNull 1 to target
            }
            when {
                name == needle -> 0 to target
                name.startsWith(needle) -> 2 to target
                name.contains(needle) -> 3 to target
                name.length >= 3 && needle.contains(name) -> 4 to target
                else -> null
            }
        }
        return ranked.sortedWith(compareBy({ it.first }, { it.second.project }, { it.second.storeName })).map { it.second }
    }
}

private object OfflineGitHubAPI : GitHubAPI {
    private fun notNow(): Nothing = throw java.io.IOException("Captured offline — phren pushes this the next time you open the app.")
    override suspend fun headSha(owner: String, repo: String, branch: String): String? = notNow()
    override suspend fun tree(owner: String, repo: String, sha: String): GitTree = notNow()
    override suspend fun blob(owner: String, repo: String, sha: String): ByteArray = notNow()
    override suspend fun putFile(owner: String, repo: String, path: String, branch: String, content: ByteArray, message: String, sha: String?): ContentsPutResponse = notNow()
    override suspend fun deleteFile(owner: String, repo: String, path: String, branch: String, message: String, sha: String) = notNow()
}
