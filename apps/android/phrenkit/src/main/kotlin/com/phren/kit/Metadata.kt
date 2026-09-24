package com.phren.kit

/**
 * Transcription of `METADATA_REGEX` and its parsing/strip helpers from
 * packages/cli/src/content/metadata.ts (via MetadataRegex.swift). Keep the
 * three in lockstep when the CLI format evolves.
 */
internal object MetadataRegex {
    // metadata.ts:21 — `<!-- phren:status "active" -->`
    val status = JSRegex(
        """<!--\s*phren:status\s+"?(active|superseded|contradicted|stale|invalid_citation|retracted)"?\s*-->""",
        caseInsensitive = true,
    )

    // metadata.ts:46 — `<!-- phren:superseded_by "text" 2025-01-01 -->`
    val supersededBy = JSRegex(
        """<!--\s*phren:superseded_by\s+"([^"]+)"(?:\s+([0-9]{4}-[0-9]{2}-[0-9]{2}))?\s*-->""",
        caseInsensitive = true,
    )

    // metadata.ts:52 — legacy `<!-- superseded_by: "text" -->`
    val supersededByLegacy = JSRegex("""<!--\s*superseded_by:\s*"([^"]+)"\s*-->""", caseInsensitive = true)

    // metadata.ts:55
    val supersedes = JSRegex("""<!--\s*phren:supersedes\s+"([^"]+)"\s*-->""", caseInsensitive = true)

    // metadata.ts:58
    val contradicts = JSRegex("""<!--\s*phren:contradicts\s+"([^"]+)"\s*-->""", caseInsensitive = true)

    // metadata.ts:61 — global version for matchAll (case-sensitive in the TS source)
    val contradictsAll = JSRegex("""<!--\s*phren:contradicts\s+"([^"]+)"\s*-->""")

    // metadata.ts:64 — legacy `<!-- conflicts_with: "text" (from project: foo) -->`
    val conflictsWith = JSRegex(
        """<!--\s*conflicts_with:\s*"([^"]+)"(?:\s*\(from project:\s*[^)]+\))?\s*-->""",
        caseInsensitive = true,
    )

    // metadata.ts:70 — full-line `<!-- phren:cite {...} -->`
    val citation = JSRegex("""^\s*<!--\s*phren:cite\s+\{.*\}\s*-->\s*$""")

    // metadata.ts:73
    val citationMarker = JSRegex("""<!--\s*phren:cite\s+""")

    // metadata.ts:76,79
    val archiveStart = JSRegex("""<!--\s*phren:archive:start\s*-->""")
    val archiveEnd = JSRegex("""<!--\s*phren:archive:end\s*-->""")
    val detailsOpen = JSRegex("""^<details(?:\s|>)""", caseInsensitive = true)
    val detailsClose = JSRegex("""^</details>""", caseInsensitive = true)

    // metadata.ts:82
    val findingId = JSRegex("""<!--\s*fid:([a-z0-9]{8})\s*-->""", caseInsensitive = true)

    // metadata.ts:85
    val createdDate = JSRegex("""<!--\s*created:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*-->""", caseInsensitive = true)

    // metadata.ts:91
    val source = JSRegex("""<!--\s*source:\s*(.*?)\s*-->""")

    // metadata.ts:94 — any HTML comment (non-greedy)
    val anyComment = JSRegex("""<!--.*?-->""")

    // citation.ts:140 — standalone `<!-- scope:VALUE -->`
    val scopeComment = JSRegex("""<!--\s*scope:(".*?"|\S+)\s*-->""")

    // metadata.ts:36
    fun statusField(field: String) =
        JSRegex("<!--\\s*phren:$field\\s+\"([^\"]+)\"\\s*-->", caseInsensitive = true)

    // metadata.ts:41
    fun statusFieldRaw(field: String) =
        JSRegex("<!--\\s*phren:$field\\s+([^>]+?)\\s*-->", caseInsensitive = true)
}

// Parsing helpers (metadata.ts:137-244)

/** metadata.ts:137 `parseStatus` */
internal fun parseStatus(line: String): String? = MetadataRegex.status.group(line)?.lowercase()

/** metadata.ts:142 `parseStatusField` */
internal fun parseStatusField(line: String, field: String): String? {
    MetadataRegex.statusField(field).group(line)?.let { return it.collapsedWhitespace.jsTrimmed }
    MetadataRegex.statusFieldRaw(field).group(line)?.let { return it.collapsedWhitespace.jsTrimmed }
    return null
}

/** metadata.ts:150 `parseSupersession` */
internal fun parseSupersession(line: String): Pair<String, String?>? {
    MetadataRegex.supersededBy.firstMatch(line)?.let { m ->
        JSRegex.substring(m, 1)?.let { ref -> return ref to JSRegex.substring(m, 2) }
    }
    MetadataRegex.supersededByLegacy.group(line)?.let { return it to null }
    return null
}

/** metadata.ts:164 `parseContradiction` */
internal fun parseContradiction(line: String): String? =
    MetadataRegex.contradicts.group(line) ?: MetadataRegex.conflictsWith.group(line)

/** metadata.ts:173 `parseAllContradictions` */
internal fun parseAllContradictions(line: String): List<String> = MetadataRegex.contradictsAll.allGroups(line)

