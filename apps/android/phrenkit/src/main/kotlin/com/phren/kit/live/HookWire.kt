package com.phren.kit.live

import com.phren.kit.AgentChatTarget
import com.phren.kit.hookJson
import com.phren.kit.obj
import com.phren.kit.str
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.security.SecureRandom
import java.util.Base64

/**
 * HTTP/1.1 and WebSocket client framing over the `phren-hook v1 pipe` exec
 * channel's streams: the SSHHTTPBytes / GatewayResponse / TranscriptFrames
 * handlers of PhrenConnection.swift, without an event loop.
 */
internal object HookWire {
    const val UPLOAD_CHUNK_BYTES = 16_384

    fun writeRequest(out: OutputStream, request: GatewayRequest) {
        val head = StringBuilder("${request.httpMethod} ${request.path} HTTP/1.1\r\n")
            .append("Host: phren.local\r\nAccept: application/json\r\nConnection: close\r\n")
        request.body?.let { head.append("Content-Type: application/json\r\nContent-Length: ${it.size}\r\n") }
        out.write(head.append("\r\n").toString().toByteArray())
        request.body?.let { body ->
            var offset = 0
            while (offset < body.size) {
                val end = minOf(offset + UPLOAD_CHUNK_BYTES, body.size)
                out.write(body, offset, end - offset); out.flush()
                offset = end
            }
        }
        out.flush()
    }

    class Head(val status: Int, val headers: Map<String, String>)

