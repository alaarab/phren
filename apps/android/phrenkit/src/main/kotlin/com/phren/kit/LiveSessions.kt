package com.phren.kit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import java.text.Normalizer
import java.time.Instant
import java.util.UUID

/** Transport values stay typed; an absent dictionary is the legacy Hook contract (LiveSessions.swift). */
@Serializable
data class LiveCapabilities(
    val memory: Boolean? = null,
    val tasks: Boolean? = null,
    val hook: Boolean? = null,
    val git: Boolean? = null,
    val diff: Boolean? = null,
    val schedules: Boolean? = null,
    val dispatch: Boolean? = null,
    val codeMap: Boolean? = null,
    val code: Boolean? = null,
    /** The Hook voices text for talk mode (`POST /v1/speech`). */
    val speech: Boolean? = null,
    /** The Hook relays dictation to ElevenLabs Scribe (`WS /v1/speech/transcribe`). */
    val transcribe: Boolean? = null,
    val terminal: String? = null,
    val shell: String? = null,
    val webPreview: String? = null,
    val approvalPush: String? = null,
    val providers: List<String>? = null,
    /** The Hook pushes the overview over `/v1/overview` instead of being polled. */
    val overviewStream: Boolean? = null,
) {
    enum class Feature { TASKS, SCHEDULES, CHANGES, DISPATCH, CODE_MAP, CODE, SPEECH, TRANSCRIBE }

    fun allows(feature: Feature): Boolean = when (feature) {
        Feature.TASKS -> tasks == true
        Feature.SCHEDULES -> schedules == true
        Feature.CHANGES -> git == true || (git == null && diff == true)
        Feature.DISPATCH -> dispatch == true
        Feature.CODE_MAP -> codeMap == true
        Feature.CODE -> code == true
        Feature.SPEECH -> speech == true
        Feature.TRANSCRIBE -> transcribe == true
    }
}

@Serializable
data class HookLoad(val average: Double, val cpus: Int)

data class LiveHookInfo(
    val capabilities: LiveCapabilities?,
    val modules: Map<String, String>?,
    val store: String?,
    val profile: String?,
    val generation: String?,
    /** The computer's 1-minute load average and CPU count, when reported. */
    val load: HookLoad? = null,
    /** The node gateway's own startup-to-first-byte cost, when it was the path. */
    val gatewayMs: Int? = null,
) {
    /** Answering, but oversubscribed or slow: distinct from unreachable, so the last snapshot stays visible. */
    val slowToAnswer: Boolean
        get() {
            if (load != null && load.cpus > 0 && load.average > 4.0 * load.cpus) return true
            if (gatewayMs != null && gatewayMs > 1_500) return true
            return false
        }
}

