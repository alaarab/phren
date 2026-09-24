package com.phren.kit

import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Parser + mutator for a project's FINDINGS.md (port of FindingsFile.swift).
 *
 * Parsing transcribes `readFindings` (packages/cli/src/data/access.ts:276);
 * mutations transcribe `addFindingToFile` (content/learning.ts:298),
 * `editFinding` (access.ts:558), and `removeFinding` (access.ts:462).
 */
class FindingsFile(content: String) {
    var content: String = content
        private set

    // Parse (access.ts:276 readFindings)

    fun parse(includeArchived: Boolean = false): List<Finding> {
        if (content.isEmpty()) return emptyList()
        val lines = content.split("\n")
        val items = mutableListOf<Finding>()
        var date = "unknown"
        var index = 1
        var inArchiveBlock = false
        var headingTag: String? = null

        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            try {
                if (isArchiveStart(line)) { inArchiveBlock = true; continue }
                if (isArchiveEnd(line)) { inArchiveBlock = false; continue }
                if (inArchiveBlock && !includeArchived) continue

                extractDateHeading(line)?.let { date = it; continue }

                // access.ts:315 — heading-based findings: ## topic / ### title / paragraph
                val h2Tag = H2_TAG.group(line)
                if (h2Tag != null && !H2_YEAR.test(line)) {
                    headingTag = h2Tag.lowercase()
                    continue
                }
                val h3Title = H3.group(line)
                val tag = headingTag
                if (h3Title != null && tag != null) {
                    var body = ""
                    var j = i + 1
                    while (j < lines.size) {
                        val next = lines[j].jsTrimmed
                        j++
                        if (next.isEmpty()) continue
                        if (next.startsWith("#") || next.startsWith("- ")) break
                        body = next
                        break
                    }
                    val title = h3Title.jsTrimmed
                    val syntheticText = if (body.isEmpty()) "[$tag] $title" else "[$tag] $title — $body"
                    items += Finding(
                        id = "L$index", date = date, text = syntheticText,
                        archived = inArchiveBlock, typeTag = tag, rawLine = line,
                    )
                    index++
                    continue
                }

                if (!line.startsWith("- ")) continue

                val next = if (i + 1 < lines.size) lines[i + 1] else ""
                val citation = if (isCitationLine(next)) next.jsTrimmed else null
                val citationData = citation?.let(::parseCitationComment)
                val provenance = parseSourceComment(line)
                val scope = parseScopeComment(line) ?: provenance?.scope
                val stableId = parseFindingId(line)
                val rawText = LEADING_BULLET.replaceFirst(line, "").jsTrimmed
                val textWithoutComments = stripComments(rawText)
                var confidence: Double? = null
                var text = textWithoutComments
                CONFIDENCE_SUFFIX.firstMatch(textWithoutComments)?.let { m ->
                    confidence = m.group(1).toDoubleOrNull()
                    text = textWithoutComments.substring(0, m.start()).jsTrimmed
                }

                val contradictsRefs = parseAllContradictions(line)
                val lifecycle = parseFindingLifecycle(line)
                items += Finding(
                    id = "L$index",
                    stableId = stableId,
                    date = date,
                    text = text,
                    citation = citation,
                    citationData = citationData,
                    taskItem = citationData?.taskItem,
                    confidence = confidence,
                    scope = scope,
                    machine = provenance?.machine,
                    actor = provenance?.actor,
                    supersededBy = MetadataRegex.supersededBy.group(line),
                    supersedes = MetadataRegex.supersedes.group(line),
                    contradicts = contradictsRefs.ifEmpty { null },
                    status = lifecycle.status,
                    statusUpdated = lifecycle.statusUpdated,
                    statusReason = lifecycle.statusReason,
                    statusRef = lifecycle.statusRef,
                    archived = inArchiveBlock,
                    typeTag = TYPE_PREFIX.group(text)?.lowercase(),
                    rawLine = line,
                )
                if (citation != null) i++
                index++
            } finally {
                i++
            }
        }
        return items
    }

    /**
     * The date of the last consolidation, from the `<!-- consolidated: … -->`
     * stamp `autoArchiveToReference` writes (content/archive.ts:236).
     */
    val consolidatedDate: String? get() = CONSOLIDATED.group(content)

    // Add (learning.ts:160 prepareFinding + 244 insertFindingIntoContent)

    data class AddOptions(
        val type: FindingType? = null,
        val scope: String? = null,
        val provenance: FindingProvenance? = null,
        /** Set when promoting a review-queue item: the date it was queued. */
        val queuedDate: String? = null,
        val now: Instant = Instant.now(),
    )

    /**
     * Adds a finding, mirroring the CLI's bullet construction. Intentional MVP
     * divergences (apps/ios/README.md): no coref, no auto type detection,
     * exact-normalized dedup only, no auto-archive cap.
     */
    fun add(project: String, text: String, options: AddOptions = AddOptions()): String {
        val learning = text.jsTrimmed
        if (learning.isEmpty()) throw PhrenKitError.EmptyInput("Finding text cannot be empty.")
        SecretScanner.scan(learning)?.let {
            throw PhrenKitError.SecretDetected("Rejected: finding appears to contain a secret ($it). Strip credentials before saving.")
        }
        val nowIso = isoTimestamp(options.now)
        val today = nowIso.take(10)

        var normalizedLearning = learning
        // core/finding.ts `applyFindingTypePrefix`: the test is anchored and accepts any
        // bracketed tag. `extractFindingType` is unanchored and knows only the decay types,
        // so a `[bug]` mid-sentence dropped the caller's type and `[tradeoff]` was tagged twice.
        if (options.type != null && !FINDING_TAG_PREFIX.test(normalizedLearning)) {
            normalizedLearning = "[${options.type.rawValue}] $normalizedLearning"
        }

        val fid = randomHexId()
        var bullet = if (normalizedLearning.startsWith("- ")) normalizedLearning else "- $normalizedLearning"
        bullet += " <!-- fid:$fid --> <!-- created: $today -->"
        val scopeComment = buildScopeComment(options.scope)
        if (scopeComment.isNotEmpty()) bullet += " $scopeComment"
        options.provenance?.let {
            val sourceComment = buildSourceComment(it)
            if (sourceComment.isNotEmpty()) bullet += " $sourceComment"
        }
        // A promoted queue item is written today but was captured earlier: learning.ts
        // places approveQueueItemDetailed's extra annotation after scope and source.
        if (!options.queuedDate.isNullOrEmpty()) bullet += " <!-- phren:queued \"${options.queuedDate}\" -->"

        if (isDuplicate(bullet)) {
            throw PhrenKitError.Duplicate("Skipped duplicate finding for \"$project\": already exists with similar wording.")
        }

        bullet += " " + buildLifecycleComments(
            FindingLifecycleMetadata(status = FindingLifecycleStatus.ACTIVE, statusUpdated = today),
            fallbackDate = today,
        )
        val citationComment = "  " + buildCitationComment(FindingCitation(createdAt = nowIso))

        content = if (content.isEmpty()) {
            // learning.ts:349 — brand-new FINDINGS.md
            "# $project Findings\n\n## $today\n\n$bullet\n$citationComment\n"
        } else {
            insertFindingIntoContent(content, today, bullet, citationComment)
        }
        return fid
    }

    /** Exact-normalized-text duplicate check — minimal port of `isDuplicateFinding` (dedup.ts:394). */
    private fun isDuplicate(bullet: String): Boolean {
        val needle = normalizeFindingText(bullet)
        if (needle.isEmpty()) return false
        return content.split("\n").filter { it.startsWith("- ") }.any { normalizeFindingText(it) == needle }
    }

    // Edit (access.ts:558 editFinding)

    fun edit(project: String, oldText: String, newText: String) {
        val newTextTrimmed = newText.jsTrimmed
        if (newTextTrimmed.isEmpty()) throw PhrenKitError.EmptyInput("New finding text cannot be empty.")
        val lines = content.split("\n").toMutableList()
        val idx = matchBullet(lines, oldText, project)

        // access.ts:588 — preserve every metadata comment as a re-appended
        // suffix, and keep the [tag] prefix unless the new text supplies one.
        val existing = lines[idx]
        val metaComments = MetadataRegex.anyComment.allMatches(existing)
        val metaSuffix = if (metaComments.isEmpty()) "" else " " + metaComments.joinToString(" ")
        val existingTag = EXISTING_TAG.group(existing)
        val newHasTag = NEW_TAG.test(newTextTrimmed)
        val tagPrefix = if (existingTag != null && !newHasTag) "$existingTag " else ""
        lines[idx] = "- $tagPrefix$newTextTrimmed$metaSuffix"
        content = normalizeWrite(lines)
    }

    // Remove (access.ts:462 removeFinding)

    fun remove(project: String, match: String): String {
        val lines = content.split("\n").toMutableList()
        val idx = matchBullet(lines, match, project)
        val removeCount = if (idx + 1 < lines.size && isCitationLine(lines[idx + 1])) 2 else 1
        val matched = lines[idx]
        repeat(removeCount) { lines.removeAt(idx) }
        content = normalizeWrite(lines)
        return matched
    }

    // Matching (access.ts:184-248)

    private data class BulletLine(val line: String, val i: Int, val archived: Boolean)

    private fun collectBulletLines(lines: List<String>): List<BulletLine> {
        val bullets = mutableListOf<BulletLine>()
        var inArchiveBlock = false
        lines.forEachIndexed { i, line ->
            if (isArchiveStart(line)) { inArchiveBlock = true; return@forEachIndexed }
            if (isArchiveEnd(line)) { inArchiveBlock = false; return@forEachIndexed }
            if (!line.startsWith("- ")) return@forEachIndexed
            bullets += BulletLine(line, i, inArchiveBlock)
        }
        return bullets
    }

    /** access.ts:204 `bulletContentKey` */
    private fun bulletContentKey(line: String): String =
        MetadataRegex.anyComment.replaceAll(line, " ").collapsedWhitespace.jsTrimmed

    /** access.ts:214 `resolveDuplicateMatches` */
    private fun resolveDuplicateMatches(matches: List<BulletLine>): BulletLine? {
        val first = matches.firstOrNull() ?: return null
        val key = bulletContentKey(first.line)
        return if (matches.all { bulletContentKey(it.line) == key }) first else null
    }

    private fun matchBullet(lines: List<String>, match: String, project: String): Int {
        val needle = normalizeFindingText(match)
        val bullets = collectBulletLines(lines)
        return when (val r = matchIn(bullets.filter { !it.archived }, needle, match)) {
            is MatchResult.Found -> r.index
            is MatchResult.Ambiguous -> throw PhrenKitError.AmbiguousMatch(r.error)
            MatchResult.NotFound -> when (matchIn(bullets.filter { it.archived }, needle, match)) {
                MatchResult.NotFound -> throw PhrenKitError.NotFound("No finding matching \"$match\" in project \"$project\".")
                else -> throw PhrenKitError.ArchivedReadOnly(
                    "Finding \"$match\" is archived and read-only. Restore or re-add it before mutating history.",
                )
            }
        }
    }

    private sealed interface MatchResult {
        data class Found(val index: Int) : MatchResult
        data class Ambiguous(val error: String) : MatchResult
        data object NotFound : MatchResult
    }

    /**
     * access.ts `existsAsLiveFinding`: does this text already exist as a live
     * (non-archived) bullet? Ambiguous counts as present: approve must not write another copy.
     */
    fun existsAsLiveFinding(text: String): Boolean {
        val needle = normalizeFindingText(text)
        if (needle.isEmpty()) return false
        val active = collectBulletLines(content.split("\n")).filter { !it.archived }
        return matchIn(active, needle, text) != MatchResult.NotFound
    }

    private fun matchIn(bullets: List<BulletLine>, needle: String, match: String): MatchResult {
        val fidNeedle = if (needle.startsWith("fid:")) needle.drop(4) else needle
        if (FID_NEEDLE.test(fidNeedle)) {
            val fidRegex = JSRegex("<!--\\s*fid:$fidNeedle\\s*-->")
            val fidMatches = bullets.filter { fidRegex.test(it.line) }
            if (fidMatches.size == 1) return MatchResult.Found(fidMatches[0].i)
        }
        val exact = bullets.filter { normalizeFindingText(it.line) == needle }
        if (exact.size == 1) return MatchResult.Found(exact[0].i)
        if (exact.size > 1) {
            resolveDuplicateMatches(exact)?.let { return MatchResult.Found(it.i) }
            return MatchResult.Ambiguous("\"$match\" is ambiguous (${exact.size} exact matches). Use a more specific phrase.")
        }
        val partial = bullets.filter { normalizeFindingText(it.line).contains(needle) }
        if (partial.size == 1) return MatchResult.Found(partial[0].i)
        if (partial.size > 1) {
            resolveDuplicateMatches(partial)?.let { return MatchResult.Found(it.i) }
            return MatchResult.Ambiguous("\"$match\" is ambiguous (${partial.size} partial matches). Use a more specific phrase.")
        }
        return MatchResult.NotFound
    }

    companion object {
        /** core/finding.ts `FINDING_TAG_PREFIX_RE` */
        internal val FINDING_TAG_PREFIX = JSRegex("""^\s*\[[^\]]+\]\s*""")

        private val H2_TAG = JSRegex("""^##\s+([a-z_-]+)\s*$""", caseInsensitive = true)
        private val H2_YEAR = JSRegex("""^##\s+\d{4}""")
        private val H3 = JSRegex("""^###\s+(.+)$""")
        private val LEADING_BULLET = JSRegex("""^-\s+""")
        private val CONFIDENCE_SUFFIX = JSRegex("""\s*\[confidence\s+([01](?:\.\d+)?)\]\s*$""", caseInsensitive = true)
        private val TYPE_PREFIX = JSRegex("""^\[([a-z][a-z0-9_-]*)\]""", caseInsensitive = true)
        private val CONSOLIDATED = JSRegex("""<!--\s*consolidated:\s*(\d{4}-\d{2}-\d{2})""")
        private val DATE_HEADING = JSRegex("""^##\s+(.+)$""")
        private val DATE_ONLY = JSRegex("""^(\d{4}-\d{2}-\d{2})$""")
        private val ARCHIVED_DATE = JSRegex("""^Archived\s+(\d{4}-\d{2}-\d{2})$""", caseInsensitive = true)
        private val FIRST_DATE_HEADING = JSRegex.multiline("""^## \d{4}-\d{2}-\d{2}""")
        private val EXISTING_TAG = JSRegex("""^-\s*(\[[a-z][a-z0-9_-]*\])\s""")
        private val NEW_TAG = JSRegex("""^\[[a-z][a-z0-9_-]*\]""")
        private val FID_NEEDLE = JSRegex("""^[a-z0-9]{8}$""")
        private val TRIPLE_NEWLINES = JSRegex("""\n{3,}""")
        private val random = SecureRandom()
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

        fun empty(@Suppress("UNUSED_PARAMETER") project: String) = FindingsFile("")

        /** access.ts:164 `extractDateHeading` */
        fun extractDateHeading(line: String): String? {
            val raw = DATE_HEADING.group(line)?.jsTrimmed ?: return null
            DATE_ONLY.group(raw)?.let { return it }
            return ARCHIVED_DATE.group(raw)
        }

        /**
         * learning.ts:244 `insertFindingIntoContent` — the today-header search
         * starts after the last `</details>` so archived blocks are never reused.
         */
        fun insertFindingIntoContent(content: String, today: String, bullet: String, citationComment: String): String {
            val todayHeader = "## $today"
            val searchFrom = content.lastIndexOf("</details>").coerceAtLeast(0)
            val header = content.indexOf(todayHeader, searchFrom)
            if (header >= 0) {
                val insertAt = header + todayHeader.length
                return content.substring(0, insertAt) + "\n\n$bullet\n$citationComment" + content.substring(insertAt)
            }
            FIRST_DATE_HEADING.firstMatch(content)?.let { m ->
                return content.substring(0, m.start()) + "$todayHeader\n\n$bullet\n$citationComment\n\n" + content.substring(m.start())
            }
            return trimEnd(content) + "\n\n## $today\n\n$bullet\n$citationComment\n"
        }

        /** `lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"` (access.ts:493). */
        fun normalizeWrite(lines: List<String>): String = normalizeContent(lines.joinToString("\n"))

        fun normalizeContent(joined: String): String = trimEnd(TRIPLE_NEWLINES.replaceAll(joined, "\n\n")) + "\n"

        /** crypto.randomBytes(4).toString("hex") */
        fun randomHexId(): String {
            val bytes = ByteArray(4).also(random::nextBytes)
            return bytes.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
        }

        /** new Date().toISOString() */
        fun isoTimestamp(date: Instant): String = ISO.format(date)
    }
}

/** JS `String.prototype.trimEnd()`. */
fun trimEnd(s: String): String = s.trimEnd(JSRegex::isJsWhitespace)
