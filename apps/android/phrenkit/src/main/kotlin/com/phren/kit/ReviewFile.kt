package com.phren.kit

/**
 * Parser + mutator for a project's review.md (the review queue). Port of
 * ReviewFile.swift, transcribing packages/cli/src/data/access.ts:609-749 and
 * the queue text normalization from governance/policy.ts:706-741.
 */
class ReviewFile(content: String) {
    var content: String = content
        private set

    data class ParsedQueueLine(
        val date: String?,
        val text: String,
        val confidence: Double?,
        val machine: String?,
        val model: String?,
    )

    fun parse(): List<QueueItem> {
        if (content.isEmpty()) return emptyList()
        val items = mutableListOf<QueueItem>()
        var section = QueueItem.Section.REVIEW
        var index = 1
        for (line in content.split("\n")) {
            val heading = HEADING.group(line.jsTrimmed)
            if (heading != null) {
                when (heading.collapsedWhitespace.jsTrimmed.lowercase()) {
                    "review" -> { section = QueueItem.Section.REVIEW; continue }
                    "stale" -> { section = QueueItem.Section.STALE; continue }
                    "conflicts" -> { section = QueueItem.Section.CONFLICTS; continue }
                }
            }
            if (!line.startsWith("- ")) continue
            val parsed = parseQueueLine(line)
            val risky = section != QueueItem.Section.REVIEW || (parsed.confidence?.let { it < 0.7 } ?: false)
            items += QueueItem(
                id = "M$index",
                section = section,
                date = parsed.date ?: "unknown",
                text = parsed.text,
                line = line,
                confidence = parsed.confidence,
                risky = risky,
                machine = parsed.machine,
                model = parsed.model,
            )
            index++
        }
        return items
    }

    /** access.ts:674 `withQueueLineOp` — locate by trimmed-line equality. */
    private fun lineIndex(lineText: String, lines: List<String>): Int {
        val idx = lines.indexOfFirst { it.jsTrimmed == lineText.jsTrimmed }
        if (idx < 0) throw PhrenKitError.NotFound("Queue item not found.")
        return idx
    }

    /** access.ts:700 `approveQueueItem` — remove the line from review.md only. */
    fun approve(lineText: String) {
        val lines = content.split("\n").toMutableList()
        lines.removeAt(lineIndex(lineText, lines))
        content = FindingsFile.normalizeWrite(lines)
    }

    /**
     * The review.md half of `rejectQueueItem` (access.ts:709). The caller
     * composes this with `FindingsFile.remove` using [findingsTextFor].
     */
    fun reject(lineText: String) = approve(lineText)

    /**
     * The review.md half of `editQueueItem` (access.ts:728) — rewrites the line
     * preserving the `- [date] ` prefix. Returns the new-text needle.
     */
    fun edit(lineText: String, newText: String): String {
        val trimmed = NEWLINES.replaceAll(newText, " ").jsTrimmed
        if (trimmed.isEmpty()) throw PhrenKitError.EmptyInput("New text cannot be empty.")
        val lines = content.split("\n").toMutableList()
        val idx = lineIndex(lineText, lines)
        val date = DATE_PREFIX.group(lines[idx])
        lines[idx] = if (date != null) "- [$date] $trimmed" else "- $trimmed"
        content = FindingsFile.normalizeWrite(lines)
        return trimmed
    }

    companion object {
        /** policy.ts:19 */
        const val MAX_QUEUE_ENTRY_LENGTH = 500

        private val HEADING = JSRegex("""^##\s+(.+?)[\s]*$""", caseInsensitive = true)
        private val CRLF = JSRegex("""\r\n?""")
        private val COMMENT_DOTALL = JSRegex("""<!--[\s\S]*?-->""")
        private val ESCAPED_WS = JSRegex("""\\[nrt]""")
        private val NEWLINE_RUN = JSRegex("""\n+""")
        private val DATED = JSRegex("""^- \[(\d{4}-\d{2}-\d{2})\]\s*(.+)$""")
        private val LEADING_BULLET = JSRegex("""^-\s+""")
        private val CONFIDENCE = JSRegex("""\[confidence\s+([01](?:\.\d+)?)\]""", caseInsensitive = true)
        private val CONFIDENCE_STRIP = JSRegex("""\s*\[confidence\s+[01](?:\.\d+)?\]""", caseInsensitive = true)
        private val NEWLINES = JSRegex("""[\r\n]+""")
        private val DATE_PREFIX = JSRegex("""^- \[(\d{4}-\d{2}-\d{2})\]\s*""")

        /** policy.ts:710 `cleanQueueEntryText` */
        fun cleanQueueEntryText(raw: String): String {
            var s = CRLF.replaceAll(raw, "\n")
            s = s.replace("\u0000", " ")
            s = COMMENT_DOTALL.replaceAll(s, " ")
            s = ESCAPED_WS.replaceAll(s, " ")
            s = s.replace("\\\"", "\"")
            s = s.replace("\\\\", "\\")
            s = NEWLINE_RUN.replaceAll(s, " ")
            s = s.collapsedWhitespace
            return s.jsTrimmed
        }

        /**
         * policy.ts:723 `normalizeQueueEntryText` with `{truncate: true}`.
         * Kotlin strings are UTF-16 like JS, so `.length`/`.substring` match
         * the CLI's truncation boundary exactly (lone surrogates included).
         */
        fun normalizeQueueEntryText(raw: String): String {
            val cleaned = cleanQueueEntryText(raw)
            if (cleaned.length <= MAX_QUEUE_ENTRY_LENGTH) return cleaned
            return trimEnd(cleaned.substring(0, MAX_QUEUE_ENTRY_LENGTH - 1)) + "…"
        }

        /** access.ts:609 `parseQueueLine` */
        fun parseQueueLine(line: String): ParsedQueueLine {
            val m = DATED.firstMatch(line)
            val date: String?
            val rawText: String
            if (m != null) {
                date = m.group(1)
                rawText = m.group(2)
            } else {
                date = null
                rawText = LEADING_BULLET.replaceFirst(line, "").jsTrimmed
            }
            val confidence = CONFIDENCE.group(rawText)?.toDoubleOrNull()
            val source = parseSourceComment(line)
            val withoutConfidence = CONFIDENCE_STRIP.replaceAll(rawText, "").jsTrimmed
            return ParsedQueueLine(date, normalizeQueueEntryText(withoutConfidence), confidence, source?.machine, source?.model)
        }

        /** The parsed queue text used as the FINDINGS.md match needle (access.ts:717,732). */
        fun findingsTextFor(lineText: String): String = parseQueueLine(lineText).text
    }
}