/** metadata.ts:178 `parseFindingId` */
internal fun parseFindingId(line: String): String? = MetadataRegex.findingId.group(line)

/** metadata.ts:183 `parseCreatedDate` */
internal fun parseCreatedDate(line: String): String? = MetadataRegex.createdDate.group(line)

/** metadata.ts:188 `isCitationLine` */
internal fun isCitationLine(line: String): Boolean = MetadataRegex.citation.test(line.jsTrimmed)

/** metadata.ts:193 `isArchiveStart` */
internal fun isArchiveStart(line: String): Boolean =
    MetadataRegex.archiveStart.test(line) || MetadataRegex.detailsOpen.test(line.jsTrimmed)

/** metadata.ts:198 `isArchiveEnd` */
internal fun isArchiveEnd(line: String): Boolean =
    MetadataRegex.archiveEnd.test(line) || MetadataRegex.detailsClose.test(line.jsTrimmed)

/** metadata.ts:231 `stripComments` */
fun stripComments(text: String): String = MetadataRegex.anyComment.replaceAll(text, "").jsTrimmed

private val LEADING_BULLET = JSRegex("""^-\s+""")
private val CONFIDENCE_TAG = JSRegex("""\[confidence\s+[01](?:\.\d+)?\]""", caseInsensitive = true)

/**
 * metadata.ts:236 `normalizeFindingText` — the canonical needle for finding
 * matching. Must stay byte-identical to the TS version or edit/remove resolve
 * to different bullets than the CLI would.
 */
fun normalizeFindingText(raw: String): String {
    var s = LEADING_BULLET.replaceFirst(raw, "")
    s = MetadataRegex.anyComment.replaceAll(s, " ")
    s = CONFIDENCE_TAG.replaceAll(s, " ")
    s = s.collapsedWhitespace
    return s.jsTrimmed.lowercase()
}

// Transcriptions from packages/cli/src/finding/lifecycle.ts.

/** Mirrors `FindingLifecycleMetadata` (lifecycle.ts). */
internal data class FindingLifecycleMetadata(
    val status: FindingLifecycleStatus = FindingLifecycleStatus.ACTIVE,
    val statusUpdated: String? = null,
    val statusReason: String? = null,
    val statusRef: String? = null,
)

private fun cleanCommentValue(value: String): String = value.collapsedWhitespace.jsTrimmed

private fun serializeCommentValue(value: String): String = cleanCommentValue(value).replace("\"", "'")

/** lifecycle.ts:78 `parseFindingLifecycle` */
internal fun parseFindingLifecycle(line: String): FindingLifecycleMetadata {
    val created = parseCreatedDate(line)?.let(::cleanCommentValue)
    val normalizedStatus = parseStatus(line)?.let { FindingLifecycleStatus.from(it) }

    val normalized = FindingLifecycleMetadata(
        status = normalizedStatus ?: FindingLifecycleStatus.ACTIVE,
        statusUpdated = parseStatusField(line, "status_updated") ?: created,
        statusReason = parseStatusField(line, "status_reason"),
        statusRef = parseStatusField(line, "status_ref"),
    )
    if (normalizedStatus != null) return normalized

    parseSupersession(line)?.let { (ref, date) ->
        val updated = date ?: normalized.statusUpdated
        return FindingLifecycleMetadata(
            status = FindingLifecycleStatus.SUPERSEDED,
            statusUpdated = updated?.let(::cleanCommentValue),
            statusReason = normalized.statusReason ?: "superseded_by",
            statusRef = normalized.statusRef ?: cleanCommentValue(ref),
        )
    }

    parseContradiction(line)?.let { ref ->
        return FindingLifecycleMetadata(
            status = FindingLifecycleStatus.CONTRADICTED,
            statusUpdated = normalized.statusUpdated,
            statusReason = normalized.statusReason ?: "conflicts_with",
            statusRef = normalized.statusRef ?: cleanCommentValue(ref),
        )
    }
    return normalized
}

/** lifecycle.ts:115 `buildLifecycleComments` */
internal fun buildLifecycleComments(lifecycle: FindingLifecycleMetadata?, fallbackDate: String? = null): String {
    val status = lifecycle?.status ?: FindingLifecycleStatus.ACTIVE
    val statusUpdated = lifecycle?.statusUpdated ?: fallbackDate
    val parts = mutableListOf("<!-- phren:status \"${status.rawValue}\" -->")
    statusUpdated?.let { parts += "<!-- phren:status_updated \"${serializeCommentValue(it)}\" -->" }
    lifecycle?.statusReason?.let { parts += "<!-- phren:status_reason \"${serializeCommentValue(it)}\" -->" }
    lifecycle?.statusRef?.let { parts += "<!-- phren:status_ref \"${serializeCommentValue(it)}\" -->" }
    return parts.joinToString(" ")
}

/** lifecycle.ts:37 `extractFindingType` — any tag key in FINDING_TYPE_DECAY. */
private val findingTypeDecayTags = setOf(
    "pattern", "decision", "pitfall", "anti-pattern", "observation",
    "workaround", "bug", "tooling", "context",
)
private val TYPE_TAG = JSRegex("""\[(\w[\w-]*)\]""")

internal fun extractFindingType(line: String): String? {
    val tag = TYPE_TAG.group(line)?.lowercase() ?: return null
    return if (tag in findingTypeDecayTags) tag else null
}
