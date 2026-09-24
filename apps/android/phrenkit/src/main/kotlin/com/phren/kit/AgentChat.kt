package com.phren.kit

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID

/** An agent conversation belongs to a specific pane on a specific computer (AgentChat.swift). */
@Serializable(with = AgentChatTargetSerializer::class)
class AgentChatTarget private constructor(
    val hostID: UUID,
    val workspaceID: String,
    val tabID: String,
    val paneID: String,
    val source: String,
    val sessionID: String,
    val muxID: String,
    /** Present only before a transcript exists; binds the first prompt to the Hook's verified process. */
    val startingToken: String?,
) {
    val isStarting: Boolean get() = startingToken != null && sessionID.isEmpty()
    val id: String get() = listOf(hostID.upper(), muxID, workspaceID, tabID, paneID, source, if (isStarting) "starting-" + (startingToken ?: "") else sessionID).joinToString("/")
    val conversationKey: String get() = "$source:$sessionID"

    val providerName: String get() = when (source) {
        "claude" -> "Claude"; "copilot" -> "Copilot"; "phren" -> "Phren"; "opencode" -> "opencode"; else -> "Codex"
    }

    override fun equals(other: Any?) = other is AgentChatTarget && hostID == other.hostID && workspaceID == other.workspaceID && tabID == other.tabID &&
        paneID == other.paneID && source == other.source && sessionID == other.sessionID && muxID == other.muxID && startingToken == other.startingToken
    override fun hashCode() = id.hashCode()
    override fun toString() = "AgentChatTarget($id)"

    companion object {
        /** Agents the app chats with natively. */
        val sources = listOf("codex", "claude", "copilot", "phren", "opencode")

        operator fun invoke(hostID: UUID, workspaceID: String, tabID: String, paneID: String, source: String, sessionID: String,
                            muxID: String = "herdr:default", startingToken: String? = null): AgentChatTarget {
            val starting = sessionID.isEmpty() && startingToken != null && Regex("^[a-f0-9]{64}$").matches(startingToken)
            val ok = listOf(workspaceID, tabID, paneID, muxID).all(::validID) && muxID.startsWith("herdr:") && source in sources &&
                (starting || (startingToken == null && validID(sessionID) && (source !in listOf("copilot", "phren", "opencode") || validSessionID(sessionID))))
            if (!ok) throw PhrenKitError.Validation("Native chat needs a recognized Codex, Claude Code, GitHub Copilot, Phren, or opencode conversation in this pane.")
            return AgentChatTarget(hostID, workspaceID, tabID, paneID, source, sessionID, muxID, startingToken)
        }

        fun validID(value: String) = value.isNotEmpty() && value.toByteArray().size <= 200 && Regex("^[A-Za-z0-9_%:.-]+$").matches(value)

        fun validSessionID(value: String) = parseUUID(value) != null || Regex("^ses_[0-9A-Za-z]{1,64}$").matches(value)
    }
}

object AgentChatTargetSerializer : KSerializer<AgentChatTarget> {
    override val descriptor = buildClassSerialDescriptor("AgentChatTarget")
    override fun serialize(encoder: Encoder, value: AgentChatTarget) {
        val out = encoder as kotlinx.serialization.json.JsonEncoder
        out.encodeJsonElement(buildJsonObject {
            put("hostID", value.hostID.upper()); put("workspaceID", value.workspaceID); put("tabID", value.tabID); put("paneID", value.paneID)
            put("source", value.source); put("sessionID", value.sessionID); put("muxID", value.muxID); value.startingToken?.let { put("startingToken", it) }
        })
    }
    override fun deserialize(decoder: Decoder): AgentChatTarget {
        val o = (decoder as kotlinx.serialization.json.JsonDecoder).decodeJsonElement().obj ?: throw PhrenKitError.Validation("Invalid chat target.")
        fun s(k: String) = o[k].str ?: throw PhrenKitError.Validation("Invalid chat target.")
        return AgentChatTarget(parseUUID(s("hostID")) ?: throw PhrenKitError.Validation("Invalid chat target."), s("workspaceID"), s("tabID"), s("paneID"),
            s("source"), s("sessionID"), s("muxID"), o["startingToken"].str)
    }
}

private val computerName = Regex("^(?!\\.\\.?$)[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$")

data class AgentComputer(val id: UUID, val name: String) {
    companion object {
        fun of(id: UUID, name: String): AgentComputer {
            if (!computerName.matches(name)) throw PhrenKitError.Validation("The agent names an invalid computer.")
            return AgentComputer(id, name)
        }
        fun read(o: JsonObject?): AgentComputer? = o?.let { of(parseUUID(it["id"].str) ?: throw PhrenKitError.Validation("The agent names an invalid computer."), it["name"].str ?: "") }
    }
}

/** A Hook target has no phone-local host id; PhrenLive adds it after matching the computer. */
data class AgentRemoteTarget(val server: String, val workspace: String, val tab: String, val pane: String, val source: String, val session: String) {
    companion object {
        fun of(server: String, workspace: String, tab: String, pane: String, source: String, session: String): AgentRemoteTarget {
            if (!computerName.matches(server) || !listOf(workspace, tab, pane).all(AgentChatTarget::validID) || source !in AgentChatTarget.sources ||
                !AgentChatTarget.validSessionID(session)) throw PhrenKitError.Validation("The agent names an invalid remote conversation.")
            return AgentRemoteTarget(server, workspace, tab, pane, source, session)
        }
        fun read(o: JsonObject): AgentRemoteTarget {
            fun s(k: String) = o[k].str ?: throw PhrenKitError.Validation("The agent names an invalid remote conversation.")
            return of(s("server"), s("workspace"), s("tab"), s("pane"), s("source"), s("session"))
        }
    }
}

