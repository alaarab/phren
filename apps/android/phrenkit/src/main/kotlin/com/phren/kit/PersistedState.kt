package com.phren.kit

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * A value this app writes to the device and must still be able to read after
 * an update (port of PersistedState.swift's `VersionedDocument`). The rules are
 * the iOS ones: additive only; bump [schemaVersion] only for a genuine break;
 * a document with no `schemaVersion` is version 1; anything unreadable is
 * quarantined, never dropped.
 */
interface VersionedDocument {
    val schemaVersion: Int
}

/**
 * Something went wrong with on-device persistence that the user is entitled
 * to hear about, because it touched data only their phone had. Recorded and
 * shown, never thrown.
 */
data class StorageIssue(
    val id: String = UUID.randomUUID().toString(),
    val kind: Kind,
    /** What the document holds, in the user's words, plural ("unsynced changes"). */
    val document: String,
    val location: String,
    val quarantineLocation: String?,
    val foundSchemaVersion: Int?,
    val expectedSchemaVersion: Int,
    val detail: String?,
    val at: Instant = Instant.now(),
) {
    enum class Kind { UNREADABLE, FUTURE_SCHEMA, UNWRITABLE }

    val userMessage: String
        get() = when (kind) {
            Kind.UNREADABLE -> if (quarantineLocation == null)
                "Some $document couldn't be read after the update, and Phren couldn't set them aside."
            else "Some $document couldn't be read after the update and were set aside — they're saved in the app's data folder."
            Kind.FUTURE_SCHEMA -> if (quarantineLocation == null)
                "Some $document were written by a newer version of Phren and couldn't be read."
            else "Some $document were written by a newer version of Phren and were set aside — they're saved in the app's data folder, and updating Phren will make them readable again."
            Kind.UNWRITABLE -> "Phren couldn't save your $document on this device, so they may not survive closing the app."
        }
}

/** Process-wide sink for [StorageIssue]s, drained by the app model. */
class StorageIssueLog {
    private val stored = ArrayDeque<StorageIssue>()

    val issues: List<StorageIssue> get() = synchronized(stored) { stored.toList() }

    fun record(issue: StorageIssue) = synchronized(stored) {
        stored.addLast(issue)
        while (stored.size > LIMIT) stored.removeFirst()
    }

    fun removeAll() = synchronized(stored) { stored.clear() }

    companion object {
        private const val LIMIT = 32
        val shared = StorageIssueLog()
    }
}

/**
 * Small key/value preferences surface (the UserDefaults twin): SharedPreferences
 * in the app, an in-memory map in tests.
 */
interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
    fun remove(key: String)
    fun contains(key: String): Boolean = getString(key) != null
}

class MemoryKeyValueStore : KeyValueStore {
    private val map = mutableMapOf<String, String>()
    override fun getString(key: String) = synchronized(map) { map[key] }
    override fun putString(key: String, value: String) { synchronized(map) { map[key] = value } }
    override fun remove(key: String) { synchronized(map) { map.remove(key) } }
}

internal val persistJson = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

/**
 * Reads and writes [VersionedDocument]s, quarantining anything it cannot read
 * instead of starting empty over the top of it.
 */
object PersistedState {
    data class LoadResult<T>(val value: T?, val issue: StorageIssue?)

    fun <T : VersionedDocument> load(serializer: KSerializer<T>, currentVersion: Int, file: File, document: String): LoadResult<T> {
        val data = try {
            if (!file.exists()) return LoadResult(null, null)
            file.readText()
        } catch (_: Exception) {
            return LoadResult(null, null)
        }
        return decode(serializer, currentVersion, data, document, file.path) { quarantineFile(file, data) }
    }

    fun <T : VersionedDocument> save(serializer: KSerializer<T>, currentVersion: Int, value: T, file: File, document: String): StorageIssue? = try {
        val text = persistJson.encodeToString(serializer, value)
        file.parentFile?.mkdirs()
        atomicWrite(file, text)
        null
    } catch (e: Exception) {
        report(StorageIssue.Kind.UNWRITABLE, document, file.path, null, null, currentVersion, e.toString())
    }

    fun <T : VersionedDocument> load(serializer: KSerializer<T>, currentVersion: Int, defaults: KeyValueStore, key: String, document: String): LoadResult<T> {
        val data = defaults.getString(key) ?: return LoadResult(null, null)
        return decode(serializer, currentVersion, data, document, location(key)) { quarantineDefaults(data, defaults, key) }
    }

    fun <T : VersionedDocument> save(serializer: KSerializer<T>, currentVersion: Int, value: T, defaults: KeyValueStore, key: String, document: String): StorageIssue? = try {
        defaults.putString(key, persistJson.encodeToString(serializer, value))
        null
    } catch (e: Exception) {
        report(StorageIssue.Kind.UNWRITABLE, document, location(key), null, null, currentVersion, e.toString())
    }

    private fun <T> decode(
        serializer: KSerializer<T>,
        currentVersion: Int,
        data: String,
        document: String,
        location: String,
        quarantine: () -> String?,
    ): LoadResult<T> {
        // Version first, so a document from a newer build is recognized as
        // such rather than reported as corrupt.
        val found = try {
            ((persistJson.parseToJsonElement(data) as? JsonObject)?.get("schemaVersion") as? JsonPrimitive)?.intOrNull
        } catch (_: Exception) {
            null
        }
        if (found != null && found > currentVersion) {
            val moved = quarantine()
            return LoadResult(null, report(StorageIssue.Kind.FUTURE_SCHEMA, document, location, moved, found, currentVersion, null))
        }
        return try {
            LoadResult(persistJson.decodeFromString(serializer, data), null)
        } catch (e: Exception) {
            val moved = quarantine()
            LoadResult(null, report(StorageIssue.Kind.UNREADABLE, document, location, moved, found, currentVersion, e.toString()))
        }
    }

