package com.phren.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

// Transcriptions from packages/cli/src/content/citation.ts.

/** citation.ts:100 `buildCitationComment` (key order follows FindingCitation). */
internal fun buildCitationComment(citation: FindingCitation): String {
    val parts = mutableListOf<String>()
    fun add(key: String, value: String?) {
        if (value != null) parts += "\"$key\":${jsonString(value)}"
    }
    add("created_at", citation.createdAt)
    add("repo", citation.repo)
    add("file", citation.file)
    citation.line?.let { parts += "\"line\":$it" }
    add("commit", citation.commit)
    add("supersedes", citation.supersedes)
    add("task_item", citation.taskItem)
    return "<!-- phren:cite {${parts.joinToString(",")}} -->"
}

/** Minimal JSON string encoder matching JSON.stringify for our payloads. */
internal fun jsonString(value: String): String {
    val out = StringBuilder("\"")
    for (ch in value) {
        when {
            ch == '"' -> out.append("\\\"")
            ch == '\\' -> out.append("\\\\")
            ch == '\n' -> out.append("\\n")
            ch == '\r' -> out.append("\\r")
            ch == '\t' -> out.append("\\t")
            ch == '\b' -> out.append("\\b")
            ch == '\u000C' -> out.append("\\f")
            ch.code < 0x20 -> out.append(String.format("\\u%04x", ch.code))
            else -> out.append(ch)
        }
    }
    return out.append('"').toString()
}

/** citation.ts:104 `readSourceToken` */
private fun readSourceToken(raw: String?): String? {
    val t = raw?.jsTrimmed ?: return null
    if (t.isEmpty()) return null
    if (t.length >= 2 && t.startsWith("\"") && t.endsWith("\"")) return t.substring(1, t.length - 1)
    return t
}

/** citation.ts:120 `buildSourceComment` */
internal fun buildSourceComment(source: FindingProvenance): String {
    val parts = mutableListOf<String>()
    source.source?.let { parts += it }
    source.machine?.let { parts += "machine:$it" }
    source.actor?.let { parts += "actor:$it" }
    source.tool?.let { parts += "tool:$it" }
    source.model?.let { parts += "model:$it" }
    source.sessionId?.let { parts += "session:$it" }
    source.scope?.let { parts += "scope:$it" }
    return if (parts.isEmpty()) "" else "<!-- source:${parts.joinToString(" ")} -->"
}

/** citation.ts:133 `buildScopeComment` */
internal fun buildScopeComment(scope: String?): String =
    if (scope.isNullOrEmpty() || scope == "shared") "" else "<!-- scope:$scope -->"

private val EDGE_QUOTES = JSRegex("""^"|"$""")

/** citation.ts:139 `parseScopeComment` */
internal fun parseScopeComment(line: String): String? {
    val raw = MetadataRegex.scopeComment.group(line) ?: return null
    val unquoted = EDGE_QUOTES.replaceAll(raw, "").jsTrimmed
    return unquoted.ifEmpty { null }
}

// citation.ts:20 FINDING_PROVENANCE_SOURCES
private val provenanceSources = setOf("human", "agent", "hook", "extract", "consolidation", "unknown")
private val WS_SPLIT = JSRegex("""\s+""")

/** citation.ts:146 `parseSourceComment` */
internal fun parseSourceComment(line: String): FindingProvenance? {
    val payload = MetadataRegex.source.group(line) ?: return null
    // TS splits on /\s+/ (citation.ts:151).
    val firstToken = WS_SPLIT.pattern.split(payload.jsTrimmed).firstOrNull() ?: ""
    fun token(key: String): String? = readSourceToken(JSRegex("(?:^|\\s)$key:(\".*?\"|\\S+)").group(payload))

    val sourceRaw = if (firstToken.isNotEmpty() && !firstToken.contains(":")) firstToken
    else token("source") ?: token("kind")
    val provenance = FindingProvenance(
        source = sourceRaw?.takeIf { it in provenanceSources },
        machine = token("machine") ?: token("host"),
        actor = token("actor") ?: token("agent"),
        tool = token("tool"),
        model = token("model"),
        sessionId = token("session") ?: token("session_id"),
        scope = token("scope")?.let { it.jsTrimmed.ifEmpty { "shared" } },
    )
    return if (provenance.isEmpty) null else provenance
}

/**
 * citation.ts:177 `parseCitationComment` — marker-based extraction so
 * multiline or escaped JSON payloads survive.
 */
internal fun parseCitationComment(line: String): FindingCitation? {
    val marker = MetadataRegex.citationMarker.firstMatch(line) ?: return null
    val jsonStart = marker.end()
    val end = line.indexOf("-->", jsonStart)
    if (end < 0) return null
    val jsonStr = line.substring(jsonStart, end).jsTrimmed
    if (!jsonStr.startsWith("{")) return null
    val parsed: JsonObject = try {
        Json.parseToJsonElement(jsonStr).jsonObject
    } catch (_: Exception) {
        return null
    }
    fun str(key: String): String? = (parsed[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    val createdAt = str("created_at")?.takeIf { it.isNotEmpty() } ?: return null
    // TS's `typeof === "number"`: reject strings and booleans.
    val lineNo = (parsed["line"] as? JsonPrimitive)?.takeIf { !it.isString && it.contentOrNull != "true" && it.contentOrNull != "false" }
        ?.let { it.intOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toInt() }
    return FindingCitation(
        createdAt = createdAt,
        repo = str("repo"),
        file = str("file"),
        line = lineNo,
        commit = str("commit"),
        supersedes = str("supersedes"),
        taskItem = str("task_item"),
    )
}