/** The Phren Hook v1 workspace contract. A child is a tab; it can aggregate several agent panes. */
data class LiveWorkspaces(
    val kind: String,
    val groups: List<Group>,
    val focus: Focus?,
    /** The Hook's durable identity, distinct from `LiveHost.id` (phone-local). */
    val computer: Computer? = null,
    /** What the Hook reports about itself. */
    val phren: LiveHookInfo? = null,
) {
    @Serializable
    data class Computer(@Serializable(with = UUIDSerializer::class) val id: UUID, val name: String)

    @Serializable
    data class Tab(
        val id: String,
        val label: String,
        val title: String? = null,
        val agentStatus: String? = null,
        val approvalPending: Boolean? = null,
        val agent: String? = null,
        val starting: Boolean? = null,
        val cwd: String? = null,
        /** The git branch of the agent's folder, when the Hook reports one. */
        val branch: String? = null,
        val agentPaneCount: Int? = null,
        val paneCount: Int? = null,
        /** What a working agent is doing right now ("Bash: swift build"). */
        val currentStep: String? = null,
        /** The model the pane's agent runs; nil for several agents or no answer yet. */
        val model: String? = null,
        /** The job this tab performs; `conductor` is the store-wide dispatch lead. */
        val role: String? = null,
        /** Herdr's state-change counter: higher means the status moved more recently. Only an order. */
        val changedSeq: Int? = null,
        @SerialName("lastChangedAt") private val reportedLastChangedAt: JsonElement? = null,
        @SerialName("contextUsedPercent") private val reportedContextUsedPercent: JsonElement? = null,
        @SerialName("runningChildren") private val reportedRunningChildren: Int? = null,
        @SerialName("childProviders") private val reportedChildProviders: List<String>? = null,
    ) {
        val isConductor: Boolean get() = role == "conductor"
        val runningChildren: Int get() = maxOf(0, reportedRunningChildren ?: 0)
        val childProviders: List<String> get() = reportedChildProviders ?: emptyList()
        /** The Hook's persisted wall clock for the last title or activity change. */
        val lastChangedAt: Instant? get() = reportedLastChangedAt.str?.let { ISO8601Dates.parse(it) }
        /** Provider-reported percentage; token counts alone cannot establish a limit. */
        val contextUsedPercent: Double?
            get() {
                if (agentPaneCount != null && agentPaneCount != 1) return null
                return reportedContextUsedPercent.double?.takeIf { it.isFinite() && it in 0.0..100.0 }
            }

        val displayTitle: String get() = title?.trim()?.ifEmpty { null } ?: label

        enum class Activity(val rawValue: String) { ERROR("Error"), WAITING("Waiting"), WORKING("Working"), IDLE("Idle"), DONE("Done"), UNKNOWN("Unknown") }

        val activity: Activity
            get() {
                if (approvalPending == true) return Activity.WAITING
                return when (agentStatus) {
                    "working" -> Activity.WORKING
                    "idle" -> Activity.IDLE
                    "done" -> Activity.DONE
                    "error" -> Activity.ERROR
                    "blocked", "waiting" -> Activity.WAITING
                    else -> Activity.UNKNOWN
                }
            }
        val status: String get() = if (approvalPending == true) "Permission needed" else activity.rawValue
    }

    @Serializable
    data class Group(val id: String, val label: String, val children: List<Tab>)

    @Serializable
    data class Focus(val workspaceID: String, val tabID: String, val paneID: String)

    val capabilities: LiveCapabilities? get() = phren?.capabilities

    /** The snapshot once Herdr has closed a tab (or the workspace when `tab` is null). */
    fun closing(workspace: String, tab: String?): LiveWorkspaces {
        val next = groups.mapNotNull { group ->
            if (group.id != workspace) return@mapNotNull group
            if (tab == null) return@mapNotNull null
            val children = group.children.filter { it.id != tab }
            if (children.isEmpty()) null else Group(group.id, group.label, children)
        }
        val nextFocus = focus?.takeUnless { it.workspaceID == workspace && (tab == null || it.tabID == tab) }
        return copy(groups = next, focus = nextFocus)
    }

    /** The same overview with the Hook's newer self-report, as a heartbeat carries it. */
    fun updating(info: LiveHookInfo) = copy(phren = info)

    fun sessions(host: LiveHost): List<LiveAgentSession> = groups.flatMap { group ->
        group.children.map { LiveAgentSession(host, group.id, group.label, it, group.children.size, capabilities) }
    }

    /** The document's own encoding, as the phone caches it. */
    fun toJson(): JsonObject = kotlinx.serialization.json.buildJsonObject {
        put("kind", kotlinx.serialization.json.JsonPrimitive(kind))
        put("groups", hookJson.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(Group.serializer()), groups))
        focus?.let { put("focus", hookJson.encodeToJsonElement(Focus.serializer(), it)) }
        if (computer != null || phren != null) put("phren", hookJson.encodeToJsonElement(PhrenInfo.serializer(), PhrenInfo(
            computer = computer, capabilities = phren?.capabilities, modules = phren?.modules, store = phren?.store,
            profile = phren?.profile, generation = phren?.generation, load = phren?.load, gatewayMs = phren?.gatewayMs)))
    }

    @Serializable
    private data class PhrenInfo(
        val product: String? = null,
        val protocol: Int? = null,
        val computer: Computer? = null,
        val capabilities: LiveCapabilities? = null,
        val modules: Map<String, String>? = null,
        val store: String? = null,
        val profile: String? = null,
        val generation: String? = null,
        val load: HookLoad? = null,
        val gatewayMs: Int? = null,
    )

    companion object {
        fun read(data: ByteArray, requiringHook: Boolean = false): LiveWorkspaces {
            if (data.size > 1_048_576) throw PhrenKitError.Validation("The session response is too large.")
            val frame = try { hookJson.parseToJsonElement(data.decodeToString()).obj } catch (_: Exception) { null }
                ?: throw PhrenKitError.Validation("The computer returned an unreadable session list.")
            return read(frame, requiringHook)
        }

        fun read(frame: JsonObject, requiringHook: Boolean = false): LiveWorkspaces {
            val result = try {
                val info = frame["phren"]?.let { hookJson.decodeFromJsonElement(PhrenInfo.serializer(), it) }
                if (requiringHook && (info?.product != "phren-hook" || info.protocol != 1)) {
                    throw PhrenKitError.Validation("Install Phren Hook on this computer with phren bridge install.")
                }
                LiveWorkspaces(
                    kind = frame["kind"].str ?: throw PhrenKitError.Validation("The computer returned an unreadable session list."),
                    groups = hookJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(Group.serializer()), frame["groups"] ?: throw PhrenKitError.Validation("The computer returned an unreadable session list.")),
                    focus = frame["focus"]?.let { hookJson.decodeFromJsonElement(Focus.serializer(), it) },
                    computer = info?.computer,
                    phren = info?.let { LiveHookInfo(it.capabilities, it.modules, it.store, it.profile, it.generation, it.load, it.gatewayMs) },
                )
            } catch (e: PhrenKitError) { throw e } catch (_: Exception) { throw PhrenKitError.Validation("The computer returned an unreadable session list.") }
            if (result.kind != "herdr") throw PhrenKitError.Validation("Phren Hook returned an unsupported session provider.")
            val groupIDs = mutableSetOf<String>()
            for (group in result.groups) {
                if (group.id.isEmpty() || !groupIDs.add(group.id)) throw PhrenKitError.Validation("The hook returned repeated or empty workspace IDs.")
                val tabIDs = mutableSetOf<String>()
                for (tab in group.children) if (tab.id.isEmpty() || !tabIDs.add(tab.id)) throw PhrenKitError.Validation("The hook returned repeated or empty tab IDs.")
            }
            result.focus?.let { f ->
                if (!listOf(f.workspaceID, f.tabID, f.paneID).all(AgentChatTarget::validID) ||
                    result.groups.none { g -> g.id == f.workspaceID && g.children.any { it.id == f.tabID } })
                    throw PhrenKitError.Validation("The focused Herdr tab changed. Refresh the computer.")
            }
            result.computer?.let { c ->
                if (c.name.isEmpty() || c.name.toByteArray().size > 253 || c.name.hasControlCharacters())
                    throw PhrenKitError.Validation("Phren Hook returned an invalid computer identity.")
            }
            return result
        }
    }
}

