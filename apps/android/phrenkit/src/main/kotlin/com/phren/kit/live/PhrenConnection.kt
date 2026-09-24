package com.phren.kit.live

import com.phren.kit.AgentAnswerKey
import com.phren.kit.AgentAttachment
import com.phren.kit.AgentChatPanes
import com.phren.kit.AgentChatTarget
import com.phren.kit.AgentChatTranscript
import com.phren.kit.AgentChildTree
import com.phren.kit.AgentFanoutMessage
import com.phren.kit.LiveHost
import com.phren.kit.LiveWorkspaces
import com.phren.kit.PhrenKitError
import com.phren.kit.bool
import com.phren.kit.hasControlCharacters
import com.phren.kit.hookJson
import com.phren.kit.int
import com.phren.kit.obj
import com.phren.kit.parseUUID
import com.phren.kit.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import java.io.EOFException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Bounded, cancellable requests through a pinned SSH connection
 * (PhrenConnection.swift + AgentChatConnection.swift). Only the Hook's routes
 * are reachable: every channel runs `phren-hook v1 pipe`.
 */
object PhrenConnection {
    /**
     * One request on the computer's shared connection. With [receive], a
     * WebSocket route streams: each complete message goes to it until the
     * socket closes, an error ends it, or the caller is cancelled.
     */
    suspend fun fetchData(host: LiveHost, key: DeviceKey, request: GatewayRequest = GatewayRequest.workspaces,
                          receive: ((ByteArray) -> Unit)? = null): ByteArray = withContext(Dispatchers.IO) {
        host.validate()
        val scoped = request.scoped(host)
        val connection = GatewayConnections.connection(host, key)
        var healthy = true
        try {
            val (session, command) = GatewayConnections.openPipe(connection)
            val timedOut = AtomicBoolean(false)
            val firstFrame = AtomicBoolean(false)
            coroutineScope {
                // The deadline covers the whole exchange, or a stream until its first message.
                val deadline = launch {
                    delay((scoped.timeoutSeconds ?: if (scoped.body == null) 20 else 60) * 1_000L)
                    if (receive == null || !firstFrame.get()) { timedOut.set(true); runCatching { session.close() } }
                }
                try {
                    runInterruptible {
                        if (!scoped.webSocket) {
                            HookWire.writeRequest(command.outputStream, scoped)
                            HookWire.readResponse(command.inputStream, scoped).also { body -> receive?.let { it(body); firstFrame.set(true) } }
                        } else webSocket(command, scoped, receive, firstFrame, timedOut, this@coroutineScope)
                    }
                } catch (error: Throwable) {
                    throw when {
                        timedOut.get() -> LiveConnectionError.Timeout()
                        error is LiveConnectionError || error is PhrenKitError || error is CancellationException -> error
                        else -> LiveConnectionError.Disconnected()
                    }
                } finally {
                    deadline.cancel()
                    runCatching { session.close() }
                }
            }
        } catch (error: Throwable) {
            // A transport failure means the shared connection may be gone (the phone
            // changed networks, the computer slept): the next request dials again.
            healthy = !(error is LiveConnectionError && error.retiresConnection) &&
                (error is LiveConnectionError || error is PhrenKitError || error is CancellationException)
            throw error
        } finally {
            GatewayConnections.release(connection, healthy)
        }
    }