data class AgentRemote(val target: AgentRemoteTarget, val child: String? = null) {
    companion object {
        fun read(o: JsonObject?): AgentRemote? {
            if (o == null) return null
            val child = o["child"].str
            if (child != null && !Regex("^[a-f0-9]{32}$").matches(child)) throw PhrenKitError.Validation("The agent names an invalid remote child.")
            return AgentRemote(AgentRemoteTarget.read(o["target"].obj ?: throw PhrenKitError.Validation("The agent names an invalid remote conversation.")), child)
        }
    }
}

data class AgentFanoutCapability(val resumable: Boolean)

data class AgentChild(
    val id: String,
    val provider: String,
    val model: String?,
    val path: String,
    val callId: String,
    val state: State,
    /** `blocked: <type> <pattern>` for a worker refused a permission. */
    val reason: String?,
    val finishedAt: String?,
    val failed: Boolean?,
    val worktreeName: String?,
    val branch: String?,
    val computer: AgentComputer?,
    val remote: AgentRemote?,
    val fanout: AgentFanoutCapability?,
    val children: List<AgentChild>,
) {
    enum class State(val raw: String) { RUNNING("running"), COMPLETED("completed"), FAILED("failed") }

    val finishedDate: Instant? get() = ISO8601Dates.parse(finishedAt)
    /** Distinct when two computers reuse a session, row id, or child id. */
    val navigationID: String get() = listOf(computer?.id?.toString()?.lowercase() ?: "local", id, remote?.child ?: "lead").joinToString("/")
    val checkoutLabel: String? get() = branch ?: worktreeName
    val name: String get() = (path.split("/").lastOrNull() ?: "Agent").replace("_", " ")
    val permissionRefused: Boolean get() = reason?.startsWith("blocked:") == true
    val refusedDetail: String? get() = if (!permissionRefused || reason == null) null else reason.removePrefix("blocked:").trim().ifEmpty { null }
    val displayState: State get() = if (permissionRefused || failed == true) State.FAILED else state
    val displayName: String get() = if (permissionRefused) "Permission refused" else name
    val agentCount: Int get() = 1 + children.sumOf { it.agentCount }
    val runningCount: Int get() = (if (displayState == State.RUNNING) 1 else 0) + children.sumOf { it.runningCount }
    val refusedCount: Int get() = (if (permissionRefused) 1 else 0) + children.sumOf { it.refusedCount }

    enum class MessageDestination { SESSION, WORKER, PARENT, UNAVAILABLE_WORKER }

    val messageDestination: MessageDestination get() = when {
        remote != null && remote.child == null -> MessageDestination.SESSION
        fanout?.resumable == true -> MessageDestination.WORKER
        fanout != null || callId.startsWith("fanout:") -> MessageDestination.UNAVAILABLE_WORKER
        else -> MessageDestination.PARENT
    }

    val messageNote: String get() = when (messageDestination) {
        MessageDestination.SESSION -> "Messages go directly to this agent session."
        MessageDestination.WORKER -> "Continues this worker's own session. Messages wait in its queue while it runs."
        MessageDestination.PARENT -> "This sub-agent cannot receive input. Your message goes to its parent, labeled with this sub-agent's name."
        MessageDestination.UNAVAILABLE_WORKER -> "This worker has no resumable session available."
    }

    fun parentMessage(text: String) = "About the $name sub-agent: $text"

    /** A local fan-out worker finished without a failure: folded into "N finished". */
    val isFinishedLocalWorker: Boolean get() = computer == null && remote == null && (fanout != null || callId.startsWith("fanout:")) && displayState == State.COMPLETED

    companion object {
        fun read(o: JsonObject): AgentChild {
            fun s(k: String) = o[k].str ?: throw PhrenKitError.Validation("The computer returned an invalid agent relation.")
            val child = AgentChild(
                id = s("id"), provider = s("provider"), model = o["model"].str, path = s("path"), callId = s("callId"),
                state = State.entries.firstOrNull { it.raw == o["state"].str } ?: throw PhrenKitError.Validation("The computer returned an invalid agent relation."),
                reason = o["reason"].str, finishedAt = o["finishedAt"].str, failed = o["failed"].bool, worktreeName = o["worktreeName"].str, branch = o["branch"].str,
                computer = AgentComputer.read(o["computer"].obj), remote = AgentRemote.read(o["remote"].obj),
                fanout = o["fanout"].obj?.let { AgentFanoutCapability(it["resumable"].bool ?: throw PhrenKitError.Validation("The computer returned an invalid agent relation.")) },
                children = (o["children"].objects ?: throw PhrenKitError.Validation("The computer returned an invalid agent relation.")).map(::read),
            )
            if (!AgentChatTarget.validID(child.id) || child.provider !in AgentChatTarget.sources || (child.remote != null && child.computer == null))
                throw PhrenKitError.Validation("The computer returned an invalid agent relation.")
            return child
        }

        fun rows(agents: List<AgentChild>, includeCompleted: Boolean, depth: Int = 0): List<AgentChildTreeRow> = agents.flatMap { agent ->
            // A refused worker is finished but stays visible: the sheet is where the refusal shows.
            val visible = includeCompleted || agent.displayState == State.RUNNING || agent.permissionRefused
            val descendants = rows(agent.children, includeCompleted, if (visible) depth + 1 else depth)
            (if (visible) listOf(AgentChildTreeRow(agent, depth)) else emptyList()) + descendants
        }

        fun runningRows(agents: List<AgentChild>) = rows(agents, includeCompleted = false)
    }
}

