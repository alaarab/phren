package com.phren.kit

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.util.UUID

/*
 * The Swift session code reads the Hook's JSON through JSONSerialization's
 * untyped dictionaries (`raw["line"] as? Int`). These accessors keep the same
 * type rules: a string is never a number, a boolean is never a number, and a
 * number is an Int only when it is exactly integral.
 */

internal val hookJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

val JsonElement?.obj: JsonObject? get() = this as? JsonObject
val JsonElement?.arr: JsonArray? get() = this as? JsonArray
val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
val JsonElement?.isNumber: Boolean get() = (this as? JsonPrimitive)?.let { !it.isString && it !is JsonNull && it.booleanOrNull == null && it.doubleOrNull != null } ?: false
val JsonElement?.double: Double? get() = if (isNumber) (this as JsonPrimitive).doubleOrNull else null
val JsonElement?.int: Int? get() {
    if (!isNumber) return null
    val p = this as JsonPrimitive
    p.longOrNull?.let { return if (it in Int.MIN_VALUE..Int.MAX_VALUE) it.toInt() else null }
    val d = p.doubleOrNull ?: return null
    return if (d.isFinite() && d == Math.floor(d) && d in Int.MIN_VALUE.toDouble()..Int.MAX_VALUE.toDouble()) d.toInt() else null
}
val JsonElement?.objects: List<JsonObject>? get() = (this as? JsonArray)?.let { a -> if (a.all { it is JsonObject }) a.map { it as JsonObject } else null }
val JsonElement?.strings: List<String>? get() = (this as? JsonArray)?.let { a -> a.map { it.str ?: return null } }

fun JsonObject.has(key: String) = containsKey(key)

/** `try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]`. */
fun parseObject(text: String?): JsonObject? = text?.let { runCatching { hookJson.parseToJsonElement(it) }.getOrNull() }.obj

/** Pretty-printed, sorted keys: `JSONSerialization.data(withJSONObject:options:[.prettyPrinted, .sortedKeys])`. */
fun prettyJson(value: JsonElement): String = AppleJson.pretty(sortKeys(value))

internal fun sortKeys(e: JsonElement): JsonElement = when (e) {
    is JsonObject -> JsonObject(e.toSortedMap().mapValues { sortKeys(it.value) })
    is JsonArray -> JsonArray(e.map { sortKeys(it) })
    else -> e
}

/** Swift UUID coding: case-insensitive in, upper case out. */
object UUIDSerializer : KSerializer<UUID> {
    override val descriptor = PrimitiveSerialDescriptor("UUID", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: UUID) = encoder.encodeString(value.toString().uppercase())
    override fun deserialize(decoder: Decoder): UUID = parseUUID(decoder.decodeString()) ?: throw PhrenKitError.Validation("Invalid UUID.")
}

/** Foundation's `UUID(uuidString:)`: exactly 8-4-4-4-12 hex. */
fun parseUUID(text: String?): UUID? {
    if (text == null || !Regex("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$").matches(text)) return null
    return runCatching { UUID.fromString(text) }.getOrNull()
}

fun UUID.upper(): String = toString().uppercase()

/** A JSON timestamp: ISO 8601 text, or seconds / milliseconds since 1970. */
internal fun jsonTimestamp(value: JsonElement?): Instant? {
    value.str?.let { return ISO8601Dates.parse(it) }
    value.double?.let { v -> return Instant.ofEpochMilli(((if (v > 1e12) v / 1000 else v) * 1000).toLong()) }
    return null
}

/** Unicode control characters, as `CharacterSet.controlCharacters` counts them. */
internal fun String.hasControlCharacters(): Boolean = codePoints().anyMatch { Character.getType(it) == Character.CONTROL.toInt() || Character.getType(it) == Character.FORMAT.toInt() }