@Serializable
data class LiveHost(
    @Serializable(with = UUIDSerializer::class) val id: UUID = UUID.randomUUID(),
    val name: String,
    val address: String,
    val port: Int = 22,
    val username: String,
    /** The immutable id this enrolled Hook reports; `id` stays phone-local. */
    @Serializable(with = NullableUUIDSerializer::class) val hookComputerID: UUID? = null,
    val fingerprint: String? = null,
    val herdrSession: String? = null,
    val color: String? = null,
) {
    val muxID: String get() = "herdr:" + (herdrSession ?: "default")

    fun validate() {
        herdrSession?.let { if (!AgentChatTarget.validID(it) || it.contains(":")) throw PhrenKitError.Validation("Choose a valid Herdr server name.") }
        if (name.isEmpty() || name.length > 100 || address.isEmpty() || address.length > 253 || username.isEmpty() || username.length > 100 ||
            port !in 1..65535 || address.contains("/") || address.contains("@") || address.any { it.isWhitespace() } ||
            listOf(name, address, username).any { it.hasControlCharacters() })
            throw PhrenKitError.Validation("Enter a name, SSH hostname or IP address, port from 1–65535, and username.")
        fingerprint?.let { if (!Regex("^SHA256:[A-Za-z0-9+/]{43}$").matches(it)) throw PhrenKitError.Validation("The saved SSH host fingerprint is invalid.") }
        color?.let { if (!Regex("^#[0-9A-F]{6}$").matches(it)) throw PhrenKitError.Validation("Choose a color as #RRGGBB.") }
    }

    /** Remote targets may select another Herdr server without changing the enrolled connection. */
    fun hasSameConnection(other: LiveHost) = id == other.id && address == other.address && port == other.port &&
        username == other.username && fingerprint == other.fingerprint &&
        (hookComputerID == null || other.hookComputerID == null || hookComputerID == other.hookComputerID)

    companion object {
        val COLOR_PALETTE = listOf("#6E9BFF", "#35C9C0", "#4CD37A", "#F2B441", "#FF8A5B", "#FF6FA5", "#A78BFA", "#9AA5B8")

        /** Validated, trimmed (LiveHost.init). */
        fun of(id: UUID = UUID.randomUUID(), name: String, address: String, port: Int = 22, username: String, hookComputerID: UUID? = null,
               fingerprint: String? = null, herdrSession: String? = null, color: String? = null): LiveHost =
            LiveHost(id, name.trim(), address.trim(), port, username.trim(), hookComputerID, fingerprint, herdrSession, color).also { it.validate() }

        /** Swift's `uuidString.utf8.reduce(0) { (($0 &* 31) &+ Int($1)) % count }`. */
        fun defaultColor(id: UUID): String {
            var index = 0L
            for (b in id.upper().toByteArray()) index = ((index * 31) + (b.toLong() and 0xFF)) % COLOR_PALETTE.size
            return COLOR_PALETTE[index.toInt()]
        }
    }
}

