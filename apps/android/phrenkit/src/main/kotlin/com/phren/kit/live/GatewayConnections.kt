package com.phren.kit.live

import com.phren.kit.LiveHost
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.Ed25519KeyFactory
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.TransportException
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.UserAuthException
import net.schmizz.sshj.userauth.keyprovider.KeyPairWrapper
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.PublicKey
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** The device's Ed25519 identity for one computer (DeviceSSHKey.swift), from its 32-byte seed. */
class DeviceKey(val seed: ByteArray) {
    init { require(seed.size == 32) { "An Ed25519 seed is 32 bytes." } }
    val publicRaw: ByteArray = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded

    /** `ssh-ed25519 <base64 blob>`: the OpenSSH public key line. */
    val openSSHPublicKey: String get() = "ssh-ed25519 " + Base64.getEncoder().encodeToString(sshBlob(publicRaw))

    /** The restricted line the computer's authorized_keys gets: only the dispatcher runs. */
    fun authorizedKey(comment: String = "phren-android") =
        "restrict,pty,command=\"sh ~/.local/share/phren/bridge/dispatch\" $openSSHPublicKey $comment"

    internal fun keyProvider() = KeyPairWrapper(Ed25519KeyFactory.getPublicKey(publicRaw), Ed25519KeyFactory.getPrivateKey(seed))

    companion object {
        fun generate(): DeviceKey = DeviceKey(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) })

        private fun sshBlob(raw: ByteArray): ByteArray {
            val type = "ssh-ed25519".toByteArray()
            return java.nio.ByteBuffer.allocate(8 + type.size + raw.size).putInt(type.size).put(type).putInt(raw.size).put(raw).array()
        }

        /** "SHA256:" + unpadded base64 of the key blob, as `ssh-keygen -l` prints it (PhrenConnection.fingerprint). */
        fun fingerprint(blob: ByteArray): String =
            "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(blob))

        fun fingerprint(publicKeyLine: String): String? {
            val fields = publicKeyLine.split(' ')
            if (fields.size < 2) return null
            return runCatching { fingerprint(Base64.getDecoder().decode(fields[1])) }.getOrNull()
        }

        fun fingerprint(key: PublicKey): String = fingerprint(Buffer.PlainBuffer().putPublicKey(key).compactData)
    }
}

/**
 * One authenticated SSH connection per computer, shared by every request
 * (GatewayConnections.swift). Each request is one session channel; sshd allows
 * ten per connection, so past eight open channels a request gets a dedicated
 * connection. An idle connection closes after 90 s; one a request found broken
 * is retired: it takes no new channels and closes when its last one finishes.
 */
object GatewayConnections {
    const val MAXIMUM_CHILDREN = 8
    const val IDLE_SECONDS = 90L
    const val DRAIN_SECONDS = 65L

    class Connection internal constructor(val client: SSHClient, val pooled: Boolean, internal val poolKey: String) {
        internal var children = 0
        internal var retired = false
        internal var idle: ScheduledFuture<*>? = null
        val isActive: Boolean get() = client.isConnected && client.isAuthenticated
    }

    private val lock = Any()
    private val ready = mutableMapOf<String, Connection>()
    private val connecting = mutableMapOf<String, Any>()
    private val timers = Executors.newSingleThreadScheduledExecutor { Thread(it, "phren-ssh-idle").apply { isDaemon = true } }
    /** How many connections were opened; tests read it to prove reuse. */
    @Volatile var opened = 0; private set

