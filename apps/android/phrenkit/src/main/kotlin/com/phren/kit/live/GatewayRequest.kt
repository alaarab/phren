package com.phren.kit.live

import com.phren.kit.AgentAnswerKey
import com.phren.kit.AgentAttachment
import com.phren.kit.AgentChatTarget
import com.phren.kit.LiveHost
import com.phren.kit.PhrenKitError
import com.phren.kit.jsonElement
import com.phren.kit.parseUUID
import java.net.URLEncoder
import java.util.Base64

/** One Hook route over the pinned connection (AgentChatConnection.swift GatewayRequest). */
data class GatewayRequest(
    val path: String,
    val body: ByteArray? = null,
    /** Nil derives GET from an empty body and POST otherwise. */
    val method: String? = null,
    val maximumResponseBytes: Int = 1_048_576,
    val webSocket: Boolean = false,
    val streaming: Boolean = false,
    val beforeLine: Int? = null,
    val initialMessages: List<ByteArray> = emptyList(),
    val timeoutSeconds: Int? = null,
) {
    val httpMethod: String get() = when (method) { "GET", "POST", "DELETE" -> method; else -> if (body == null) "GET" else "POST" }

    /** Overview and workspace routes name the Herdr server this connection selects. */
    fun scoped(host: LiveHost): GatewayRequest {
        if (!path.startsWith("/v1/workspaces") && !path.startsWith("/v1/overview")) return this
        val question = path.indexOf('?')
        val base = if (question < 0) path else path.substring(0, question)
        val items = (if (question < 0) emptyList() else path.substring(question + 1).split('&').filter { it.isNotEmpty() })
            .filter { it.substringBefore('=') != "mux" } + "mux=${encode(host.muxID)}"
        return copy(path = base + "?" + items.joinToString("&"))
    }

    override fun equals(other: Any?) = other is GatewayRequest && path == other.path && (body?.contentEquals(other.body ?: ByteArray(0)) ?: (other.body == null)) &&
        method == other.method && webSocket == other.webSocket && streaming == other.streaming && beforeLine == other.beforeLine
    override fun hashCode() = path.hashCode()

    companion object {
        val workspaces = GatewayRequest("/v1/workspaces?watchApprovals=1")
        /** The pushed overview; the socket stays open while the phone watches. */
        val overview = GatewayRequest("/v1/overview?watchApprovals=1", webSocket = true, streaming = true)
        val health = GatewayRequest("/v1/health")

        /** Swift's URLQueryItem encoding: everything but unreserved characters and a few sub-delimiters. */
        fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20").replace("%3A", ":").replace("%2F", "/")

        fun path(path: String, query: Map<String, String>): String =
            path + "?" + query.entries.sortedBy { it.key }.joinToString("&") { "${encode(it.key)}=${encode(it.value)}" }

        fun panes(workspace: String, tab: String) = GatewayRequest(path("/v1/workspaces/panes", mapOf("groupId" to workspace, "childId" to tab)))

        fun targetQuery(target: AgentChatTarget): Map<String, String> = mapOf(
            "server" to target.muxID.removePrefix("herdr:"), "workspace" to target.workspaceID, "tab" to target.tabID,
            "pane" to target.paneID, "source" to target.source, "session" to target.sessionID)

        fun transcript(target: AgentChatTarget, streaming: Boolean = false, beforeLine: Int? = null, afterLine: Int? = null): GatewayRequest {
            val query = targetQuery(target).toMutableMap()
            afterLine?.let { query["afterLine"] = it.toString() }
            // The live stream also carries `/btw` side answers; older Hooks ignore the flag.
            if (streaming) query["sideAnswers"] = "1"
            return GatewayRequest(path("/v1/transcripts", query), webSocket = true, streaming = streaming, beforeLine = beforeLine)
        }

        fun history(target: AgentChatTarget, beforeLine: Int) =
            GatewayRequest(path("/v1/transcripts/history", targetQuery(target) + ("beforeLine" to beforeLine.toString())), maximumResponseBytes = 8_388_608)

        fun childAgents(target: AgentChatTarget) = GatewayRequest(path("/v1/subagents", targetQuery(target)))
        fun resumeChild(target: AgentChatTarget, child: String, text: String) =
            GatewayRequest("/v1/subagents/resume", body = targetBody(target, mapOf("child" to child, "text" to text)))
        fun archiveFinishedChildren(target: AgentChatTarget) = GatewayRequest("/v1/subagents/archive-finished", body = targetBody(target))
        fun childTranscript(target: AgentChatTarget, child: String) =
            GatewayRequest(path("/v1/subagents/transcript", targetQuery(target) + ("child" to child)), maximumResponseBytes = 8_388_608)
        fun childTranscriptStream(target: AgentChatTarget, child: String) =
            GatewayRequest(path("/v1/transcripts", targetQuery(target) + ("child" to child)), webSocket = true, streaming = true)
        fun childHistory(target: AgentChatTarget, child: String, beforeLine: Int) = GatewayRequest(
            path("/v1/transcripts/history", targetQuery(target) + mapOf("child" to child, "beforeLine" to beforeLine.toString())), maximumResponseBytes = 8_388_608)

        /** A sorted-keys JSON body naming the exact conversation. */
        fun targetBody(target: AgentChatTarget, fields: Map<String, Any?> = emptyMap()): ByteArray =
            sortedJson(fields + ("target" to targetQuery(target)))

        /** A starting pane has no conversation yet: the Hook checks its token instead. */
        private fun startingRoute(target: AgentChatTarget): Map<String, Any?> =
            targetQuery(target).minus("session") + mapOf("starting" to true, "startingToken" to target.startingToken)

        private fun inputRequest(route: String, target: AgentChatTarget, fields: Map<String, Any?>) = GatewayRequest(route,
            body = if (target.isStarting) sortedJson(fields + ("target" to startingRoute(target))) else targetBody(target, fields))

        fun upload(attachment: AgentAttachment, target: AgentChatTarget) = GatewayRequest("/v1/upload",
            body = targetBody(target, mapOf("name" to attachment.uploadName, "data" to Base64.getEncoder().encodeToString(attachment.data))))

        fun dismissSideAnswer(target: AgentChatTarget, id: String): GatewayRequest {
            if (parseUUID(id) == null) throw PhrenKitError.Validation("That side answer is not valid.")
            return GatewayRequest("/v1/side-question/dismiss", body = targetBody(target, mapOf("id" to id)))
        }
        fun stop(target: AgentChatTarget) = GatewayRequest("/v1/keys", body = targetBody(target, mapOf("keys" to listOf("Escape"))))
        fun keys(target: AgentChatTarget, keys: List<AgentAnswerKey>) = inputRequest("/v1/keys", target, mapOf("keys" to keys.map { it.rawValue }))
        fun secret(target: AgentChatTarget, text: String) = inputRequest("/v1/secret", target, mapOf("text" to text))
        fun prompt(target: AgentChatTarget, text: String) = inputRequest("/v1/prompt", target, mapOf("text" to text))
        fun model(target: AgentChatTarget, model: String, effort: String? = null): GatewayRequest {
            if (target.isStarting) throw PhrenKitError.Validation("Choose a model for an established conversation.")
            return GatewayRequest("/v1/model", body = targetBody(target, mapOf("model" to model) + (effort?.let { mapOf("effort" to it) } ?: emptyMap())))
        }

        fun sortedJson(value: Map<String, Any?>): ByteArray = jsonElement(sortKeys(value)).toString().toByteArray()
        private fun sortKeys(value: Any?): Any? = when (value) {
            is Map<*, *> -> value.entries.sortedBy { it.key as String }.associate { (k, v) -> k as String to sortKeys(v) }
            is List<*> -> value.map(::sortKeys)
            else -> value
        }
    }
}
