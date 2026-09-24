package com.phren.kit

import java.security.MessageDigest
import java.util.UUID

/**
 * Merges reconnect snapshots, live appends and older pages by absolute line
 * (AgentChatHistory.swift). A value type in Swift: `copy()` gives an
 * independent history, and messages are never mutated in place.
 */
class AgentChatHistory private constructor(
    messages: List<AgentChatMessage>,
    startLine: Int?,
    totalLines: Int,
    hasMore: Boolean,
    hasNewer: Boolean,
    private var consumedQueueEvents: Set<AgentQueueConsumption>,
    private var assignedQueueEvents: Set<AgentQueueConsumption>,
    private var consumedQueueMessages: Set<String>,
    private var replacedQueueMessages: Map<String, String>,
    private var retiredQueue: List<RetiredQueue>,
    private var acknowledgementIDs: Map<String, String>,
) {
    constructor() : this(emptyList(), null, 0, false, false, emptySet(), emptySet(), emptySet(), emptyMap(), emptyList(), emptyMap())

    private data class RetiredQueue(val id: String, val line: Int, val key: String)

    var messages: List<AgentChatMessage> = messages; private set
    var startLine: Int? = startLine; private set
    var totalLines: Int = totalLines; private set
    var hasMore: Boolean = hasMore; private set
    var hasNewer: Boolean = hasNewer; private set

    fun copy() = AgentChatHistory(messages, startLine, totalLines, hasMore, hasNewer, consumedQueueEvents, assignedQueueEvents,
        consumedQueueMessages, replacedQueueMessages, retiredQueue, acknowledgementIDs)

    override fun equals(other: Any?) = other is AgentChatHistory && messages == other.messages && startLine == other.startLine &&
        totalLines == other.totalLines && hasMore == other.hasMore && hasNewer == other.hasNewer && consumedQueueEvents == other.consumedQueueEvents &&
        assignedQueueEvents == other.assignedQueueEvents && consumedQueueMessages == other.consumedQueueMessages &&
        replacedQueueMessages == other.replacedQueueMessages && retiredQueue == other.retiredQueue && acknowledgementIDs == other.acknowledgementIDs
    override fun hashCode() = messages.hashCode()

    fun acknowledgementID(messageID: String): String = acknowledgementIDs[messageID] ?: messageID

    fun receive(frame: AgentChatTranscript) {
        if (frame.kind == AgentChatTranscript.Kind.PREVIEW) return
        // Only an explicit replacement clears what the phone retained.
        if (frame.replacesConversation) {
            messages = emptyList(); startLine = null; totalLines = 0; hasMore = false; hasNewer = false
            consumedQueueEvents = emptySet(); assignedQueueEvents = emptySet(); consumedQueueMessages = emptySet()
            replacedQueueMessages = emptyMap(); retiredQueue = emptyList(); acknowledgementIDs = emptyMap()
        }
        val merged = LinkedHashMap<String, AgentChatMessage>()
        messages.forEach { merged[it.id] = it }
        for (message in frame.messages) {
            if (replacedQueueMessages[message.id] != null) continue
            // Browsing beyond the live window, incoming output must not evict the older messages being read.
            if (!hasNewer || frame.kind == AgentChatTranscript.Kind.OLDER || merged[message.id] != null) merged[message.id] = message
        }
        val list = merged.values.sortedWith(compareBy<AgentChatMessage> { it.line }.thenBy { it.id }).toMutableList()
        consumedQueueEvents = consumedQueueEvents + frame.queueEvents
        val consumedMessages = consumedQueueMessages.toMutableSet()
        val assigned = assignedQueueEvents.toMutableSet()
        // Repeated real turns are legitimate. Only pair pending handoffs.
        for (i in list.indices) if (list[i].wasQueued) list[i] = list[i].copy(isQueued = list[i].id !in consumedMessages)
        for (event in consumedQueueEvents.sortedBy { it.line }) {
            if (event in assigned) continue
            val index = list.indexOfFirst { it.isQueued && it.queueKey == event.key && it.line < event.line }.takeIf { it >= 0 }
            val retired = retiredQueue.firstOrNull { it.key == event.key && it.line < event.line && it.id !in consumedMessages }
            if (retired != null && retired.line < (index?.let { list[it].line } ?: Int.MAX_VALUE)) {
                assigned += event; consumedMessages += retired.id
            } else if (index != null) {
                list[index] = list[index].copy(isQueued = false)
                assigned += event
                consumedMessages += list[index].id
            }
        }
        val pageIDs = (if (frame.kind == AgentChatTranscript.Kind.APPEND) list else frame.messages).map { it.id }.toSet()
        val replacements = AgentQueuedMessages.replacements(list, pageIDs, acknowledgementIDs.keys)
        replacedQueueMessages = replacedQueueMessages + replacements
        val acks = acknowledgementIDs.toMutableMap()
        val retiredList = retiredQueue.toMutableList()
        for (message in list) {
            val realID = replacements[message.id] ?: continue
            acks[realID] = message.id
            message.queueKey?.let { retiredList += RetiredQueue(message.id, message.line, it) }
        }
        retiredList.sortBy { it.line }
        // Older Hooks cannot identify removals: stop drawing an unkeyed row as pending after the next real turn.
        var hasRealTurn = false
        for (i in list.indices.reversed()) {
            val m = list[i]
            if (m.role == AgentChatMessage.Role.USER && !m.wasQueued && m.localCommand == null) hasRealTurn = true
            if (hasRealTurn && m.wasQueued && m.queueKey == null) { list[i] = m.copy(isQueued = false); consumedMessages += m.id }
        }
        list.removeAll { replacedQueueMessages[it.id] != null }
        acknowledgementIDs = acks
        retiredQueue = retiredList
        if (replacedQueueMessages.size > 4_000) {
            val retained = list.map { it.id }.toSet()
            replacedQueueMessages = replacedQueueMessages.filterValues { it in retained }
            acknowledgementIDs = acknowledgementIDs.filterKeys { it in retained }
            retiredQueue = retiredQueue.takeLast(4_000)
        }
        totalLines = maxOf(totalLines, frame.totalLines)
        // An empty placeholder while the file is missing claims no range.
        val placeholder = frame.reset && frame.totalLines == 0 && frame.messages.isEmpty()
        val start = frame.startLine
        if (!placeholder && frame.kind != AgentChatTranscript.Kind.APPEND && start != null && start <= (startLine ?: Int.MAX_VALUE)) {
            startLine = start; hasMore = frame.hasMore
        }
        // An empty final page must still finish pagination on older Hooks.
        if (frame.kind == AgentChatTranscript.Kind.OLDER && !frame.hasMore) hasMore = false
        assignedQueueEvents = assigned
        consumedQueueMessages = consumedMessages
        if (consumedQueueEvents.size > 4_000) {
            consumedQueueEvents = consumedQueueEvents.sortedByDescending { it.line }.take(4_000).toSet()
            assignedQueueEvents = assignedQueueEvents intersect consumedQueueEvents
            consumedQueueMessages = consumedQueueMessages intersect (list.map { it.id } + retiredQueue.map { it.id }).toSet()
        }
        var bytes = 0
        var keep = 0
        val retainOlder = frame.kind == AgentChatTranscript.Kind.OLDER || hasNewer
        for (m in if (retainOlder) list else list.asReversed()) {
            bytes += m.textByteCount
            if (bytes > 12 * 1_024 * 1_024 || keep >= 4_000) break
            keep++
        }
        messages = if (keep < list.size) {
            if (retainOlder) { hasNewer = true; list.take(keep) }
            else list.takeLast(keep).also { startLine = it.firstOrNull()?.line; hasMore = (startLine ?: 0) > 0 }
        } else list
    }
}