    /** Moves an unreadable file aside as `<name>.corrupt-<stamp>.<ext>`. Never deletes. */
    internal fun quarantineFile(file: File, data: String): String? {
        val destination = quarantineFileFor(file)
        if (file.renameTo(destination)) return destination.path
        return try {
            destination.writeText(data)
            file.delete()
            destination.path
        } catch (_: Exception) {
            null
        }
    }

    internal fun quarantineDefaults(data: String, defaults: KeyValueStore, key: String): String {
        var candidate = "$key.corrupt-${timestamp()}"
        var attempt = 1
        while (defaults.contains(candidate) && attempt < 1000) {
            candidate = "$key.corrupt-${timestamp()}-$attempt"
            attempt++
        }
        defaults.putString(candidate, data)
        defaults.remove(key)
        return location(candidate)
    }

    private fun quarantineFileFor(file: File): File {
        val base = file.nameWithoutExtension
        val ext = file.extension
        val stamp = timestamp()
        fun candidate(suffix: String) = File(file.parentFile, "$base.corrupt-$stamp$suffix" + if (ext.isNotEmpty()) ".$ext" else "")
        for (attempt in 0 until 1000) {
            val c = candidate(if (attempt == 0) "" else "-$attempt")
            if (!c.exists()) return c
        }
        return candidate("-${UUID.randomUUID()}")
    }

    private val stampFormatter = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)
    private fun timestamp() = stampFormatter.format(Instant.now())
    private fun location(key: String) = "SharedPreferences:$key"

    private fun report(kind: StorageIssue.Kind, document: String, location: String, quarantineLocation: String?, found: Int?, expected: Int, detail: String?): StorageIssue {
        val issue = StorageIssue(
            kind = kind, document = document, location = location, quarantineLocation = quarantineLocation,
            foundSchemaVersion = found, expectedSchemaVersion = expected, detail = detail,
        )
        StorageIssueLog.shared.record(issue)
        return issue
    }
}

/** Write-then-rename, the `.atomic` of Data.write. */
fun atomicWrite(file: File, text: String) {
    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.tmp")
    tmp.writeText(text)
    if (!tmp.renameTo(file)) {
        file.delete()
        if (!tmp.renameTo(file)) {
            tmp.delete()
            throw java.io.IOException("Could not write ${file.path}")
        }
    }
}

/**
 * A versioned envelope around a list whose version-1 on-disk shape is a bare
 * JSON array (VersionedList.swift): decodes the bare array as version 1 and
 * writes the envelope from then on.
 */
data class VersionedList<E>(val items: List<E>, override val schemaVersion: Int = CURRENT) : VersionedDocument {
    companion object {
        const val CURRENT = 1

        fun <E> serializer(element: KSerializer<E>): KSerializer<VersionedList<E>> = VersionedListSerializer(element)
    }
}

@Serializable
private data class ListEnvelope(val schemaVersion: Int = 1, val items: kotlinx.serialization.json.JsonArray)

private class VersionedListSerializer<E>(private val element: KSerializer<E>) : KSerializer<VersionedList<E>> {
    private val list = ListSerializer(element)
    override val descriptor = ListEnvelope.serializer().descriptor

    override fun serialize(encoder: kotlinx.serialization.encoding.Encoder, value: VersionedList<E>) {
        val json = encoder as kotlinx.serialization.json.JsonEncoder
        val items = json.json.encodeToJsonElement(list, value.items) as JsonArray
        json.encodeJsonElement(JsonObject(mapOf("schemaVersion" to JsonPrimitive(value.schemaVersion), "items" to items)))
    }

    override fun deserialize(decoder: kotlinx.serialization.encoding.Decoder): VersionedList<E> {
        val json = decoder as kotlinx.serialization.json.JsonDecoder
        return when (val el = json.decodeJsonElement()) {
            is JsonArray -> VersionedList(json.json.decodeFromJsonElement(list, el), 1)
            is JsonObject -> {
                val v = (el["schemaVersion"] as? JsonPrimitive)?.intOrNull ?: 1
                val items = el["items"] ?: throw kotlinx.serialization.SerializationException("missing items")
                VersionedList(json.json.decodeFromJsonElement(list, items), v)
            }
            else -> throw kotlinx.serialization.SerializationException("unexpected list shape")
        }
    }
}

/**
 * The app's registry entry for one store: a GitHub repo the user added
 * (StoreDescriptor.swift). Not the CLI's `stores.yaml` schema.
 */
@Serializable
data class StoreDescriptor(
    override val schemaVersion: Int = CURRENT_SCHEMA_VERSION,
    val owner: String,
    val name: String,
    val branch: String,
    /** Whether the token has push permission; false renders the store read-only. */
    val canPush: Boolean = true,
) : VersionedDocument {
    val id: String get() = "$owner/$name"
    val displayName: String get() = name

    companion object {
        const val CURRENT_SCHEMA_VERSION = 1
        fun of(owner: String, name: String, branch: String, canPush: Boolean = true) =
            StoreDescriptor(CURRENT_SCHEMA_VERSION, owner, name, branch, canPush)
    }
}
