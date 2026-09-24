package com.phren.android

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.phren.kit.KeyValueStore
import com.phren.kit.KeychainStore
import kotlinx.serialization.json.Json
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** SharedPreferences as PhrenKit's [KeyValueStore] (the UserDefaults twin). */
class PrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putString(key: String, value: String) { prefs.edit().putString(key, value).apply() }
    override fun remove(key: String) { prefs.edit().remove(key).apply() }
    override fun contains(key: String) = prefs.contains(key)

    companion object {
        fun of(context: Context) = PrefsStore(context.getSharedPreferences("phren", Context.MODE_PRIVATE))
    }
}

/**
 * The GitHub token, encrypted with a non-exportable AES-GCM key held in the
 * Android Keystore — the analogue of iOS's
 * `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` Keychain item. The token
 * is excluded from backups (see backup_rules.xml) and never leaves the device.
 */
class KeystoreTokenBackend(context: Context) : KeychainStore.Backend {
    private val prefs = context.getSharedPreferences("phren.secure", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val userManager = context.getSystemService(android.os.UserManager::class.java)

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun existingKey(): SecretKey? = (keyStore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey

    private fun key(): SecretKey {
        existingKey()?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    override fun save(stored: KeychainStore.StoredToken) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.doFinal(json.encodeToString(KeychainStore.StoredToken.serializer(), stored).toByteArray())
        prefs.edit()
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("token", Base64.encodeToString(sealed, Base64.NO_WRAP))
            .commit()
    }

    /**
     * A credential, not user data: an undecodable one is dropped, not quarantined.
     * A Keystore that refuses the read (still locked, or its daemon not up yet)
     * is [KeychainStore.ReadResult.Locked], never "signed out".
     */
    override fun read(): KeychainStore.ReadResult {
        val iv = Base64.decode(prefs.getString("iv", null) ?: return KeychainStore.ReadResult.Missing, Base64.NO_WRAP)
        val sealed = Base64.decode(prefs.getString("token", null) ?: return KeychainStore.ReadResult.Missing, Base64.NO_WRAP)
        if (!userManager.isUserUnlocked) return KeychainStore.ReadResult.Locked
        val key = try {
            existingKey() ?: return KeychainStore.ReadResult.Missing
        } catch (_: Exception) {
            return KeychainStore.ReadResult.Locked
        }
        val plain = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }.doFinal(sealed)
        } catch (_: javax.crypto.AEADBadTagException) {
            return KeychainStore.ReadResult.Missing
        } catch (_: Exception) {
            return KeychainStore.ReadResult.Locked
        }
        return runCatching { json.decodeFromString(KeychainStore.StoredToken.serializer(), plain.decodeToString()) }
            .map { KeychainStore.ReadResult.Found(it) as KeychainStore.ReadResult }
            .getOrDefault(KeychainStore.ReadResult.Missing)
    }

    override fun delete() { prefs.edit().clear().commit() }

    private companion object {
        const val ALIAS = "com.phren.android.github"
    }
}

/** The device name stamped as `machine:` — UIDevice.current.name's analogue. */
fun deviceName(context: Context): String =
    Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
        ?: "${Build.MANUFACTURER} ${Build.MODEL}"