data class AgentChildTreeRow(val agent: AgentChild, val depth: Int)

data class AgentChildTree(val agents: List<AgentChild>, val peerError: String?) {
    val agentCount: Int get() = agents.sumOf { it.agentCount }
    val runningCount: Int get() = agents.sumOf { it.runningCount }

    companion object {
        fun read(data: ByteArray): AgentChildTree {
            val o = hookJson.parseToJsonElement(data.decodeToString()).obj ?: throw PhrenKitError.Validation("The computer returned an invalid agent relation.")
            return AgentChildTree((o["agents"].objects ?: throw PhrenKitError.Validation("The computer returned an invalid agent relation.")).map(AgentChild::read), o["peerError"].str)
        }
    }
}

data class AgentFanoutMessage(val id: UUID, val text: String, val status: Status, val createdAt: String) {
    enum class Status(val raw: String) { QUEUED("queued"), RUNNING("running"), COMPLETED("completed"), FAILED("failed") }

    companion object {
        private fun read(o: JsonObject) = AgentFanoutMessage(parseUUID(o["id"].str) ?: throw PhrenKitError.Validation("Invalid worker message."),
            o["text"].str ?: "", Status.entries.firstOrNull { it.raw == o["status"].str } ?: throw PhrenKitError.Validation("Invalid worker message."),
            o["createdAt"].str ?: throw PhrenKitError.Validation("Invalid worker message."))

        fun receipt(data: ByteArray): AgentFanoutMessage {
            val o = hookJson.parseToJsonElement(data.decodeToString()).obj ?: throw PhrenKitError.Validation("The worker did not accept this message.")
            if (o["ok"].bool != true) throw PhrenKitError.Validation("The worker did not accept this message.")
            return read(o["message"].obj ?: throw PhrenKitError.Validation("Invalid worker message."))
        }

        fun list(data: ByteArray): List<AgentFanoutMessage> =
            (hookJson.parseToJsonElement(data.decodeToString()).obj?.get("messages").objects ?: throw PhrenKitError.Validation("Invalid worker messages.")).map(::read)
    }
}

data class AgentChatPanes(val kind: String, val groupId: String, val childId: String, val panes: List<Pane>) {
    @Serializable
    data class Pane(
        val id: String,
        val label: String,
        val agent: String? = null,
        val agentStatus: String? = null,
        val sessionId: String? = null,
        val starting: Boolean? = null,
        val startingToken: String? = null,
        val title: String? = null,
        val cwd: String? = null,
    ) {
        val displayTitle: String get() = if (!title.isNullOrEmpty()) title else label
        val needsAnswer: Boolean get() = agentStatus in listOf("blocked", "waiting")
        fun target(hostID: UUID, workspaceID: String, tabID: String, muxID: String = "herdr:default") = AgentChatTarget(
            hostID, workspaceID, tabID, id, agent ?: "", sessionId ?: "", muxID, if (starting == true && sessionId == null) startingToken else null)
    }

    /** Attaches only to the same starting process; a reported conversation in the pane wins. */
    fun attachedTarget(target: AgentChatTarget): AgentChatTarget? {
        if (!target.isStarting) return null
        val pane = panes.firstOrNull { it.id == target.paneID }
        if (groupId != target.workspaceID || childId != target.tabID || pane == null || pane.agent != target.source)
            throw PhrenKitError.Validation("The starting agent changed. Reopen chat before sending.")
        if (pane.sessionId != null) return pane.target(target.hostID, target.workspaceID, target.tabID, target.muxID)
        if (pane.startingToken != target.startingToken) throw PhrenKitError.Validation("The starting agent changed. Reopen chat before sending.")
        return null
    }

    fun validate(target: AgentChatTarget, @Suppress("UNUSED_PARAMETER") sending: Boolean = false): Pane {
        val pane = panes.firstOrNull { it.id == target.paneID }
        val ok = groupId == target.workspaceID && childId == target.tabID && pane != null && pane.agent == target.source &&
            (if (target.isStarting) pane.starting == true && pane.sessionId == null && pane.startingToken == target.startingToken else pane.sessionId == target.sessionID)
        if (!ok) throw PhrenKitError.Validation("The agent in this pane changed. Reopen chat to choose its current conversation.")
        return pane!!
    }

    companion object {
        fun read(data: ByteArray, workspaceID: String, tabID: String): AgentChatPanes {
            if (data.size > 1_048_576) throw PhrenKitError.Validation("The agent list is too large.")
            val bad = PhrenKitError.Validation("The computer returned a different or invalid agent location. Refresh the session.")
            val o = runCatching { hookJson.parseToJsonElement(data.decodeToString()).obj }.getOrNull() ?: throw bad
            val value = try {
                AgentChatPanes(o["kind"].str!!, o["groupId"].str!!, o["childId"].str!!, hookJson.decodeFromJsonElement(ListSerializer(Pane.serializer()), o["panes"]!!))
            } catch (_: Exception) { throw bad }
            if (value.kind != "herdr" || value.groupId != workspaceID || value.childId != tabID || value.panes.map { it.id }.toSet().size != value.panes.size ||
                !value.panes.all { AgentChatTarget.validID(it.id) }) throw bad
            return value
        }
    }
}

