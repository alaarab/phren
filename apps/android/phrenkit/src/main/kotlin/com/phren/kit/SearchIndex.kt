package com.phren.kit

import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import kotlin.math.max

/**
 * On-device inverted index over live knowledge (port of SearchIndex.swift).
 * Archived (cold-tier) findings never enter it, matching the CLI.
 */
class SearchIndex private constructor(private val docs: List<Doc>) {
    enum class DocKind(val rawValue: String) { FINDING("finding"), NOTE("note"), TASK("task"), SUMMARY("summary"), TRUTH("truth") }

    data class Result(
        val id: String,
        val store: String,
        val project: String,
        val kind: DocKind,
        val text: String,
        val date: String?,
        val typeTag: String?,
        val score: Double,
    )

    private class Doc(
        val id: String,
        val store: String,
        val project: String,
        val kind: DocKind,
        val text: String,
        val date: String?,
        val typeTag: String?,
        val tokens: Map<String, Int>,
    )

    constructor() : this(emptyList())
    constructor(snapshot: LocalStore.Snapshot) : this(build(listOf("" to snapshot)))

    fun search(
        query: String,
        store: String? = null,
        project: String? = null,
        kind: DocKind? = null,
        typeTag: String? = null,
        limit: Int = 50,
    ): List<Result> {
        val queryTokens = tokenize(query)
        if (queryTokens.isEmpty()) return emptyList()
        val results = mutableListOf<Result>()
        for (doc in docs) {
            if (store != null && doc.store != store) continue
            if (project != null && doc.project != project) continue
            if (kind != null && doc.kind != kind) continue
            if (typeTag != null && doc.typeTag != typeTag) continue
            var score = 0.0
            var matchedAll = true
            for ((i, token) in queryTokens.withIndex()) {
                val isLast = i == queryTokens.size - 1
                val tf = doc.tokens[token]
                if (tf != null) score += tf
                else if (isLast && doc.tokens.keys.any { it.startsWith(token) }) score += 0.5
                else { matchedAll = false; break }
            }
            if (!matchedAll || score <= 0) continue
            // Recency boost: newer date headings rank higher.
            val date = doc.date
            if (date != null && date.length == 10) score += recencyBoost(date)
            results += Result(doc.id, doc.store, doc.project, doc.kind, doc.text, doc.date, doc.typeTag, score)
        }
        return results.sortedByDescending { it.score }.take(limit)
    }

    companion object {
        fun of(snapshots: List<Pair<String, LocalStore.Snapshot>>) = SearchIndex(build(snapshots))

        private fun build(snapshots: List<Pair<String, LocalStore.Snapshot>>): List<Doc> {
            val docs = mutableListOf<Doc>()
            fun add(id: String, store: String, project: String, kind: DocKind, text: String, date: String?, typeTag: String?) {
                docs += Doc(id, store, project, kind, text, date, typeTag, tokenFrequencies(text))
            }
            for ((store, snapshot) in snapshots) {
                for ((project, findings) in snapshot.findings) {
                    for (f in findings) if (!f.archived) {
                        add("f:$store:$project:${f.stableId ?: f.id}", store, project, DocKind.FINDING, f.text, f.date, f.typeTag)
                    }
                }
                for ((project, notes) in snapshot.notes) for (n in notes) {
                    add("n:$store:$project:${n.stableId}", store, project, DocKind.NOTE, n.text, n.date, null)
                }
                for ((project, taskDoc) in snapshot.tasks) for (t in taskDoc.allItems) {
                    add("t:$store:$project:${t.stableId ?: t.id}", store, project, DocKind.TASK, t.line, t.createdAt?.take(10), null)
                }
                // Truths are the most live knowledge in a store.
                for ((project, truths) in snapshot.truths) for (t in truths) {
                    add("p:$store:$project:${t.id}", store, project, DocKind.TRUTH, t.text, t.addedDate, null)
                }
                for ((project, summary) in snapshot.summaries) {
                    summary.split("\n\n").forEachIndexed { i, paragraph ->
                        val trimmed = paragraph.jsTrimmed
                        if (trimmed.isNotEmpty() && !trimmed.startsWith("#")) {
                            add("s:$store:$project:$i", store, project, DocKind.SUMMARY, trimmed, null, null)
                        }
                    }
                }
            }
            return docs
        }

        internal fun tokenize(text: String): List<String> {
            val out = mutableListOf<String>()
            val sb = StringBuilder()
            var i = 0
            val lower = text.lowercase()
            while (i < lower.length) {
                val cp = lower.codePointAt(i)
                if (Character.isLetterOrDigit(cp)) sb.appendCodePoint(cp)
                else {
                    if (sb.codePointCount(0, sb.length) >= 2) out += sb.toString()
                    sb.setLength(0)
                }
                i += Character.charCount(cp)
            }
            if (sb.codePointCount(0, sb.length) >= 2) out += sb.toString()
            return out
        }

        private fun tokenFrequencies(text: String): Map<String, Int> =
            tokenize(text).groupingBy { it }.eachCount()

        private fun recencyBoost(date: String): Double {
            val parsed = try { LocalDate.parse(date) } catch (_: Exception) { return 0.0 }
            val ageDays = max(0L, ChronoUnit.DAYS.between(parsed, LocalDate.now(ZoneOffset.UTC))).toDouble()
            return max(0.0, 2.0 - ageDays / 90.0)
        }
    }
}
