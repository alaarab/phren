package com.phren.android.live

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.phren.kit.LiveHost
import com.phren.kit.LiveSessionPreferences
import com.phren.kit.PhrenKitError
import com.phren.kit.live.DeviceKey
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.KeyStore
import java.security.Security
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android ships a trimmed "BC" provider without Ed25519 or the ciphers sshj
 * negotiates; replace it with the full Bouncy Castle once, before any SSH.
 */
object LiveCrypto {
    @Volatile private var installed = false
    fun install() {
        if (installed) return
        synchronized(this) {
            if (installed) return
            Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
            Security.insertProviderAt(BouncyCastleProvider(), 1)
            installed = true
        }
    }
}

/**
 * The one reader of `sessions.live.preferences.v1` (LiveSessionPreferencesStore):
 * saved computers, directory links and pins, decoded once per change of the
 * stored document. [preferences] is null when the stored document can't be read.
 */
class LivePreferencesStore(private val prefs: SharedPreferences) {
    var data by mutableStateOf(prefs.getString(KEY, null) ?: "")
        private set
    var preferences by mutableStateOf<LiveSessionPreferences?>(null)
        private set
    var readError by mutableStateOf<String?>(null)
        private set

    val hosts: List<LiveHost> get() = preferences?.hosts ?: emptyList()

    init { decode(data) }

    /** Applies one of LiveSessionPreferences' editing functions; a throw leaves everything unchanged. */
    fun update(transform: (String) -> String) = write(transform(data))

    fun write(newData: String) {
        if (newData == data) return
        decode(newData)
        data = newData
        prefs.edit().putString(KEY, newData).apply()
    }

    private fun decode(value: String) {
        try { preferences = LiveSessionPreferences.read(value); readError = null }
        catch (error: Exception) { preferences = null; readError = error.message }
    }

    companion object {
        const val KEY = "sessions.live.preferences.v1"
        fun of(context: Context) = LivePreferencesStore(context.getSharedPreferences("phren", Context.MODE_PRIVATE))
    }
}

/**
 * A separate SSH key per computer (DeviceSSHKey.swift). The 32-byte Ed25519
 * seed is sealed with a non-exportable Keystore AES key; it never enters
 * preferences in the clear, logs, Git or backups (backup_rules.xml).
 */
class DeviceKeyStore(context: Context) {
    private val prefs = context.getSharedPreferences("phren.ssh", Context.MODE_PRIVATE)

    private fun wrappingKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return generator.generateKey()
    }

    /** This computer's key; throws when there is none (the connection must be set up again). */
    fun load(hostID: UUID): DeviceKey {
        val sealed = prefs.getString(hostID.toString(), null)
            ?: throw PhrenKitError.Validation("This device's SSH key is unavailable. Open connection settings to create a new key if needed.")
        return try {
            val bytes = Base64.decode(sealed, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, bytes, 0, 12)) }
            DeviceKey(cipher.doFinal(bytes, 12, bytes.size - 12))
        } catch (error: Exception) {
            throw PhrenKitError.Validation("Could not read the SSH key (${error.javaClass.simpleName}).")
        }
    }

    /** The existing key, or a new one saved first. */
    fun loadOrCreate(hostID: UUID): DeviceKey {
        if (prefs.contains(hostID.toString())) return load(hostID)
        val key = DeviceKey.generate()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, wrappingKey()) }
        val sealed = cipher.iv + cipher.doFinal(key.seed)
        if (!prefs.edit().putString(hostID.toString(), Base64.encodeToString(sealed, Base64.NO_WRAP)).commit())
            throw PhrenKitError.Validation("Could not save the SSH key.")
        return key
    }

    /** The restricted authorized_keys line for this computer's key, creating the key if needed. */
    fun authorizedKey(hostID: UUID): String = loadOrCreate(hostID).authorizedKey()

    fun delete(hostID: UUID) { prefs.edit().remove(hostID.toString()).commit() }

    private companion object { const val ALIAS = "com.phren.android.ssh" }
}
