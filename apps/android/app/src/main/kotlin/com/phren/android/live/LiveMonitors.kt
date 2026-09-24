package com.phren.android.live

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.phren.kit.LiveAgentSession
import com.phren.kit.LiveCapabilities
import com.phren.kit.LiveHost
import com.phren.kit.LiveOverviewFrame
import com.phren.kit.LiveSessionPreferences
import com.phren.kit.LiveWorkspaces
import com.phren.kit.PhrenKitError
import com.phren.kit.SessionProject
import kotlinx.serialization.json.Json
import com.phren.kit.live.DeviceKey
import com.phren.kit.live.LiveConnectionError
import com.phren.kit.live.PhrenConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException

/** How long an answer reads as live. */
const val FRESH_SECONDS = 90L

/**
 * One computer's overview (LiveHostMonitor.swift): polled every ten seconds,
 * or held open on the Hook's pushed stream when it offers one. State is read
 * and written on the main thread.
 */
class LiveHostMonitor(
    private val scope: CoroutineScope,
    private val fetchSnapshot: suspend (LiveHost, Instant?) -> LiveWorkspaces,
    private val openStream: ((LiveHost) -> Flow<LiveOverviewFrame>)?,
    private val pollInterval: Long = 10_000,
    /** Debug fixtures: a failed read ages the last answer out at once, as iOS's `--all-sessions-offline` does. */
    private val ageOnFailure: Boolean = false,
) {
    var snapshot by mutableStateOf<LiveWorkspaces?>(null)
    var lastUpdated by mutableStateOf<Instant?>(null)
    var message by mutableStateOf<String?>(null)
    var fingerprint by mutableStateOf<String?>(null)
    var refreshing by mutableStateOf(false); private set
    var polling by mutableStateOf(false); private set
    /** True until this contact period's first request resolves: cached rows stay in the live groups meanwhile. */
    var awaitingAnswer by mutableStateOf(true); private set
    var streaming by mutableStateOf(false); private set
    var onSnapshotChanged: (() -> Unit)? = null

    val slowToAnswer: Boolean get() = snapshot?.phren?.slowToAnswer == true
    private var generation = Any()
    private var refreshRequested = false
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var streamHost: LiveHost? = null
    private var streamFailures = 0
    private var streamRetryAt = Instant.MIN
    private var expiry: Job? = null
    private var oneShot: Job? = null

    fun isFresh(at: Instant = Instant.now()) = lastUpdated?.let { Duration.between(it, at).seconds < FRESH_SECONDS } == true
    /** Fresh, or still making first contact since the app became active. */
    fun isLive(at: Instant = Instant.now()) = isFresh(at) || (awaitingAnswer && message == null)
    /** A computer that answered and whose answer has aged out. */
    fun isStale(at: Instant = Instant.now()) = !isLive(at) && lastUpdated != null
    /** Reaching this computer, or not heard from yet. A fresh computer is live even while a poll is in flight. */
    val isConnecting: Boolean get() = !isFresh() && message == null && (refreshing || awaitingAnswer)

    /** Publishes once more when the answer ages out, so freshness needs no per-second clock. */
    private fun scheduleExpiry() {
        expiry?.cancel()
        val updated = lastUpdated ?: return
        val remaining = Duration.between(Instant.now(), updated.plusSeconds(FRESH_SECONDS)).toMillis()
        if (remaining <= 0) return
        expiry = scope.launch { delay(remaining + 20); onSnapshotChanged?.invoke() }
    }

    /** Fetch again now rather than at the end of the poll interval. */
    fun refreshNow() {
        refreshRequested = true
        wake.trySend(Unit)
        // The stream pushes changes on its own; a request for now still reads once beside it.
        val host = streamHost
        if (streaming && host != null) {
            oneShot?.cancel()
            val run = generation
            oneShot = scope.launch {
                val value = runCatching { fetchSnapshot(host, lastUpdated) }.getOrNull() ?: return@launch
                if (generation !== run) return@launch
                accept(value); onSnapshotChanged?.invoke()
            }
        }
    }

    /** The app came back to the foreground: reach this computer again and keep its rows refreshing, not stale. */
    fun reconnecting() { awaitingAnswer = true; refreshNow(); onSnapshotChanged?.invoke() }

    /** Herdr confirmed a close: drop the tab at once, then fetch so the truth replaces the guess. */
    fun closed(workspace: String, tab: String?) {
        snapshot = snapshot?.closing(workspace, tab)
        onSnapshotChanged?.invoke()
        refreshNow()
    }

    private fun accept(value: LiveWorkspaces) {
        if (snapshot != value) snapshot = value
        lastUpdated = Instant.now(); scheduleExpiry()
        awaitingAnswer = false; message = null; fingerprint = null
    }

    private fun pushes(value: LiveWorkspaces?) = value?.capabilities?.overviewStream == true

    /** Holds the Hook's overview stream open until it ends; returns how long it stayed open. */
    private suspend fun follow(host: LiveHost, run: Any): Long {
        val open = openStream ?: return 0
        val opened = System.currentTimeMillis()
        streaming = true; streamHost = host
        try {
            open(host).collect { frame ->
                if (generation !== run) throw CancellationException()
                withContext(Dispatchers.Main) {
                    when (frame) {
                        is LiveOverviewFrame.Overview -> accept(frame.workspaces)
                        is LiveOverviewFrame.Heartbeat -> {
                            lastUpdated = Instant.now(); scheduleExpiry()
                            awaitingAnswer = false; message = null
                            val current = snapshot
                            if (frame.info != null && current != null && current.phren != frame.info) snapshot = current.updating(frame.info!!)
                        }
                    }
                    onSnapshotChanged?.invoke()
                }
            }
        } catch (error: CancellationException) {
            if (generation !== run) throw error
        } catch (_: Exception) {
            // A dropped stream is not an unreachable computer: the next poll says whether it still answers.
        } finally {
            if (generation === run) { streaming = false; streamHost = null }
        }
        return System.currentTimeMillis() - opened
    }

    suspend fun run(host: LiveHost, onFirstRefresh: (() -> Unit)? = null) {
        val run = Any()
        generation = run
        polling = true; awaitingAnswer = true
        var first = true
        try {
            while (true) {
                refreshing = true
                try {
                    val value = fetchSnapshot(host, lastUpdated)
                    if (generation !== run) return
                    accept(value)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    if (generation !== run) return
                    message = (error as? LiveConnectionError)?.message ?: (error as? PhrenKitError)?.message
                        ?: "Couldn't reach the computer. Check the address, Tailscale, SSH, and Phren Hook."
                    if (error is LiveConnectionError.UntrustedHost) fingerprint = error.fingerprint
                    if (ageOnFailure) lastUpdated = Instant.now().minusSeconds(FRESH_SECONDS + 1)
                }
                refreshing = false
                awaitingAnswer = false
                if (first) { first = false; onFirstRefresh?.invoke() }
                onSnapshotChanged?.invoke()
                if (fingerprint != null) return
                // A Hook that pushes its overview keeps one socket open; polling resumes only while it is down.
                if (message == null && openStream != null && pushes(snapshot) && !Instant.now().isBefore(streamRetryAt)) {
                    refreshRequested = false
                    val lasted = follow(host, run)
                    if (generation !== run) return
                    // A stream that failed at once backs off, so a Hook that cannot hold one is simply polled.
                    streamFailures = if (lasted < 30_000) streamFailures + 1 else 0
                    streamRetryAt = if (streamFailures == 0) Instant.now() else Instant.now().plusSeconds(minOf(300L, 30L * streamFailures))
                    if (refreshRequested || streamFailures == 0) continue
                }
                refreshRequested = false
                withTimeoutOrNull(pollInterval) { wake.receive() }
            }
        } finally {
            if (generation === run) { polling = false; refreshing = false }
        }
    }
}