object NullableUUIDSerializer : kotlinx.serialization.KSerializer<UUID?> {
    override val descriptor = kotlinx.serialization.descriptors.PrimitiveSerialDescriptor("UUID?", kotlinx.serialization.descriptors.PrimitiveKind.STRING)
    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    override fun serialize(encoder: kotlinx.serialization.encoding.Encoder, value: UUID?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(value.upper())
    }
    override fun deserialize(decoder: kotlinx.serialization.encoding.Decoder): UUID? = parseUUID(decoder.decodeString())
}

/** A tab on a known computer; its destination is the Hook's workspace and tab IDs, never the label. */
data class LiveAgentSession(
    val host: LiveHost,
    val workspaceID: String,
    val workspaceName: String,
    val tab: LiveWorkspaces.Tab,
    val workspaceTabCount: Int? = null,
    val capabilities: LiveCapabilities? = null,
) {
    @Serializable
    data class ID(@Serializable(with = UUIDSerializer::class) val hostID: UUID, val workspace: String, val tab: String, val muxID: String = "herdr:default")

    val id: ID get() = ID(host.id, workspaceID, tab.id, host.muxID)

    override fun equals(other: Any?) = other is LiveAgentSession && host == other.host && workspaceID == other.workspaceID &&
        workspaceName == other.workspaceName && tab == other.tab && workspaceTabCount == other.workspaceTabCount && capabilities == other.capabilities
    override fun hashCode() = id.hashCode()

    /** A folder label for sessions whose cwd isn't linked to a project. */
    val folderName: String?
        get() {
            val cwd = tab.cwd?.trim()?.ifEmpty { null } ?: return null
            val trimmed = if (cwd.length > 1) cwd.replace(Regex("/+$"), "") else cwd
            return trimmed.split("/").lastOrNull { it.isNotEmpty() }
        }

    fun projectDisplayName(mappedProject: String?): String =
        mappedProject?.trim()?.ifEmpty { null } ?: folderName ?: workspaceName.ifEmpty { tab.displayTitle }

    fun usesFolderFallback(mappedProject: String?) = mappedProject?.trim().isNullOrEmpty() && folderName != null

    fun matches(query: String, projectName: String? = null): Boolean {
        val text = listOf(host.name, host.address, host.herdrSession ?: "default", workspaceName, tab.displayTitle, tab.label,
            tab.agent ?: "", tab.cwd ?: "", projectName ?: "").joinToString(" ")
        return query.split(Regex("\\s+")).filter { it.isNotEmpty() }.all { text.contains(it, ignoreCase = true) }
    }

    companion object {
        fun remote(host: LiveHost, target: AgentChatTarget, title: String, status: String?, model: String?) = LiveAgentSession(
            host, target.workspaceID, title,
            LiveWorkspaces.Tab(id = target.tabID, label = title, title = title, agentStatus = status, agent = target.source, agentPaneCount = 1, paneCount = 1, model = model),
            workspaceTabCount = 1,
        )
    }
}