    fun poolKey(host: LiveHost, key: DeviceKey): String {
        val device = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(key.publicRaw))
        return listOf(host.id.toString().uppercase(), host.address, host.port.toString(), host.username, host.fingerprint ?: "", device).joinToString("|")
    }

    /** An open connection with room for one more channel, or a new one. The caller owns one slot until [release]. Blocking. */
    fun connection(host: LiveHost, key: DeviceKey): Connection {
        val poolKey = poolKey(host, key)
        // One dial per computer at a time; the others wait for it and share it.
        val gate = synchronized(lock) { connecting.getOrPut(poolKey) { Any() } }
        synchronized(gate) {
            synchronized(lock) { ready[poolKey]?.let { if (reserve(it)) return it } }
            val fresh = connect(host, key, pooled = true, poolKey)
            synchronized(lock) {
                if (fresh.isActive) ready[poolKey] = fresh
                if (reserve(fresh)) return fresh
            }
        }
        // The shared connection filled up: a dedicated one for this request.
        val dedicated = connect(host, key, pooled = false, poolKey)
        synchronized(lock) { reserve(dedicated) }
        return dedicated
    }

    private fun reserve(connection: Connection): Boolean {
        if (!connection.isActive || connection.retired || connection.children >= MAXIMUM_CHILDREN) return false
        connection.children++
        connection.idle?.cancel(false); connection.idle = null
        return true
    }

    /** Gives the slot back. A dedicated connection closes with its only channel; a pooled one waits idle. */
    fun release(connection: Connection, healthy: Boolean) = synchronized(lock) {
        connection.children = maxOf(0, connection.children - 1)
        if (!healthy && !connection.retired) {
            connection.retired = true
            remove(connection)
            connection.idle?.cancel(false)
            connection.idle = timers.schedule({ close(connection) }, DRAIN_SECONDS, TimeUnit.SECONDS)
        }
        if (!connection.pooled || connection.retired) {
            if (connection.children == 0) { connection.idle?.cancel(false); connection.idle = null; remove(connection); close(connection) }
            return@synchronized
        }
        if (connection.children != 0) return@synchronized
        connection.idle?.cancel(false)
        connection.idle = timers.schedule({
            synchronized(lock) { if (connection.children == 0) { remove(connection); close(connection) } }
        }, IDLE_SECONDS, TimeUnit.SECONDS)
    }

    /** Drops everything: the app's reconnect and tests. */
    fun reset() {
        val all = synchronized(lock) { ready.values.toList().also { ready.clear() } }
        all.forEach(::close)
    }

    private fun remove(connection: Connection) { if (ready[connection.poolKey] === connection) ready.remove(connection.poolKey) }
    private fun close(connection: Connection) { runCatching { connection.client.disconnect() } }

    /** Records what the host offered, so a refusal can say whether it was unknown or changed. */
    private class PinnedHost(val fingerprint: String?) : HostKeyVerifier {
        @Volatile var failure: LiveConnectionError? = null
        override fun verify(hostname: String?, port: Int, key: PublicKey): Boolean {
            val received = runCatching { DeviceKey.fingerprint(key) }.getOrNull()
            failure = when {
                received == null -> LiveConnectionError.ChangedHost()
                fingerprint == null -> LiveConnectionError.UntrustedHost(received)
                fingerprint != received -> LiveConnectionError.ChangedHost()
                else -> null
            }
            return failure == null
        }
        override fun findExistingAlgorithms(hostname: String?, port: Int): List<String> = emptyList()
    }

    private val config by lazy { DefaultConfig() }

    private fun connect(host: LiveHost, key: DeviceKey, pooled: Boolean, poolKey: String): Connection {
        host.validate()
        val client = SSHClient(config)
        val verifier = PinnedHost(host.fingerprint)
        client.addHostKeyVerifier(verifier)
        client.connectTimeout = 10_000
        client.connection.keepAlive.keepAliveInterval = 30
        try {
            client.connect(host.address, host.port)
            client.auth(host.username, net.schmizz.sshj.userauth.method.AuthPublickey(key.keyProvider()))
        } catch (error: Exception) {
            runCatching { client.disconnect() }
            throw verifier.failure ?: when (error) {
                is UserAuthException -> LiveConnectionError.Authentication()
                is SocketTimeoutException -> LiveConnectionError.Timeout()
                is TransportException -> LiveConnectionError.Ssh("The SSH exchange failed (${error.message}). Reconnect to the computer and try again.")
                is java.io.IOException -> LiveConnectionError.Ssh("Could not reach the computer (${error.message}). Check Tailscale and SSH.")
                else -> error
            }
        }
        synchronized(lock) { opened++ }
        return Connection(client, pooled, poolKey)
    }

    /** The restricted helper command; everything else is the Hook's HTTP. */
    internal fun openPipe(connection: Connection): Pair<Session, Session.Command> {
        val session = try { connection.client.startSession() } catch (error: Exception) {
            throw LiveConnectionError.Ssh("The computer refused the SSH channel (${error.message}). Check Phren Hook and available SSH sessions.")
        }
        return try { session to session.exec("phren-hook v1 pipe") } catch (error: Exception) {
            runCatching { session.close() }
            throw LiveConnectionError.Disconnected()
        }
    }
}
