package com.phren.kit

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** JSONSerialization.data(withJSONObject:) for tests: Kotlin maps, lists and primitives to JSON bytes. */
fun jsonElement(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k as String to jsonElement(v) })
    is List<*> -> JsonArray(value.map(::jsonElement))
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    else -> error("Unsupported JSON value $value")
}

fun jsonData(value: Any?): ByteArray = jsonElement(value).toString().toByteArray()