@Serializable
data class SessionProject(val storeID: String, val name: String)

data class SessionProjectMatch(val project: SessionProject, val directory: String, val automatic: Boolean)

/**
 * Device-local host settings, pinned tabs and explicit directory → project
 * mappings. Credentials and observed session data never belong here.
 */
@Serializable
data class LiveSessionPreferences(
    val schemaVersion: Int = 1,
    val hosts: List<LiveHost> = emptyList(),
    val mappings: List<Mapping> = emptyList(),
    /** Pins follow the host, Herdr server, workspace and tab identity. */
    val pinnedSessions: List<LiveAgentSession.ID> = emptyList(),
) {
    @Serializable
    data class Mapping(@Serializable(with = UUIDSerializer::class) val hostID: UUID, val directory: String, val storeID: String, val project: String)

    fun isPinned(sessionID: LiveAgentSession.ID) = sessionID in pinnedSessions

    /** Keeps the incoming order within the pinned and unpinned sections. */
    fun pinnedFirst(sessions: List<LiveAgentSession>): List<LiveAgentSession> {
        val pins = pinnedSessions.toSet()
        return sessions.filter { it.id in pins } + sessions.filter { it.id !in pins }
    }

    fun mapping(hostID: UUID, cwd: String?): Mapping? {
        val path = cwd?.let { runCatching { normalizedDirectory(it) }.getOrNull() } ?: return null
        return mappings.filter { it.hostID == hostID && (path == it.directory || path.startsWith(it.directory + "/")) }.maxByOrNull { it.directory.length }
    }

    /** Explicit choices win; otherwise the deepest path component naming exactly one attached project. */
    fun projectMatch(hostID: UUID, cwd: String?, projects: List<SessionProject>): SessionProjectMatch? {
        if (hosts.none { it.id == hostID }) return null
        val directory = cwd?.let { runCatching { normalizedDirectory(it) }.getOrNull() } ?: return null
        mapping(hostID, directory)?.let { return SessionProjectMatch(SessionProject(it.storeID, it.project), it.directory, false) }
        val parts = directory.split("/").filter { it.isNotEmpty() }.toMutableList()
        while (parts.isNotEmpty()) {
            val candidate = "/" + parts.joinToString("/")
            // A home folder is never a project, even when a project shares the user's name.
            if (isHomeDirectory(candidate)) break
            val matches = projects.filter { it.name != "global" && it.name.equals(parts.last(), ignoreCase = true) }.toSet()
            if (matches.isNotEmpty()) {
                if (matches.size != 1) return null
                return SessionProjectMatch(matches.first(), candidate, true)
            }
            parts.removeAt(parts.lastIndex)
        }
        return null
    }

    companion object {
        private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = false; encodeDefaults = true }
        private val strict = kotlinx.serialization.json.Json { encodeDefaults = true; ignoreUnknownKeys = true }

        fun read(data: String): LiveSessionPreferences {
            if (data.isEmpty()) return LiveSessionPreferences()
            val value = try { strict.decodeFromString(serializer(), data) } catch (_: Exception) { throw PhrenKitError.Validation("Update phren to read these live connections.") }
            if (value.schemaVersion != 1) throw PhrenKitError.Validation("Update phren to read these live connections.")
            val ids = mutableSetOf<UUID>()
            val computerIDs = mutableSetOf<UUID>()
            for (host in value.hosts) {
                host.validate()
                if (!ids.add(host.id) || (host.hookComputerID?.let { computerIDs.add(it) } == false)) throw PhrenKitError.Validation("Repeated live connection.")
            }
            val paths = mutableSetOf<String>()
            for (m in value.mappings) {
                if (m.hostID !in ids || m.storeID.isEmpty() || m.project.isEmpty() || runCatching { normalizedDirectory(m.directory) }.getOrNull() != m.directory ||
                    !paths.add(m.hostID.upper() + m.directory)) throw PhrenKitError.Validation("Invalid live project mapping.")
            }
            val pins = mutableSetOf<LiveAgentSession.ID>()
            for (pin in value.pinnedSessions) {
                if (pin.hostID !in ids || !validPin(pin) || !pins.add(pin)) throw PhrenKitError.Validation("Invalid pinned live session.")
            }
            return value
        }

        private fun write(value: LiveSessionPreferences) = json.encodeToString(serializer(), value)

        fun saving(host: LiveHost, data: String): String {
            val value = read(data)
            host.validate()
            val others = value.hosts.filter { it.id != host.id }
            if (others.any { host.hookComputerID != null && it.hookComputerID == host.hookComputerID })
                throw PhrenKitError.Validation("This Hook is already associated with another connection.")
            return write(value.copy(hosts = others + host))
        }

        fun settingColor(hostID: UUID, color: String?, data: String): String {
            val value = read(data)
            val index = value.hosts.indexOfFirst { it.id == hostID }
            if (index < 0) throw PhrenKitError.Validation("Connection no longer exists.")
            val normalized = color?.let {
                if (!Regex("^#[0-9A-Fa-f]{6}$").matches(it)) throw PhrenKitError.Validation("Choose a color as #RRGGBB.")
                it.uppercase()
            }
            return write(value.copy(hosts = value.hosts.toMutableList().also { it[index] = it[index].copy(color = normalized) }))
        }

        fun associating(hostID: UUID, hookComputerID: UUID, data: String): String {
            val value = read(data)
            val index = value.hosts.indexOfFirst { it.id == hostID }
            if (index < 0) throw PhrenKitError.Validation("Connection no longer exists.")
            if (value.hosts.any { it.id != hostID && it.hookComputerID == hookComputerID })
                throw PhrenKitError.Validation("This Hook is already associated with another connection.")
            return write(value.copy(hosts = value.hosts.toMutableList().also { it[index] = it[index].copy(hookComputerID = hookComputerID) }))
        }

        fun removing(hostID: UUID, data: String): String {
            val value = read(data)
            return write(value.copy(hosts = value.hosts.filter { it.id != hostID }, mappings = value.mappings.filter { it.hostID != hostID },
                pinnedSessions = value.pinnedSessions.filter { it.hostID != hostID }))
        }

        fun setPinned(isPinned: Boolean, sessionID: LiveAgentSession.ID, data: String): String {
            val value = read(data)
            val host = value.hosts.firstOrNull { it.id == sessionID.hostID } ?: throw PhrenKitError.Validation("Connection no longer exists.")
            if (!validPin(sessionID)) throw PhrenKitError.Validation("Invalid pinned live session.")
            val pins = if (isPinned) {
                if (host.muxID != sessionID.muxID) throw PhrenKitError.Validation("The Herdr server changed. Refresh the computer before pinning this session.")
                if (value.isPinned(sessionID)) value.pinnedSessions else value.pinnedSessions + sessionID
            } else value.pinnedSessions.filter { it != sessionID }
            return write(value.copy(pinnedSessions = pins))
        }

        fun assigning(hostID: UUID, directory: String, storeID: String?, project: String?, data: String): String {
            val value = read(data)
            if (value.hosts.none { it.id == hostID }) throw PhrenKitError.Validation("Connection no longer exists.")
            val path = normalizedDirectory(directory)
            var mappings = value.mappings.filter { !(it.hostID == hostID && it.directory == path) }
            if (storeID != null && project != null) {
                if (storeID.isEmpty() || project.isEmpty()) throw PhrenKitError.Validation("Choose a store and project.")
                mappings = mappings + Mapping(hostID, path, storeID, project)
            }
            return write(value.copy(mappings = mappings))
        }

        private fun validPin(id: LiveAgentSession.ID): Boolean {
            val server = id.muxID.removePrefix("herdr:")
            return id.workspace.isNotEmpty() && id.tab.isNotEmpty() && id.muxID.startsWith("herdr:") && AgentChatTarget.validID(server) && !server.contains(":")
        }

        fun normalizedDirectory(directory: String): String {
            val parts = directory.split("/").filter { it.isNotEmpty() }
            if (!directory.startsWith("/") || parts.isEmpty() || ".." in parts || "." in parts || directory.hasControlCharacters())
                throw PhrenKitError.Validation("Choose an absolute project directory without . or .. components.")
            return "/" + parts.joinToString("/")
        }

        /** `/home/<user>`, `/Users/<user>`, `/root`, and the mount points above them. */
        fun isHomeDirectory(path: String) = path == "/root" || Regex("^/(home|Users)(/[^/]+)?$").matches(path)
    }
}