/**
 * The one overview the app keeps live (SessionOverviewMonitor.swift): every
 * computer's monitor, revealed together after the first answers (or eight
 * seconds), then each host independently. A cold launch restores the last
 * list, up to a day old, greyed and connecting, with no spinner.
 */
class SessionOverviewMonitor(
    private val scope: CoroutineScope,
    private val keys: DeviceKeyStore,
    private val cacheDirectory: File?,
    private val initialWaitMillis: Long = 8_000,
    /** Debug fixtures answer instead of a computer, and never stream. */
    private val fixtureFetch: (suspend (LiveHost, Instant?) -> LiveWorkspaces)? = null,
    private val fixtureOffline: Boolean = false,
) {
    data class Group(val id: String, val title: String, val sessions: List<LiveAgentSession>, val fresh: Boolean)
    data class ComputerRow(val host: LiveHost, val connecting: Boolean, val fresh: Boolean, val message: String?,
                           val needsVerification: Boolean, val slow: Boolean = false)
    /** One value for the whole screen: header, groups, projects, pins and computer rows never come from different refreshes. */
    data class Screen(
        val groups: List<Group> = emptyList(),
        val computers: List<ComputerRow> = emptyList(),
        val projects: Map<LiveAgentSession.ID, String> = emptyMap(),
        val pinned: Set<LiveAgentSession.ID> = emptySet(),
        val memoryReady: Boolean = true,
        val memoryConnected: Boolean = true,
        val preferencesReadable: Boolean = true,
    ) { val connectedCount: Int get() = computers.count { it.fresh } }
    data class Configuration(
        val preferences: LiveSessionPreferences? = null,
        val projects: List<SessionProject> = emptyList(),
        val metadataReady: Boolean = true,
        val memoryConnected: Boolean = true,
    )
    class Computer(val host: LiveHost, val monitor: LiveHostMonitor) { val id get() = host.id }

    var computers by mutableStateOf<List<Computer>>(emptyList()); private set
    var ready by mutableStateOf(false); private set
    var screen by mutableStateOf(Screen()); private set

    private var configuration = Configuration()
    private var latchedHosts: List<LiveHost> = emptyList()
    private var initialDeadline: Long? = null
    private var publication: Job? = null
    private var generation = Any()
    private var pending = mutableSetOf<java.util.UUID>()
    private var refreshingCachedScreen = false
    private var ownedRun: Job? = null
    private var ownedHosts: List<LiveHost> = emptyList()

    private fun makeMonitor() = fixtureFetch?.let { LiveHostMonitor(scope, it, openStream = null, ageOnFailure = fixtureOffline) } ?: LiveHostMonitor(scope,
        fetchSnapshot = { host, _ -> PhrenConnection.fetch(host, withContext(Dispatchers.IO) { keys.load(host.id) }) },
        openStream = { host -> PhrenConnection.overviewUpdates(host, keys.load(host.id)) })

    /** Start (or keep) polling these computers from a job this object owns, so no screen's disappearance cancels it. */
    fun ensureRunning(hosts: List<LiveHost>) {
        if (ownedRun?.isActive == true && ownedHosts == hosts) return
        ownedRun?.cancel()
        ownedHosts = hosts
        ownedRun = scope.launch { run(hosts) }
    }

    fun stopRunning() { ownedRun?.cancel(); ownedRun = null; ownedHosts = emptyList() }

    fun allows(feature: LiveCapabilities.Feature, host: LiveHost, fallback: LiveCapabilities? = null): Boolean {
        val current = computers.firstOrNull { it.host.id == host.id }?.monitor?.snapshot
        return (current?.capabilities ?: fallback)?.allows(feature) ?: true
    }
    fun allowsSchedules() = computers.isEmpty() || computers.any { it.monitor.snapshot?.capabilities?.allows(LiveCapabilities.Feature.SCHEDULES) ?: true }
    fun allowsCode() = computers.isEmpty() || computers.any { it.monitor.snapshot?.capabilities?.allows(LiveCapabilities.Feature.CODE) ?: true }

    fun monitor(host: LiveHost): LiveHostMonitor? = computers.firstOrNull { it.host.id == host.id }?.monitor

    suspend fun run(hosts: List<LiveHost>) {
        val run = Any(); generation = run
        val identity = hosts.sortedBy { it.id.toString() }
        val cold = latchedHosts != identity || initialDeadline == null
        if (cold) {
            latchedHosts = identity
            ready = false; screen = Screen(); refreshingCachedScreen = false
            initialDeadline = System.currentTimeMillis() + initialWaitMillis
        }
        computers = hosts.map { host -> computers.firstOrNull { it.host == host } ?: Computer(host, makeMonitor()) }
        if (cold) restoreLastKnown(hosts)
        for (computer in computers) computer.monitor.onSnapshotChanged = { schedulePublication() }
        pending = computers.filter { refreshingCachedScreen || (it.monitor.snapshot == null && it.monitor.message == null) }.map { it.id }.toMutableSet()
        revealIfPossible()
        coroutineScope {
            // Bound the initial reveal even when a transport cannot respond.
            val deadline = launch {
                delay(maxOf(0, (initialDeadline ?: 0) - System.currentTimeMillis()))
                if (generation === run) revealIfPossible(deadlineReached = true)
            }
            try {
                computers.map { computer ->
                    launch {
                        computer.monitor.run(computer.host) {
                            if (generation !== run) return@run
                            pending.remove(computer.id)
                            revealIfPossible()
                        }
                    }
                }.forEach { it.join() }
            } finally {
                deadline.cancel()
                if (generation === run) publication?.cancel()
            }
        }
    }

    fun configure(value: Configuration) {
        if (configuration == value) return
        configuration = value
        if (ready && !refreshingCachedScreen) publish() else revealIfPossible()
    }

    /** Back in the foreground: reach every computer again now, keeping the cached overview shown as refreshing. */
    fun returnToForeground() = computers.forEach { it.monitor.reconnecting() }

    private fun revealIfPossible(deadlineReached: Boolean = false) {
        if (initialDeadline == null || (ready && !refreshingCachedScreen)) return
        if (!deadlineReached && !(pending.isEmpty() && configuration.metadataReady)) return
        val first = !ready
        refreshingCachedScreen = false
        ready = true
        publish(first)
    }

    private fun schedulePublication() {
        if (!ready || refreshingCachedScreen) return
        publication?.cancel()
        publication = scope.launch { delay(120); publish() }
    }

    private fun publish(first: Boolean = false) {
        if (!ready || refreshingCachedScreen) return
        val now = Instant.now()
        val groups = groups(now)
        val projects = mutableMapOf<LiveAgentSession.ID, String>()
        val pinned = mutableSetOf<LiveAgentSession.ID>()
        for (session in groups.flatMap { it.sessions }) {
            configuration.preferences?.projectMatch(session.host.id, session.tab.cwd, configuration.projects)?.let { projects[session.id] = it.project.name }
            if (configuration.preferences?.isPinned(session.id) == true) pinned += session.id
        }
        val value = Screen(groups, computers.map {
            ComputerRow(it.host, it.monitor.isConnecting, it.monitor.isFresh(now), it.monitor.message, it.monitor.fingerprint != null, it.monitor.slowToAnswer)
        }, projects, pinned, configuration.metadataReady, configuration.memoryConnected, configuration.preferences != null)
        saveLastKnown(value)
        if (first || value != screen) screen = value
    }

    fun groups(at: Instant): List<Group> {
        if (!ready) return emptyList()
        val preferences = configuration.preferences
        val live = mutableListOf<LiveAgentSession>(); val previous = mutableListOf<LiveAgentSession>()
        for (computer in computers) {
            val sessions = computer.monitor.snapshot?.sessions(computer.host) ?: emptyList()
            // While a computer is still being reached its cached sessions keep their activity groups.
            if (computer.monitor.isLive(at)) live += sessions else previous += sessions
        }
        // What needs you first, then what just finished, then what is idle.
        val order = listOf(LiveWorkspaces.Tab.Activity.WORKING to "Working", LiveWorkspaces.Tab.Activity.WAITING to "Needs input",
            LiveWorkspaces.Tab.Activity.ERROR to "Needs attention", LiveWorkspaces.Tab.Activity.DONE to "Done",
            LiveWorkspaces.Tab.Activity.IDLE to "Idle", LiveWorkspaces.Tab.Activity.UNKNOWN to "Other sessions")
        val isPinned = { s: LiveAgentSession -> preferences?.isPinned(s.id) == true }
        val pinned = (live + previous).filter(isPinned).sortedWith(ORDER)
        live.removeAll(isPinned); previous.removeAll(isPinned)
        val groups = mutableListOf<Group>()
        if (pinned.isNotEmpty()) groups += Group("pinned", "Pinned", pinned, pinned.all { s -> computers.firstOrNull { it.host == s.host }?.monitor?.isLive(at) == true })
        for ((activity, title) in order) {
            val matches = live.filter { it.tab.activity == activity }.sortedWith(ORDER)
            if (matches.isNotEmpty()) groups += Group(activity.rawValue, title, matches, true)
        }
        if (previous.isNotEmpty()) groups += Group("previous", "Last seen", previous.sortedWith(ORDER), false)
        return groups
    }

    // The last rendered list stands in for a cold launch, up to a day old.

    private fun cacheFile(hosts: List<LiveHost>): File? {
        val dir = cacheDirectory ?: return null
        val key = cacheJson.encodeToString(kotlinx.serialization.builtins.ListSerializer(LiveHost.serializer()), hosts.sortedBy { it.id.toString() })
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(dir, "session-overview/$digest.json")
    }

    /** Per cache file, as iOS keys it: a different set of computers is a different file. */
    private val lastWrite = mutableMapOf<String, Long>()
    private fun saveLastKnown(value: Screen) {
        val file = cacheFile(computers.map { it.host }) ?: return
        val now = System.currentTimeMillis()
        // Polls with an unchanged screen still renew its age, at most twice a minute.
        val previous = lastWrite[file.name]
        if (previous != null && value == screen && now - previous < 30_000) return
        lastWrite[file.name] = now
        val record = buildJsonObject {
            put("version", 1); put("savedAt", now)
            put("hosts", buildJsonArray {
                for (computer in computers) add(buildJsonObject {
                    put("host", cacheJson.encodeToJsonElement(LiveHost.serializer(), computer.host))
                    computer.monitor.snapshot?.let { put("snapshot", it.toJson()) }
                    computer.monitor.lastUpdated?.let { put("lastUpdated", it.toEpochMilli()) }
                    computer.monitor.message?.let { put("message", it) }
                })
            })
        }.toString()
        scope.launch(Dispatchers.IO) {
            runCatching { file.parentFile?.mkdirs(); val temp = File(file.path + ".tmp"); temp.writeText(record); temp.renameTo(file) }
        }
    }

    /** Read in place, not on a background thread: the few kilobytes cost less than one frame of spinner. */
    private fun restoreLastKnown(hosts: List<LiveHost>) {
        val file = cacheFile(hosts) ?: return
        val record = runCatching { if (file.length() in 1..8_388_608) cacheJson.parseToJsonElement(file.readText()).jsonObject else null }.getOrNull() ?: return
        val savedAt = record["version"]?.toString()?.takeIf { it == "1" }?.let { record["savedAt"]?.toString()?.toLongOrNull() } ?: return
        val age = System.currentTimeMillis() - savedAt
        if (age !in 0 until 86_400_000L) return
        val saved = record["hosts"]?.jsonArray?.mapNotNull { it as? JsonObject } ?: return
        val restored = saved.mapNotNull { entry ->
            val host = runCatching { cacheJson.decodeFromJsonElement(LiveHost.serializer(), entry["host"]!!) }.getOrNull() ?: return@mapNotNull null
            host to entry
        }
        if (restored.map { it.first }.sortedBy { it.id.toString() } != hosts.sortedBy { it.id.toString() }) return
        for (computer in computers) {
            val entry = restored.firstOrNull { it.first == computer.host }?.second ?: continue
            computer.monitor.snapshot = (entry["snapshot"] as? JsonObject)?.let { runCatching { LiveWorkspaces.read(it) }.getOrNull() }
            // A screen older than a minute never revives a green status: every computer reads as connecting.
            computer.monitor.lastUpdated = if (age < 60_000) entry["lastUpdated"]?.toString()?.toLongOrNull()?.let(Instant::ofEpochMilli) else null
        }
        ready = true
        refreshingCachedScreen = true
        val now = Instant.now()
        screen = Screen(groups(now).map { it.copy(fresh = age < 60_000 && it.fresh) }, computers.map {
            ComputerRow(it.host, connecting = true, fresh = false, message = null, needsVerification = false)
        }, preferencesReadable = configuration.preferences != null)
    }

    /** Forgetting a computer drops every cached list that included it. */
    fun purgeCache() { lastWrite.clear(); cacheDirectory?.let { File(it, "session-overview").deleteRecursively() } }

    private companion object {
        /** Conductors first, then most recently changed, then by computer and workspace so the rest stays stable. */
        val ORDER = Comparator<LiveAgentSession> { a, b ->
            if (a.tab.isConductor != b.tab.isConductor) return@Comparator if (a.tab.isConductor) -1 else 1
            val left = a.tab.lastChangedAt ?: Instant.MIN; val right = b.tab.lastChangedAt ?: Instant.MIN
            if (left != right) return@Comparator right.compareTo(left)
            if (a.host.id == b.host.id && a.tab.changedSeq != b.tab.changedSeq) return@Comparator (b.tab.changedSeq ?: Int.MIN_VALUE).compareTo(a.tab.changedSeq ?: Int.MIN_VALUE)
            compareValuesBy(a, b, { it.host.name.lowercase() }, { it.host.id.toString() }, { it.workspaceName.lowercase() }, { it.tab.id })
        }
    }
}

private val cacheJson = Json { ignoreUnknownKeys = true }