object AgentQueuedMessages {
    private val imageMarker = Regex("\\[Image #\\d+\\]|\\[Image attachment\\]")

    /** The instruction, without Claude's pasted-image labels and attachment footer. Pending → real handoff only. */
    fun normalizedText(text: String): String {
        var value = imageMarker.replace(text, "")
        // Drop each footer and the paths under it, keeping any text after them.
        while (true) {
            val footer = value.indexOf("Attached files on this computer:").takeIf { it >= 0 } ?: break
            var rest = value.substring(footer + "Attached files on this computer:".length)
            while (true) {
                val first = rest.indexOfFirst { it != '\n' && it != '\r' && it != ' ' && it != ' ' && it != '\u000B' && it != '\u000C' && it != '\u0085' }
                if (first < 0) break
                val line = rest.substring(first)
                if (!(line.startsWith("/") || line.startsWith("~/"))) break
                val nl = line.indexOfFirst { it == '\n' || it == '\r' || it == ' ' || it == ' ' || it == '\u000B' || it == '\u000C' || it == '\u0085' }
                rest = if (nl >= 0) line.substring(nl) else ""
            }
            value = value.substring(0, footer) + "\n" + rest
        }
        return value.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    }

    /** Pairs one real turn with one earlier queue row, preferring its key; text fallback only within the page. */
    fun replacements(messages: List<AgentChatMessage>, pageIDs: Set<String>, acknowledgedRealIDs: Set<String>): Map<String, String> {
        val pending = mutableListOf<AgentChatMessage>()
        val normalized = mutableMapOf<String, String>()
        val replaced = mutableMapOf<String, String>()
        for (message in messages) {
            if (message.role != AgentChatMessage.Role.USER || message.localCommand != null) continue
            if (message.wasQueued) {
                pending += message
                if (message.id in pageIDs) normalized[message.id] = normalizedText(message.text)
            } else {
                if (pending.isEmpty() || message.id in acknowledgedRealIDs) continue
                var index: Int? = message.queueKey?.let { key -> pending.indexOfFirst { it.queueKey == key }.takeIf { it >= 0 } }
                if (index == null && message.id in pageIDs) {
                    val text = normalizedText(message.text)
                    if (text.isNotEmpty()) index = pending.indexOfFirst { q ->
                        // Conflicting known keys always mean distinct sends.
                        (message.queueKey == null || q.queueKey == null) && normalized[q.id] == text
                    }.takeIf { it >= 0 }
                }
                index?.let { replaced[pending.removeAt(it).id] = message.id }
            }
        }
        return replaced
    }
}