class AgentChatMessage internal constructor(
    val id: String,
    val line: Int,
    val role: Role,
    val title: String?,
    val text: String,
    val imageBlocks: List<Int> = emptyList(),
    /** Images inside a tool result, as the transcript's `blob` route addresses them. */
    val resultImages: List<ImageRef> = emptyList(),
    /** Pictures the phone sent that Claude Code recorded only by path. Stripped from `text`. */
    val uploadImages: List<String> = emptyList(),
    val toolCallID: String? = null,
) {
    enum class Role(val raw: String) { USER("user"), ASSISTANT("assistant"), TOOL("tool") }
    data class ImageRef(val block: Int, val inner: Int?)

    var timestamp: Instant? = null
    var wasQueued = false
    var isQueued = false
    var queueKey: String? = null
    var isToolError = false
    /** Claude's narration between tool calls: progress notes, not the reply. */
    var isNarration = false
    /** What phren's prompt hook injected into the turn, shown folded under it. */
    var isHookContext = false

    val textByteCount: Int = text.toByteArray().size
    /** Includes content, so an edited row of the same length invalidates caches. */
    val renderKey: String = "$id|${role.raw}|${title ?: ""}|$textByteCount|${text.hashCode()}" + if (uploadImages.isEmpty()) "" else "|u${uploadImages.size}:${uploadImages.hashCode()}"
    val localCommand: LocalCommand? = if (role == Role.USER) LocalCommand.parse(text) else null

    val isToolResult: Boolean get() = role == Role.TOOL && title == "Tool result"
    /** A file a shell call changed, attached by Phren Hook. */
    val isChange: Boolean get() = role == Role.TOOL && title == "Changes"
    val isCompaction: Boolean get() = role == Role.TOOL && title == "Conversation compacted"

    fun copy(isQueued: Boolean = this.isQueued, wasQueued: Boolean = this.wasQueued, queueKey: String? = this.queueKey): AgentChatMessage =
        AgentChatMessage(id, line, role, title, text, imageBlocks, resultImages, uploadImages, toolCallID).also {
            it.timestamp = timestamp; it.wasQueued = wasQueued; it.isQueued = isQueued; it.queueKey = queueKey
            it.isToolError = isToolError; it.isNarration = isNarration; it.isHookContext = isHookContext
        }

    override fun equals(other: Any?) = other is AgentChatMessage && renderKey == other.renderKey && line == other.line && timestamp == other.timestamp &&
        wasQueued == other.wasQueued && isQueued == other.isQueued && queueKey == other.queueKey && isToolError == other.isToolError &&
        isNarration == other.isNarration && isHookContext == other.isHookContext && text == other.text && toolCallID == other.toolCallID &&
        imageBlocks == other.imageBlocks && resultImages == other.resultImages && uploadImages == other.uploadImages
    override fun hashCode() = renderKey.hashCode()

    /** A slash command or `!` shell line typed at Claude Code's own prompt. */
    data class LocalCommand(val kind: Kind, val text: String) {
        enum class Kind { COMMAND, SHELL, OUTPUT }

        companion object {
            fun parse(raw: String): LocalCommand? {
                val trimmed = raw.trim()
                if (listOf("<command-name>", "<local-command-stdout>", "<local-command-stderr>", "<bash-input>", "<bash-stdout>", "<bash-stderr>").none { trimmed.startsWith(it) }) return null
                fun tag(name: String): String? {
                    val open = trimmed.indexOf("<$name>").takeIf { it >= 0 } ?: return null
                    val start = open + name.length + 2
                    val close = trimmed.indexOf("</$name>", start).takeIf { it >= 0 } ?: return null
                    return trimmed.substring(start, close).trim()
                }
                tag("command-name")?.let { name ->
                    val args = tag("command-args") ?: ""
                    return LocalCommand(Kind.COMMAND, if (args.isEmpty()) name else "$name $args")
                }
                tag("bash-input")?.let { return LocalCommand(Kind.SHELL, it) }
                return LocalCommand(Kind.OUTPUT, listOf(tag("local-command-stdout"), tag("local-command-stderr"), tag("bash-stdout"), tag("bash-stderr"))
                    .mapNotNull { it }.filter { it.isNotEmpty() }.joinToString("\n"))
            }
        }
    }
}

data class AgentQueueConsumption(val line: Int, val key: String)

data class AgentChatPreview(val turnStartedAt: Instant, val text: String)

/** The model and branch the newest transcript rows report (AgentSessionContext). */
data class AgentSessionContext(var modelName: String? = null, var branch: String? = null, var line: Int = -1) {
    /** Takes `other`'s values when it is at least as new as what is held. */
    fun merge(other: AgentSessionContext) {
        if ((other.modelName == null && other.branch == null) || other.line < line) return
        other.modelName?.let { modelName = it }
        other.branch?.let { branch = it }
        line = other.line
    }

    companion object {
        fun read(raw: JsonObject, source: String, line: Int): AgentSessionContext {
            val found = AgentSessionContext(line = line)
            if (source == "claude" && raw["isMeta"].bool != true && raw["isSidechain"].bool != true) {
                val message = raw["message"].obj
                if (message != null && message["role"].str == "assistant") found.modelName = name(message["model"])
                found.branch = name(raw["gitBranch"], 200)
            } else if (source == "codex" && raw["type"].str == "turn_context") {
                found.modelName = name(raw["payload"].obj?.get("model"))
            }
            return found
        }

        private fun name(value: JsonElement?, limit: Int = 100): String? = value.str?.trim()?.ifEmpty { null }?.take(limit)
    }
}