    fun readHead(input: InputStream): Head {
        val statusLine = readLine(input) ?: throw LiveConnectionError.Disconnected()
        val status = statusLine.split(' ').getOrNull(1)?.toIntOrNull() ?: throw LiveConnectionError.Disconnected()
        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = readLine(input) ?: throw LiveConnectionError.Disconnected()
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
            if (headers.size > 100) throw LiveConnectionError.Oversized()
        }
        return Head(status, headers)
    }

    /** The response body of a `Connection: close` exchange, bounded, then the Hook's refusal mapped as the iPhone maps it. */
    fun readResponse(input: InputStream, request: GatewayRequest): ByteArray {
        val head = readHead(input)
        if (head.status != 200 && head.status !in 400..599) throw LiveConnectionError.Response(head.status)
        val limit = if (head.status == 200) request.maximumResponseBytes else minOf(request.maximumResponseBytes, 32_768)
        head.headers["content-length"]?.toIntOrNull()?.let { if (it > limit) throw LiveConnectionError.Oversized() }
        val body = when {
            head.headers["transfer-encoding"]?.lowercase()?.contains("chunked") == true -> readChunked(input, limit)
            head.headers["content-length"] != null -> readExactly(input, head.headers["content-length"]!!.toInt())
            else -> readToEnd(input, limit)
        }
        if (head.status == 200) return body
        throw rejection(head.status, body, request.path)
    }

    fun rejection(status: Int, body: ByteArray, path: String): LiveConnectionError {
        val obj = runCatching { hookJson.parseToJsonElement(body.decodeToString()).obj }.getOrNull()
        val reason = obj?.get("error").str?.let { raw ->
            raw.filter { !it.isISOControl() || it.isWhitespace() }.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ").take(320)
        }
        // Only a refusal naming the running conductor is a launch conflict; any other 409 keeps the Hook's own reason.
        if (status == 409 && path == "/v1/workspaces/launch" && (obj?.get("target") != null || reason?.contains("conductor is already running") == true)) {
            return LiveConnectionError.LaunchConflict(if (reason.isNullOrEmpty()) "A conductor is already running for this store." else reason, launchConflictTarget(obj?.get("target").obj))
        }
        return if (!reason.isNullOrEmpty()) LiveConnectionError.GatewayRejection(status, reason) else LiveConnectionError.Response(status)
    }

    private fun launchConflictTarget(value: kotlinx.serialization.json.JsonObject?): LiveLaunchConflictTarget? {
        value ?: return null
        val workspace = (value["workspace"] ?: value["workspaceId"]).str ?: return null
        val tab = (value["tab"] ?: value["tabId"]).str ?: return null
        if (!AgentChatTarget.validID(workspace) || !AgentChatTarget.validID(tab)) return null
        val pane = (value["pane"] ?: value["paneId"]).str?.takeIf { AgentChatTarget.validID(it) }
        val server = value["server"].str?.takeIf { AgentChatTarget.validID(it) && !it.contains(":") }
        val source = value["source"].str?.takeIf { it in AgentChatTarget.sources }
        return LiveLaunchConflictTarget(server, workspace, tab, pane, source)
    }

    private fun readLine(input: InputStream): String? {
        val bytes = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (bytes.size() == 0) null else bytes.toString(Charsets.ISO_8859_1)
            if (b == '\n'.code) break
            if (b != '\r'.code) bytes.write(b)
            if (bytes.size() > 16_384) throw LiveConnectionError.Oversized()
        }
        return bytes.toString(Charsets.ISO_8859_1)
    }

    fun readExactly(input: InputStream, count: Int): ByteArray {
        val out = ByteArray(count)
        var read = 0
        while (read < count) {
            val n = input.read(out, read, count - read)
            if (n < 0) throw LiveConnectionError.Disconnected()
            read += n
        }
        return out
    }

    private fun readToEnd(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16_384)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) return out.toByteArray()
            if (out.size() + n > limit) throw LiveConnectionError.Oversized()
            out.write(buffer, 0, n)
        }
    }

    private fun readChunked(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val size = readLine(input)?.substringBefore(';')?.trim()?.toIntOrNull(16) ?: throw LiveConnectionError.Disconnected()
            if (size == 0) { while (readLine(input)?.isNotEmpty() == true) Unit; return out.toByteArray() }
            if (out.size() + size > limit) throw LiveConnectionError.Oversized()
            out.write(readExactly(input, size))
            readLine(input)
        }
    }

    // WebSocket (RFC 6455), client side: every frame we send is masked.

    private val random = SecureRandom()

    fun writeUpgrade(out: OutputStream, path: String) {
        val key = Base64.getEncoder().encodeToString(ByteArray(16).also(random::nextBytes))
        out.write(("GET $path HTTP/1.1\r\nHost: phren.local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n\r\n").toByteArray())
        out.flush()
    }

    /** The upgrade reply; any other status ends the exchange with that status. */
    fun readUpgrade(input: InputStream) {
        val head = readHead(input)
        if (head.status != 101) throw LiveConnectionError.Response(head.status)
    }

    enum class Opcode(val code: Int) { CONTINUATION(0), TEXT(1), BINARY(2), CLOSE(8), PING(9), PONG(10) }
    class Frame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

    fun writeFrame(out: OutputStream, opcode: Opcode, payload: ByteArray) {
        val header = ByteArrayOutputStream()
        header.write(0x80 or opcode.code)
        when {
            payload.size < 126 -> header.write(0x80 or payload.size)
            payload.size < 65_536 -> { header.write(0x80 or 126); header.write(payload.size shr 8); header.write(payload.size and 0xff) }
            else -> { header.write(0x80 or 127); for (shift in 56 downTo 0 step 8) header.write(((payload.size.toLong() shr shift) and 0xff).toInt()) }
        }
        val mask = ByteArray(4).also(random::nextBytes)
        header.write(mask)
        val masked = ByteArray(payload.size) { (payload[it].toInt() xor mask[it % 4].toInt()).toByte() }
        synchronized(out) { out.write(header.toByteArray()); out.write(masked); out.flush() }
    }

    fun readFrame(input: InputStream, maximum: Int): Frame {
        val first = input.read(); val second = input.read()
        if (first < 0 || second < 0) throw EOFException()
        var length = (second and 0x7f).toLong()
        if (length == 126L) length = ((input.read() shl 8) or input.read()).toLong()
        else if (length == 127L) { length = 0; repeat(8) { length = (length shl 8) or input.read().toLong() } }
        if (length < 0 || length > maximum) throw LiveConnectionError.Oversized()
        val mask = if (second and 0x80 != 0) readExactly(input, 4) else null
        val payload = readExactly(input, length.toInt())
        if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
        return Frame(first and 0x80 != 0, first and 0x0f, payload)
    }
}