/** A display section that can hold tabs from several Herdr workspaces (LiveAgentWorkspaceSection). */
data class LiveAgentWorkspaceSection(val id: String, val title: String, val sessions: List<LiveAgentSession>)

object LiveAgentWorkspaceGrouping {
    /** By Phren project when one resolves, then by a normalized workspace label (IDs change per open). */
    fun sections(sessions: List<LiveAgentSession>, preferences: LiveSessionPreferences?, projects: List<SessionProject>): List<LiveAgentWorkspaceSection> {
        val pending = linkedMapOf<String, Pair<String, MutableList<LiveAgentSession>>>()
        for (session in sessions) {
            val match = preferences?.projectMatch(session.host.id, session.tab.cwd, projects)
            val (title, key) = if (match != null) match.project.name to "project:${match.project.storeID}\u0000${match.project.name}" else {
                val label = session.workspaceName.trim()
                if (label.isEmpty()) session.projectDisplayName(null) to "workspace:${session.workspaceID}" else label to "label:${normalizedLabel(label)}"
            }
            pending.getOrPut(key) { title to mutableListOf() }.second += session
        }
        return pending.map { (key, value) -> LiveAgentWorkspaceSection(key, value.first, value.second) }
    }

    private fun normalizedLabel(label: String): String {
        val collapsed = label.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        val decomposed = Normalizer.normalize(collapsed, Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "")
        return decomposed.lowercase(java.util.Locale.ROOT)
    }
}

@Suppress("unused") private val keepTransient = Transient::class