/** One frame of an agent transcript, normalized to visible conversation content (AgentChatTranscript). */
class AgentChatTranscript(
    val kind: Kind,
    val messages: List<AgentChatMessage>,
    val hasMore: Boolean,
    val totalLines: Int,
    val startLine: Int?,
    /** The Hook's explicit conversation-replacement flag. */
    val reset: Boolean = false,
    val questionEvents: List<AgentQuestionEvent> = emptyList(),
    val progressEvents: List<AgentChatProgressEvent> = emptyList(),
    val queueEvents: List<AgentQueueConsumption> = emptyList(),
    val context: AgentSessionContext = AgentSessionContext(),
    val preview: AgentChatPreview? = null,
    val updatesPreview: Boolean = false,
    /** The harness's own word for the running turn ("Pondering"). */
    val activityVerb: String? = null,
    /** A `/btw` side answer; only on a `side-answer` frame. */
    val sideAnswer: AgentSideAnswer? = null,
    /** Claude's whole spinner line, from a Hook that reads it. */
    val activity: AgentChatSpinner? = null,
) {
    enum class Kind(val raw: String) { BACKLOG("backlog"), APPEND("append"), OLDER("older"), PREVIEW("preview"), SIDE_ANSWER("side-answer") }

    class TooManyMessages : PhrenKitError("This conversation has too many message blocks to load. Open the terminal to view it.")

    /** True only for a snapshot that carries the conversation after a replacement. */
    val replacesConversation: Boolean get() = reset && (totalLines > 0 || messages.isNotEmpty())

    internal class Part(
        val role: AgentChatMessage.Role,
        var title: String? = null,
        var text: String,
        var imageBlocks: List<Int> = emptyList(),
        var resultImages: List<AgentChatMessage.ImageRef> = emptyList(),
        var uploadImages: List<String> = emptyList(),
        var toolCallID: String? = null,
        var idIndex: Int? = null,
        var isToolError: Boolean = false,
        var isNarration: Boolean = false,
    )

    companion object {
        const val MAXIMUM_MESSAGES = 4_000
        const val MAXIMUM_UPLOAD_IMAGES = 8
        private val uploadImageMarker = Regex("\\[Image: source: ([^\\]\\n]+)\\]")
        private val imageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp")

        private fun validQueueKey(key: String) = key.length == 64 && key.all { it in '0'..'9' || it in 'a'..'f' }

        /** `sidechain` reads a child agent's own transcript, where every row is `isSidechain`. */
        fun read(data: ByteArray, source: String, sidechain: Boolean = false, session: String? = null): AgentChatTranscript {
            val unsupported = PhrenKitError.Validation("The computer returned an unsupported chat transcript.")
            if (source !in AgentChatTarget.sources || data.size > 8_388_608) throw unsupported
            val frame = runCatching { hookJson.parseToJsonElement(data.decodeToString()).obj }.getOrNull() ?: throw unsupported
            val kind = Kind.entries.firstOrNull { it.raw == frame["type"].str } ?: throw unsupported
            if (frame["source"].str != source || (session != null && frame["session"].str != session) || (frame.has("entries") && frame["entries"].objects == null)) throw unsupported
            if (kind == Kind.SIDE_ANSWER) return AgentChatTranscript(kind, emptyList(), false, 0, null, sideAnswer = AgentSideAnswer.read(frame))
            val entries = frame["entries"].objects ?: emptyList()
            var preview: AgentChatPreview? = null
            val updatesPreview = kind != Kind.OLDER && frame.has("preview")
            if (updatesPreview && frame["preview"] !is JsonNull) {
                val value = frame["preview"].obj
                val start = ISO8601Dates.parse(value?.get("turnStartedAt").str)
                val text = value?.get("text").str
                if (start == null || text.isNullOrEmpty() || text.toByteArray().size > 131_072) throw PhrenKitError.Validation("The computer returned an invalid reply preview.")
                preview = AgentChatPreview(start, text)
            }
            if (kind == Kind.PREVIEW) {
                if (!updatesPreview || entries.isNotEmpty()) throw PhrenKitError.Validation("A reply preview cannot contain messages.")
                return AgentChatTranscript(kind, emptyList(), false, 0, null, preview = preview, updatesPreview = true,
                    activityVerb = AgentChatSpinner.verb(frame["activityVerb"]), activity = AgentChatSpinner.read(frame["activity"]))
            }
            if (entries.size > 2_000) throw PhrenKitError.Validation("The chat transcript is too large.")
            val messages = mutableListOf<AgentChatMessage>()
            val questionEvents = mutableListOf<AgentQuestionEvent>()
            val progressEvents = mutableListOf<AgentChatProgressEvent>()
            val queueEvents = mutableListOf<AgentQueueConsumption>()
            val context = AgentSessionContext()
            val seen = mutableSetOf<String>()
            var inputWasNotification = false
            for (entry in entries) {
                val line = entry["line"].int ?: continue
                if (line < 0) continue
                var raw = entry["raw"].obj ?: continue
                if (source == "claude" && raw["type"].str == "phren_turn_input") { inputWasNotification = raw["notification"].bool == true; continue }
                if (source == "claude" && raw["type"].str == "phren_hook_context") {
                    val wasNotification = inputWasNotification
                    inputWasNotification = false
                    val content = raw["content"].str
                    if (wasNotification || content.isNullOrEmpty() || !seen.add("$line:hook")) continue
                    val message = AgentChatMessage("$line:hook", line, AgentChatMessage.Role.ASSISTANT, "phren context", boundedMessageText(content))
                    message.timestamp = timestamp(raw); message.isHookContext = true
                    messages += message; continue
                }
                if (sidechain && raw["isSidechain"].bool == true) raw = JsonObject(raw - "isSidechain")
                if (source in listOf("claude", "codex") && raw["type"].str == "phren_queue_consumed") {
                    val key = raw["key"].str
                    if (key != null && validQueueKey(key)) { queueEvents += AgentQueueConsumption(line, key); continue }
                }
                context.merge(AgentSessionContext.read(raw, source, line))
                var parts = when (source) {
                    "codex" -> codex(raw)
                    "copilot" -> copilot(raw)
                    "phren", "opencode" -> phren(raw)
                    else -> claude(raw, MAXIMUM_MESSAGES - messages.size)
                }
                parts = mergedUserParts(withUploadImages(parts))
                parts = parts + changes(raw, parts)
                questionEvents += AgentQuestionEvent.read(raw, source)
                AgentChatProgressEvent.read(raw, source, line)?.let { progressEvents += it.copy(timestamp = timestamp(raw)) }
                if (source == "claude") {
                    if (raw["phrenQueued"].bool != true && parts.any { it.role == AgentChatMessage.Role.USER && AgentChatMessage.LocalCommand.parse(it.text) == null })
                        progressEvents += AgentChatProgressEvent(line, AgentChatProgressEvent.Value.Started(timestamp(raw)))
                    val message = raw["message"].obj
                    if (message != null && message["stop_reason"].str == "end_turn" && raw["isMeta"].bool != true && raw["isSidechain"].bool != true)
                        progressEvents += AgentChatProgressEvent(line, AgentChatProgressEvent.Value.Finished(timestamp(raw)))
                } else if ((source == "phren" || source == "opencode") && raw["type"].str == "assistant/message") {
                    val d = raw["data"].obj
                    if (d != null && d.has("usage") && d["stop_reason"].str == "end_turn")
                        progressEvents += AgentChatProgressEvent(line, AgentChatProgressEvent.Value.Finished(ISO8601Dates.parse(raw["time"].str)))
                }
                parts.forEachIndexed { index, part ->
                    val id = "$line:${part.idIndex ?: index}"
                    if ((part.text.isEmpty() && part.role != AgentChatMessage.Role.TOOL) || !seen.add(id)) return@forEachIndexed
                    val toolCallID = part.toolCallID?.takeIf { it.isNotEmpty() && it.toByteArray().size <= 512 }
                    val message = AgentChatMessage(id, line, part.role, part.title, boundedMessageText(part.text), part.imageBlocks, part.resultImages, part.uploadImages, toolCallID)
                    message.timestamp = timestamp(raw)
                    message.isToolError = part.isToolError
                    message.isNarration = part.isNarration
                    if (part.role == AgentChatMessage.Role.USER) message.queueKey = raw["phrenQueueKey"].str?.takeIf(::validQueueKey)
                    if (source in listOf("claude", "codex") && part.role == AgentChatMessage.Role.USER && raw["phrenQueued"].bool == true) {
                        message.wasQueued = true; message.isQueued = true
                        message.queueKey = raw["phrenQueueKey"].str?.takeIf(::validQueueKey)
                    }
                    messages += message
                }
            }
            val ordered = messages.sortedBy { it.line }
            return AgentChatTranscript(kind, collapsedCompactions(ordered), frame["hasMore"].bool ?: false, frame["totalLines"].int ?: 0,
                frame["startLine"].int ?: entries.mapNotNull { it["line"].int }.minOrNull(), frame["reset"].bool ?: false, questionEvents,
                progressEvents, queueEvents, context, preview, updatesPreview,
                AgentChatSpinner.verb(frame["activityVerb"]), null, AgentChatSpinner.read(frame["activity"]))
        }

        fun boundedMessageText(value: String): String = if (value.toByteArray().size <= 64_000) value else value.take(64_000)

        /** A compaction boundary and its summary draw as one row. */
        private fun collapsedCompactions(messages: List<AgentChatMessage>): List<AgentChatMessage> {
            val result = mutableListOf<AgentChatMessage>()
            var index = 0
            while (index < messages.size) {
                if (!messages[index].isCompaction) { result += messages[index]; index++; continue }
                var end = index
                while (end < messages.size && messages[end].isCompaction) end++
                val group = messages.subList(index, end)
                result += group.firstOrNull { it.text.isNotEmpty() } ?: group.first()
                index = end
            }
            return result
        }

        /** Records `[Image: source: /path]` markers naming images and takes them out of the words. */
        fun uploadImageMarkers(text: String): Pair<String, List<String>> {
            if (!text.contains("[Image: source: ")) return text to emptyList()
            val paths = mutableListOf<String>()
            val stripped = StringBuilder()
            var cursor = 0
            for (match in uploadImageMarker.findAll(text)) {
                val path = match.groupValues[1].trim(' ', '\t')
                val ext = path.substringAfterLast('/').let { name -> name.lastIndexOf('.').takeIf { it > 0 }?.let { name.substring(it + 1) } ?: "" }.lowercase()
                if (!path.startsWith("/") || path.toByteArray().size > 4_096 || ext !in imageExtensions || path.hasControlCharacters()) continue
                if (paths.size < MAXIMUM_UPLOAD_IMAGES) paths += path
                stripped.append(text, cursor, match.range.first); cursor = match.range.last + 1
            }
            if (paths.isEmpty()) return text to emptyList()
            stripped.append(text.substring(cursor))
            return stripped.toString().trim() to paths
        }

        internal fun withUploadImages(parts: List<Part>): List<Part> = parts.map { part ->
            if (part.role != AgentChatMessage.Role.USER) return@map part
            val (text, paths) = uploadImageMarkers(part.text)
            if (paths.isEmpty()) part else Part(part.role, part.title, text.ifEmpty { "[Image attachment]" }, part.imageBlocks, part.resultImages, paths,
                part.toolCallID, part.idIndex, part.isToolError, part.isNarration)
        }

        /** One turn from the person is one bubble: text and image parts fold into the first. */
        internal fun mergedUserParts(parts: List<Part>): List<Part> {
            val users = parts.indices.filter { parts[it].role == AgentChatMessage.Role.USER }
            if (users.size <= 1) return parts
            val first = users.first()
            val texts = mutableListOf<String>()
            val imageBlocks = mutableListOf<Int>()
            val uploadImages = mutableListOf<String>()
            for (i in users) {
                val p = parts[i]
                imageBlocks += p.imageBlocks; uploadImages += p.uploadImages
                if (p.text != "[Image attachment]" && p.text.isNotEmpty()) texts += p.text
            }
            val base = parts[first]
            val merged = Part(AgentChatMessage.Role.USER, base.title, if (texts.isEmpty()) "[Image attachment]" else texts.joinToString("\n\n"),
                imageBlocks, base.resultImages, uploadImages.take(MAXIMUM_UPLOAD_IMAGES), base.toolCallID, base.idIndex)
            return parts.mapIndexedNotNull { i, p -> if (i == first) merged else if (p.role != AgentChatMessage.Role.USER) p else null }
        }

        /** Text a harness injects as if the person typed it. */
        fun isHarnessPreamble(text: String): Boolean {
            val t = text.trim()
            return listOf("<environment_context>", "<filesystem>", "<permission_profile", "<system-reminder>", "<user_instructions>", "<turn_context>").any { t.startsWith(it) }
        }

        /** A user turn that is only Claude Code's background completion envelope. */
        fun isTaskNotification(text: String): Boolean {
            val t = text.trim()
            if (!t.contains("<task-notification>") || !t.contains("<tool-use-id>")) return false
            return t.startsWith("<task-notification>") || t.startsWith("<system-reminder>")
        }

        fun timestamp(raw: JsonObject): Instant? = jsonTimestamp(raw["timestamp"])

        private fun innerImages(content: JsonElement?): List<Int> =
            (content.objects ?: emptyList()).mapIndexedNotNull { i, b -> if (b["type"].str in listOf("image", "input_image")) i else null }

        /** What a shell call changed, as Phren Hook attaches it (`phren_changes`, keyed by call id). */
        private fun changes(raw: JsonObject, after: List<Part>): List<Part> {
            val attached = raw["phren_changes"].obj ?: return emptyList()
            val extra = mutableListOf<Part>()
            for (part in after) {
                if (part.title != "Tool result") continue
                val id = part.toolCallID ?: continue
                val files = attached[id].objects ?: continue
                for (file in files.take(40)) {
                    val path = file["path"].str ?: continue
                    val patch = file["patch"].str ?: continue
                    if (path.isEmpty() || path.toByteArray().size > 4_096 || patch.isEmpty()) continue
                    val status = file["status"].str ?: "M"
                    val header = when (status) { "A" -> "*** Add File: "; "D" -> "*** Delete File: "; else -> "*** Update File: " }
                    val hunks = patch.split("\n").dropWhile { !it.startsWith("@@") }.joinToString("\n")
                    extra += Part(AgentChatMessage.Role.TOOL, "Changes", header + path + "\n" + hunks, toolCallID = id)
                }
            }
            return extra
        }

        internal fun text(value: JsonElement?): String {
            value.str?.let { return it }
            val blocks = value.objects ?: return ""
            return blocks.mapNotNull { b ->
                when (b["type"].str) {
                    "text", "input_text", "output_text" -> b["text"].str
                    "image", "input_image" -> "[Image attachment]"
                    else -> null
                }
            }.joinToString("\n\n")
        }

        internal fun readable(value: JsonElement?): String {
            value.str?.let { return it }
            if (value == null || value is JsonNull || value is JsonPrimitive) return ""
            return prettyJson(value)
        }

        private fun codex(raw: JsonObject): List<Part> {
            if (raw["type"].str != "response_item") return emptyList()
            val payload = raw["payload"].obj ?: return emptyList()
            return when (payload["type"].str) {
                "message" -> {
                    val role = AgentChatMessage.Role.entries.firstOrNull { it.raw == payload["role"].str }
                    if (role == null || role == AgentChatMessage.Role.TOOL) return emptyList()
                    val images = (payload["content"].objects ?: emptyList()).mapIndexedNotNull { i, b -> if (b["type"].str in listOf("input_image", "image")) i else null }
                    val body = text(payload["content"])
                    // Codex's own environment preamble is the harness talking, not the person.
                    if (role == AgentChatMessage.Role.USER && images.isEmpty() && isHarnessPreamble(body)) return emptyList()
                    listOf(Part(role, text = body, imageBlocks = images))
                }
                "function_call", "custom_tool_call" -> listOf(Part(AgentChatMessage.Role.TOOL, payload["name"].str ?: "Tool", readable(payload["arguments"] ?: payload["input"]),
                    toolCallID = payload["call_id"].str))
                "function_call_output", "custom_tool_call_output" -> listOf(Part(AgentChatMessage.Role.TOOL, "Tool result", readable(payload["output"]),
                    resultImages = innerImages(payload["output"]).map { AgentChatMessage.ImageRef(it, null) }, toolCallID = payload["call_id"].str))
                else -> emptyList()
            }
        }

        /** phren-agent's event log, as Phren Hook exports it. */
        private fun phren(raw: JsonObject): List<Part> {
            val type = raw["type"].str ?: return emptyList()
            val message = raw["data"].obj?.get("message").obj ?: return emptyList()
            val role = when (type) {
                "user/message" -> AgentChatMessage.Role.USER
                "assistant/message" -> AgentChatMessage.Role.ASSISTANT
                "tool/results" -> AgentChatMessage.Role.TOOL
                else -> return emptyList()
            }
            message["content"].str?.let { return if (role == AgentChatMessage.Role.TOOL) emptyList() else listOf(Part(role, text = it)) }
            val blocks = message["content"].objects ?: return emptyList()
            return blocks.mapIndexedNotNull { index, block ->
                when (block["type"].str) {
                    "text" -> {
                        val t = block["text"].str
                        if (role == AgentChatMessage.Role.TOOL || t.isNullOrEmpty()) null else Part(role, text = t, idIndex = index)
                    }
                    "image" -> if (role == AgentChatMessage.Role.TOOL) null else Part(role, text = "[Image attachment]", imageBlocks = listOf(index), idIndex = index)
                    "tool_use" -> Part(AgentChatMessage.Role.TOOL, block["name"].str ?: "Tool", readable(block["input"]), toolCallID = block["id"].str, idIndex = index)
                    "tool_result" -> Part(AgentChatMessage.Role.TOOL, "Tool result", text(block["content"]),
                        resultImages = innerImages(block["content"]).map { AgentChatMessage.ImageRef(index, it) },
                        toolCallID = block["tool_use_id"].str, idIndex = index, isToolError = block["is_error"].bool == true)
                    else -> null
                }
            }
        }

        private fun copilot(raw: JsonObject): List<Part> {
            if (raw.has("agentId") || raw["ephemeral"].bool == true) return emptyList()
            val data = raw["data"].obj ?: return emptyList()
            return when (raw["type"].str) {
                "user.message" -> if (data["source"] == null || data["source"].str == "user") listOf(Part(AgentChatMessage.Role.USER, text = text(data["content"]))) else emptyList()
                "assistant.message" -> listOf(Part(AgentChatMessage.Role.ASSISTANT, text = text(data["content"])))
                "tool.execution_start" -> listOf(Part(AgentChatMessage.Role.TOOL, data["toolName"].str ?: "Tool", readable(data["arguments"]), toolCallID = data["toolCallId"].str))
                "tool.execution_complete" -> {
                    val result = data["result"].obj
                    val error = data["error"].obj
                    listOf(Part(AgentChatMessage.Role.TOOL, "Tool result", text(result?.get("content")) + text(error?.get("message")), toolCallID = data["toolCallId"].str,
                        isToolError = data["success"].bool == false || error != null))
                }
                else -> emptyList()
            }
        }

        private fun claude(raw: JsonObject, maximumParts: Int): List<Part> {
            if (raw["type"].str == "system" && raw["phrenCompacted"].bool == true) return listOf(Part(AgentChatMessage.Role.TOOL, "Conversation compacted", ""))
            if (raw["phrenBackground"].bool == true) {
                raw["message"].obj?.get("content").str?.let { return listOf(Part(AgentChatMessage.Role.TOOL, "Background notification", it)) }
            }
            if (raw["isMeta"].bool == true || raw["isSidechain"].bool == true) return emptyList()
            val message = raw["message"].obj ?: return emptyList()
            val role = AgentChatMessage.Role.entries.firstOrNull { it.raw == message["role"].str }
            if (role == null || role == AgentChatMessage.Role.TOOL) return emptyList()
            if (role == AgentChatMessage.Role.USER && raw["isCompactSummary"].bool == true)
                return listOf(Part(AgentChatMessage.Role.TOOL, "Conversation compacted", text(message["content"]).take(4_000)))
            message["content"].str?.let { content ->
                if (role == AgentChatMessage.Role.USER && isTaskNotification(content)) return listOf(Part(AgentChatMessage.Role.TOOL, "Background notification", content))
                if (role == AgentChatMessage.Role.USER && content.startsWith("This session is being continued from a previous conversation"))
                    return listOf(Part(AgentChatMessage.Role.TOOL, "Conversation compacted", content.take(4_000)))
                if (role == AgentChatMessage.Role.USER && isHarnessPreamble(content)) return emptyList()
                if (content.isNotEmpty() && maximumParts <= 0) throw TooManyMessages()
                return listOf(Part(role, text = content))
            }
            val blocks = message["content"].objects ?: return emptyList()
            // A single row can hold thousands of blocks: bound them before allocating parts.
            var visible = 0
            for (block in blocks) {
                when (block["type"].str) {
                    "text" -> if (block["text"].str.isNullOrEmpty()) continue
                    "image", "tool_use", "tool_result" -> {}
                    else -> continue
                }
                visible++
                if (visible > maximumParts) throw TooManyMessages()
            }
            var normalizedIndex = 0
            return blocks.mapIndexedNotNull { index, block ->
                val type = block["type"].str
                if (type !in listOf("text", "image", "tool_use", "tool_result")) return@mapIndexedNotNull null
                val idIndex = normalizedIndex++
                when (type) {
                    "text" -> {
                        val t = block["text"].str
                        if (t.isNullOrEmpty()) null
                        else if (role == AgentChatMessage.Role.USER && isTaskNotification(t)) Part(AgentChatMessage.Role.TOOL, "Background notification", t, idIndex = idIndex)
                        else Part(role, text = t, idIndex = idIndex, isNarration = role == AgentChatMessage.Role.ASSISTANT && block["narration"].bool == true)
                    }
                    "image" -> Part(role, text = "[Image attachment]", imageBlocks = listOf(index), idIndex = idIndex)
                    "tool_use" -> Part(AgentChatMessage.Role.TOOL, block["name"].str ?: "Tool", readable(block["input"]), toolCallID = block["id"].str, idIndex = idIndex)
                    else -> Part(AgentChatMessage.Role.TOOL, "Tool result", text(block["content"]),
                        resultImages = innerImages(block["content"]).map { AgentChatMessage.ImageRef(index, it) },
                        toolCallID = block["tool_use_id"].str, idIndex = idIndex, isToolError = block["is_error"].bool == true)
                }
            }
        }
    }
}

@Suppress("unused") private val keepArray = JsonArray::class
