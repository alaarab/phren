package com.phren.kit.live

import com.phren.kit.LiveHost
import com.phren.kit.parseUUID
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.HexFormat
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class LiveTransportTests {
    // `ssh-keygen -t ed25519` output, its seed read from the private key file.
    private val seed = HexFormat.of().parseHex("45b3f3a9511a7aac09a9102f9b65ca2ace10421a67e3d8b4b505de05772a65d2")

    @Test fun deviceKeyMatchesOpenSSH() {
        val key = DeviceKey(seed)
        assertEquals("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGkwg/YfmIevECMKrqm4XkpMS1cMCJzeFrV6n86pzkcz", key.openSSHPublicKey)
        assertEquals("SHA256:wshNq++1fw7GB8PX4bgo7pIIrcOyrtbZwIIpw1whhGU", DeviceKey.fingerprint(key.openSSHPublicKey))
        assertEquals("restrict,pty,command=\"sh ~/.local/share/phren/bridge/dispatch\" ${key.openSSHPublicKey} phren-android", key.authorizedKey())
        // sshj's own public key encodes to the same blob.
        assertEquals("SHA256:wshNq++1fw7GB8PX4bgo7pIIrcOyrtbZwIIpw1whhGU", DeviceKey.fingerprint(key.keyProvider().public))
    }

    private fun response(raw: String) = ByteArrayInputStream(raw.replace("\n", "\r\n").toByteArray())

    @Test fun requestsCarryTheHookHeadersAndBody() {
        val out = ByteArrayOutputStream()
        HookWire.writeRequest(out, GatewayRequest("/v1/prompt", body = "{\"a\":1}".toByteArray()))
        assertEquals("POST /v1/prompt HTTP/1.1\r\nHost: phren.local\r\nAccept: application/json\r\nConnection: close\r\n" +
            "Content-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}", out.toString())
        val get = ByteArrayOutputStream().also { HookWire.writeRequest(it, GatewayRequest.workspaces) }
        assertTrue(get.toString().startsWith("GET /v1/workspaces?watchApprovals=1 HTTP/1.1\r\n"))
    }

    @Test fun responsesReadLengthChunkedAndToEnd() {
        assertEquals("{\"ok\":true}", HookWire.readResponse(response("HTTP/1.1 200 OK\nContent-Length: 11\n\n{\"ok\":true}"), GatewayRequest.health).decodeToString())
        assertEquals("hello world", HookWire.readResponse(response("HTTP/1.1 200 OK\nTransfer-Encoding: chunked\n\n5\nhello\n6\n world\n0\n\n"), GatewayRequest.health).decodeToString())
        assertEquals("rest", HookWire.readResponse(ByteArrayInputStream("HTTP/1.1 200 OK\r\n\r\nrest".toByteArray()), GatewayRequest.health).decodeToString())
    }

    @Test fun oversizedAndRefusedResponsesMapToTheIPhoneErrors() {
        assertFailsWith<LiveConnectionError.Oversized> {
            HookWire.readResponse(response("HTTP/1.1 200 OK\nContent-Length: 20\n\n"), GatewayRequest("/x", maximumResponseBytes = 10))
        }
        // A refusal's body is capped at 32 KB whatever the route allows.
        assertFailsWith<LiveConnectionError.Oversized> {
            HookWire.readResponse(response("HTTP/1.1 500 Error\nContent-Length: 40000\n\n"), GatewayRequest("/x"))
        }
        val reasonBody = "{\"error\":\"This agent needs\\ninput   first.\"}"
        val refused = assertFailsWith<LiveConnectionError.GatewayRejection> {
            HookWire.readResponse(response("HTTP/1.1 409 Conflict\nContent-Length: ${reasonBody.length}\n\n$reasonBody"), GatewayRequest("/v1/prompt"))
        }
        assertEquals(409, refused.status); assertEquals("This agent needs input first.", refused.reason)
        assertIs<LiveConnectionError.Response>(runCatching { HookWire.readResponse(response("HTTP/1.1 302 Found\n\n"), GatewayRequest("/x")) }.exceptionOrNull())
        val body = "{\"error\":\"A conductor is already running for this store.\",\"target\":{\"workspace\":\"w3\",\"tab\":\"w3:t1\",\"pane\":\"w3:p1\",\"source\":\"claude\"}}"
        val conflict = assertFailsWith<LiveConnectionError.LaunchConflict> {
            HookWire.readResponse(response("HTTP/1.1 409 Conflict\nContent-Length: ${body.length}\n\n$body"), GatewayRequest("/v1/workspaces/launch"))
        }
        assertEquals(LiveLaunchConflictTarget(null, "w3", "w3:t1", "w3:p1", "claude"), conflict.target)
    }

    @Test fun webSocketFramesRoundTripMaskedAndLong() {
        val out = ByteArrayOutputStream()
        val long = ByteArray(70_000) { (it % 97).toByte() }
        HookWire.writeFrame(out, HookWire.Opcode.TEXT, "hi".toByteArray())
        HookWire.writeFrame(out, HookWire.Opcode.BINARY, long)
        val input = ByteArrayInputStream(out.toByteArray())
        val first = HookWire.readFrame(input, 8_388_608)
        assertTrue(first.fin); assertEquals(1, first.opcode); assertEquals("hi", first.payload.decodeToString())
        val second = HookWire.readFrame(input, 8_388_608)
        assertContentEquals(long, second.payload)
        // Client frames carry the mask bit.
        assertEquals(0x80, out.toByteArray()[1].toInt() and 0x80)
        assertFailsWith<LiveConnectionError.Oversized> { HookWire.readFrame(ByteArrayInputStream(out.toByteArray()), 1) }
    }

    @Test fun workspaceRoutesNameTheConnectionsHerdrServer() {
        val host = LiveHost(name = "Mini", address = "mini", username = "sam", herdrSession = "work")
        assertEquals("/v1/workspaces?watchApprovals=1&mux=herdr:work", GatewayRequest.workspaces.scoped(host).path)
        assertEquals("/v1/overview?watchApprovals=1&mux=herdr:work", GatewayRequest.overview.scoped(host).path)
        assertEquals("/v1/health", GatewayRequest.health.scoped(host).path)
        assertEquals("/v1/workspaces/panes?childId=w1:t1&groupId=w1&mux=herdr:work", GatewayRequest.panes("w1", "w1:t1").scoped(host).path)
    }

    /**
     * Against a real computer: PHREN_LIVE_HOST=user@host[:port], PHREN_LIVE_FINGERPRINT=SHA256:…,
     * PHREN_LIVE_SEED=<hex> whose `authorizedKey()` line is in that user's authorized_keys.
     */
    @Test fun liveComputerAnswersHealthAndWorkspaces() {
        val spec = System.getenv("PHREN_LIVE_HOST") ?: return
        val user = spec.substringBefore('@'); val rest = spec.substringAfter('@')
        val host = LiveHost(name = "Live test", address = rest.substringBefore(':'), port = rest.substringAfter(':', "22").toInt(),
            username = user, fingerprint = System.getenv("PHREN_LIVE_FINGERPRINT"))
        val key = DeviceKey(HexFormat.of().parseHex(System.getenv("PHREN_LIVE_SEED")))
        runBlocking {
            val identity = assertNotNull(PhrenConnection.computerIdentity(host, key))
            assertNotNull(parseUUID(identity.id.toString()))
            val before = GatewayConnections.opened
            PhrenConnection.fetch(host, key)
            assertEquals(before, GatewayConnections.opened, "The second request reuses the pooled connection")
            // The pushed overview arrives over the WebSocket; cancelling ends the stream.
            val first = kotlinx.coroutines.withTimeout(15_000) {
                kotlinx.coroutines.suspendCancellableCoroutine { done ->
                    val job = kotlinx.coroutines.GlobalScope.launch {
                        runCatching { PhrenConnection.fetchData(host, key, GatewayRequest.overview) { if (done.isActive) done.resumeWith(Result.success(it)) } }
                    }
                    done.invokeOnCancellation { job.cancel() }
                }
            }
            assertTrue(first.decodeToString().startsWith("{"))
            // An unpinned computer names what it offered; a different key stops the connection.
            val unknown = assertFailsWith<LiveConnectionError.UntrustedHost> { PhrenConnection.fetchData(host.copy(id = java.util.UUID.randomUUID(), fingerprint = null), key) }
            assertEquals(host.fingerprint, unknown.fingerprint)
            assertFailsWith<LiveConnectionError.ChangedHost> {
                PhrenConnection.fetchData(host.copy(id = java.util.UUID.randomUUID(), fingerprint = "SHA256:" + "A".repeat(43)), key)
            }
            assertFailsWith<LiveConnectionError.Authentication> { PhrenConnection.fetchData(host.copy(id = java.util.UUID.randomUUID()), DeviceKey.generate()) }
        }
    }
}