data class AgentAttachment(val id: UUID, val name: String, val data: ByteArray, val isImage: Boolean, val uploadName: String, val contentDigest: String) {
    override fun equals(other: Any?) = other is AgentAttachment && id == other.id && name == other.name && data.contentEquals(other.data) && isImage == other.isImage
    override fun hashCode() = id.hashCode()

    companion object {
        const val MAXIMUM_BYTES = 8 * 1_024 * 1_024

        fun of(name: String, data: ByteArray, isImage: Boolean = false, id: UUID = UUID.randomUUID()): AgentAttachment {
            if (data.isEmpty() || data.size > MAXIMUM_BYTES) throw PhrenKitError.Validation("Choose a file smaller than 8 MB.")
            val digest = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
            val cleaned = name.filter { !it.toString().hasControlCharacters() }.take(160)
            val last = name.substringAfterLast('/')
            val ext = last.lastIndexOf('.').takeIf { it > 0 }?.let { last.substring(it + 1).lowercase() } ?: ""
            val safeExtension = if (Regex("^[a-z0-9]{1,12}$").matches(ext)) ext else "bin"
            return AgentAttachment(id, cleaned, data, isImage, "phren-${id.toString().lowercase()}.$safeExtension", digest)
        }

        /** Accepts Hook 0.2.11's path-without-`ok` response; rejects explicit failures and unsafe paths. */
        fun uploadedPath(data: ByteArray): String {
            val value = runCatching { hookJson.parseToJsonElement(data.decodeToString()).obj }.getOrNull()
            val path = value?.get("path").str
            val ok = value != null && !value.has("error") && (!value.has("ok") || value["ok"].bool == true) &&
                path != null && path.startsWith("/") && path.toByteArray().size <= 4_096 && !path.hasControlCharacters()
            if (!ok) throw PhrenKitError.Validation("The computer did not return a usable attachment path.")
            return path!!
        }
    }
}

/** Geometry deciding whether a followed transcript needs to move (ChatScrollMetrics). */
data class ChatScrollMetrics(val contentHeight: Float, val viewportHeight: Float, val offsetY: Float) {
    /** The largest valid offset; insets change the viewport, not the transcript's end. */
    val bottomOffset: Float get() = maxOf(0f, contentHeight - viewportHeight)
    val distanceFromBottom: Float get() = bottomOffset - offsetY

    companion object {
        fun correctiveOffset(metrics: ChatScrollMetrics): Float? =
            if (metrics.viewportHeight > 0.5f && metrics.offsetY > metrics.bottomOffset + 0.5f) metrics.bottomOffset else null

        fun clamp(target: Float, metrics: ChatScrollMetrics) = maxOf(0f, minOf(target, metrics.bottomOffset))

        /** A content height that jumped far past the viewport at once: a lazy stack's estimate. */
        fun isEstimateJump(old: ChatScrollMetrics, new: ChatScrollMetrics) = new.viewportHeight > 0.5f && new.contentHeight - old.contentHeight > 3 * new.viewportHeight

        /** Re-pin for transcript growth or an already invalid offset; a viewport-only change doesn't. */
        fun shouldRepin(old: ChatScrollMetrics, new: ChatScrollMetrics, userDriven: Boolean): Float? {
            val grew = new.contentHeight > old.contentHeight + 0.5f
            val past = new.offsetY > new.bottomOffset + 0.5f
            if (userDriven || new.contentHeight <= new.viewportHeight + 0.5f || !(grew || past)) return null
            return new.bottomOffset
        }
    }
}