    /** TranscriptFrames: reassembles messages, answers pings, and keeps a watched socket alive. */
    private fun webSocket(command: net.schmizz.sshj.connection.channel.direct.Session.Command, request: GatewayRequest,
                          receive: ((ByteArray) -> Unit)?, firstFrame: AtomicBoolean, timedOut: AtomicBoolean,
                          scope: kotlinx.coroutines.CoroutineScope): ByteArray {
        val input = command.inputStream
        val output = command.outputStream
        HookWire.writeUpgrade(output, request.path)
        HookWire.readUpgrade(input)
        for (message in request.initialMessages) HookWire.writeFrame(output, HookWire.Opcode.TEXT, message)
        val lastReceived = AtomicLong(System.nanoTime())
        val heartbeat = if (!request.streaming) null else scope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(20_000)
                if (System.nanoTime() - lastReceived.get() > 45_000_000_000L) { timedOut.set(true); runCatching { command.close() }; break }
                runCatching { HookWire.writeFrame(output, HookWire.Opcode.PING, ByteArray(0)) }
            }
        }
        try {
            val body = java.io.ByteArrayOutputStream()
            var receiving = false
            var requestedOlder = false
            while (true) {
                val frame = try { HookWire.readFrame(input, 8_388_608) } catch (_: EOFException) { throw LiveConnectionError.Disconnected() }
                lastReceived.set(System.nanoTime())
                when (frame.opcode) {
                    HookWire.Opcode.PING.code -> { HookWire.writeFrame(output, HookWire.Opcode.PONG, frame.payload); continue }
                    HookWire.Opcode.PONG.code -> continue
                    HookWire.Opcode.TEXT.code -> { if (receiving) throw LiveConnectionError.Disconnected(); receiving = true }
                    HookWire.Opcode.CONTINUATION.code -> if (!receiving) throw LiveConnectionError.Disconnected()
                    else -> throw LiveConnectionError.Disconnected()
                }
                if (body.size() + frame.payload.size > 8_388_608) throw LiveConnectionError.Oversized()
                body.write(frame.payload)
                if (!frame.fin) continue
                val completed = body.toByteArray()
                body.reset(); receiving = false
                request.beforeLine?.let { beforeLine ->
                    if (!requestedOlder) {
                        requestedOlder = true
                        HookWire.writeFrame(output, HookWire.Opcode.TEXT, "{\"type\":\"older\",\"beforeLine\":$beforeLine,\"limit\":200}".toByteArray())
                        continue
                    }
                    val type = runCatching { hookJson.parseToJsonElement(completed.decodeToString()).obj?.get("type").str }.getOrNull()
                    if (type != "older") continue
                }
                if (receive == null) return completed
                receive(completed)
                firstFrame.set(true)
            }
        } finally { heartbeat?.cancel() }
    }

    // Computers

    private suspend fun health(host: LiveHost, key: DeviceKey): kotlinx.serialization.json.JsonObject? {
        val data = fetchData(host, key, GatewayRequest.health)
        if (data.size > 65_536) return null
        val response = runCatching { hookJson.parseToJsonElement(data.decodeToString()).obj }.getOrNull() ?: return null
        return response.takeIf { it["product"].str == "phren-hook" }
    }

    private fun validName(name: String?) = name != null && name.isNotEmpty() && name.toByteArray().size <= 253 && !name.hasControlCharacters()

    suspend fun computerIdentity(host: LiveHost, key: DeviceKey): LiveWorkspaces.Computer? {
        val computer = health(host, key)?.get("computer").obj ?: return null
        val id = parseUUID(computer["id"].str) ?: return null
        val name = computer["name"].str
        return if (validName(name)) LiveWorkspaces.Computer(id, name!!) else null
    }

    /** The name the computer gives itself (`os.hostname()`), the key the store's machines.yaml uses. */
    suspend fun computerName(host: LiveHost, key: DeviceKey): String? =
        health(host, key)?.get("computer").obj?.get("name").str?.takeIf { validName(it) }

    suspend fun fetch(host: LiveHost, key: DeviceKey): LiveWorkspaces = LiveWorkspaces.read(fetchData(host, key), requiringHook = true)

    // Chat

    private fun sameComputer(host: LiveHost, target: AgentChatTarget, starting: Boolean = true) {
        if ((!starting && target.isStarting) || target.hostID != host.id || target.muxID != host.muxID)
            throw PhrenKitError.Validation("The chat belongs to another computer.")
    }

    fun chatUpdates(host: LiveHost, key: DeviceKey, target: AgentChatTarget, afterLine: Int? = null): Flow<AgentChatTranscript> = callbackFlow {
        sameComputer(host, target, starting = false)
        if (afterLine != null && afterLine < 0) throw PhrenKitError.Validation("The chat transcript cursor is invalid.")
        fetchData(host, key, GatewayRequest.transcript(target, streaming = true, afterLine = afterLine)) { data ->
            if (trySendBlocking(AgentChatTranscript.read(data, target.source)).isFailure) throw LiveConnectionError.Oversized()
        }
        close()
        awaitClose()
    }.buffer(8)

    suspend fun chatHistory(host: LiveHost, key: DeviceKey, target: AgentChatTarget, beforeLine: Int): AgentChatTranscript {
        if (target.isStarting || target.hostID != host.id || target.muxID != host.muxID || beforeLine <= 0)
            throw PhrenKitError.Validation("This history has no earlier destination.")
        val data = try {
            // A history page should not download a fresh backlog first.
            fetchData(host, key, GatewayRequest.history(target, beforeLine))
        } catch (error: LiveConnectionError) {
            // Existing computers remain usable until their Hook is updated.
            val missing = (error is LiveConnectionError.Response && error.status == 404) || (error is LiveConnectionError.GatewayRejection && error.status == 404)
            if (!missing) throw error
            fetchData(host, key, GatewayRequest.transcript(target, beforeLine = beforeLine))
        }
        val result = AgentChatTranscript.read(data, target.source)
        if (result.kind != AgentChatTranscript.Kind.OLDER || result.messages.any { it.line >= beforeLine } ||
            (result.hasMore && result.startLine.let { it == null || it < 0 || it >= beforeLine }))
            throw PhrenKitError.Validation("The computer returned a different history range.")
        return result
    }

    suspend fun chatTranscript(host: LiveHost, key: DeviceKey, target: AgentChatTarget): AgentChatTranscript {
        sameComputer(host, target, starting = false)
        return AgentChatTranscript.read(fetchData(host, key, GatewayRequest.transcript(target)), target.source)
    }

    suspend fun chatPanes(host: LiveHost, key: DeviceKey, workspaceID: String, tabID: String): AgentChatPanes {
        if (!AgentChatTarget.validID(workspaceID) || !AgentChatTarget.validID(tabID)) throw PhrenKitError.Validation("This workspace has no usable chat destination.")
        return AgentChatPanes.read(fetchData(host, key, GatewayRequest.panes(workspaceID, tabID)), workspaceID, tabID)
    }

    suspend fun uploadChatAttachment(host: LiveHost, key: DeviceKey, target: AgentChatTarget, attachment: AgentAttachment): String {
        sameComputer(host, target)
        if (target.isStarting) throw PhrenKitError.Validation("Wait for the conversation to start before attaching files.")
        return AgentAttachment.uploadedPath(fetchData(host, key, GatewayRequest.upload(attachment, target)))
    }

    private fun confirmed(data: ByteArray, message: String) {
        if (runCatching { hookJson.parseToJsonElement(data.decodeToString()).obj?.get("ok").bool }.getOrNull() != true) throw PhrenKitError.Validation(message)
    }

    /** Answers a prompt the agent draws in its terminal with one of the few keys the Hook accepts. */
    suspend fun answerWithKeys(host: LiveHost, key: DeviceKey, target: AgentChatTarget, keys: List<AgentAnswerKey>) {
        sameComputer(host, target)
        if (keys.isEmpty() || keys.size > 4) throw PhrenKitError.Validation("Press one key at a time.")
        confirmed(fetchData(host, key, GatewayRequest.keys(target, keys)), "The key was not confirmed. Check the terminal.")
    }

    /** Types a secret the terminal asked for; the Hook sends it one key at a time and never stores it. */
    suspend fun answerWithSecret(host: LiveHost, key: DeviceKey, target: AgentChatTarget, text: String) {
        sameComputer(host, target)
        if (text.length !in 1..256 || text.any { it.isISOControl() })
            throw PhrenKitError.Validation("Enter 1 to 256 characters without control characters or newlines.")
        confirmed(fetchData(host, key, GatewayRequest.secret(target, text)), "The secret was not confirmed. Check the terminal.")
    }

    suspend fun dismissSideAnswer(host: LiveHost, key: DeviceKey, target: AgentChatTarget, id: String) {
        sameComputer(host, target, starting = false)
        fetchData(host, key, GatewayRequest.dismissSideAnswer(target, id))
    }

    /** Only Escape; the Hook refuses it unless the agent is still working. */
    suspend fun stopChatTurn(host: LiveHost, key: DeviceKey, target: AgentChatTarget) {
        sameComputer(host, target, starting = false)
        confirmed(fetchData(host, key, GatewayRequest.stop(target)), "The stop request was not confirmed. Check the terminal.")
    }

    suspend fun childAgents(host: LiveHost, key: DeviceKey, target: AgentChatTarget): AgentChildTree {
        sameComputer(host, target, starting = false)
        return AgentChildTree.read(fetchData(host, key, GatewayRequest.childAgents(target)))
    }

    private fun validateChild(host: LiveHost, target: AgentChatTarget, child: String) {
        if (target.isStarting || target.hostID != host.id || target.muxID != host.muxID || !Regex("^[a-f0-9]{32}$").matches(child))
            throw PhrenKitError.Validation("This child conversation belongs to another computer or is invalid.")
    }

    private fun validMessage(text: String) {
        if (text.isBlank() || text.toByteArray().size > 32_768 || text.any { it.isISOControl() && it != '\n' && it != '\t' })
            throw PhrenKitError.Validation("Enter a message up to 32 KB without terminal control characters.")
    }

    suspend fun resumeChildAgent(host: LiveHost, key: DeviceKey, target: AgentChatTarget, child: String, text: String): AgentFanoutMessage {
        validateChild(host, target, child); validMessage(text)
        return AgentFanoutMessage.receipt(fetchData(host, key, GatewayRequest.resumeChild(target, child, text)))
    }

    /** Archives this chat's finished fan-out workers now instead of after the Hook's daily sweep. */
    suspend fun archiveFinishedChildAgents(host: LiveHost, key: DeviceKey, target: AgentChatTarget): Int {
        sameComputer(host, target, starting = false)
        return archivedCount(fetchData(host, key, GatewayRequest.archiveFinishedChildren(target)))
    }

    fun archivedCount(data: ByteArray): Int = runCatching { hookJson.parseToJsonElement(data.decodeToString()).obj?.get("archived").int }.getOrNull()
        ?: throw PhrenKitError.Validation("The computer returned an invalid archive count.")

    suspend fun childAgentMessages(host: LiveHost, key: DeviceKey, target: AgentChatTarget, child: String): List<AgentFanoutMessage> {
        validateChild(host, target, child)
        val request = GatewayRequest(GatewayRequest.path("/v1/subagents/messages", GatewayRequest.targetQuery(target) + ("child" to child)), maximumResponseBytes = 8_388_608)
        return AgentFanoutMessage.list(fetchData(host, key, request))
    }

    suspend fun childAgentTranscript(host: LiveHost, key: DeviceKey, target: AgentChatTarget, child: String, provider: String): AgentChatTranscript {
        validateChild(host, target, child)
        if (provider !in AgentChatTarget.sources) throw PhrenKitError.Validation("This child conversation is invalid.")
        return AgentChatTranscript.read(fetchData(host, key, GatewayRequest.childTranscript(target, child)), provider, sidechain = true, session = child)
    }

    /** Follows a child agent's transcript through the parent conversation's socket. */
    fun childAgentUpdates(host: LiveHost, key: DeviceKey, target: AgentChatTarget, child: String, provider: String): Flow<AgentChatTranscript> = callbackFlow {
        validateChild(host, target, child)
        if (provider !in AgentChatTarget.sources) throw PhrenKitError.Validation("This child conversation is invalid.")
        fetchData(host, key, GatewayRequest.childTranscriptStream(target, child)) { data ->
            // An older Hook ignores `child` and streams the parent; its frames name the parent and are refused.
            if (trySendBlocking(AgentChatTranscript.read(data, provider, sidechain = true, session = child)).isFailure) throw LiveConnectionError.Oversized()
        }
        close()
        awaitClose()
    }.buffer(8)

    suspend fun childAgentHistory(host: LiveHost, key: DeviceKey, target: AgentChatTarget, child: String, provider: String, beforeLine: Int): AgentChatTranscript {
        validateChild(host, target, child)
        if (beforeLine <= 0 || provider !in AgentChatTarget.sources) throw PhrenKitError.Validation("This history has no earlier destination.")
        val result = AgentChatTranscript.read(fetchData(host, key, GatewayRequest.childHistory(target, child, beforeLine)), provider, sidechain = true, session = child)
        if (result.kind != AgentChatTranscript.Kind.OLDER || result.messages.any { it.line >= beforeLine })
            throw PhrenKitError.Validation("The computer returned a different history range.")
        return result
    }

    /** Exactly one attempt: an interrupted reply must not replay terminal input. */
    suspend fun sendChat(host: LiveHost, key: DeviceKey, target: AgentChatTarget, text: String) {
        sameComputer(host, target)
        validMessage(text)
        confirmChatDelivery(fetchData(host, key, GatewayRequest.prompt(target, text)))
    }

    /** After prompt dispatch: never a validation error that would make the pending prompt safe to replay. */
    fun confirmChatDelivery(data: ByteArray) {
        val result = runCatching { hookJson.parseToJsonElement(data.decodeToString()).obj }.getOrNull()
        if (result == null || result["ok"].bool != true || result["deliveryUncertain"].bool == true) throw LiveConnectionError.DeliveryUnconfirmed()
    }
}
