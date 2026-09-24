package com.phren.kit

/**
 * Parser + renderer for one day's notes file (`notes/YYYY-MM-DD.md`). Port of
 * NotesFile.swift, transcribing packages/cli/src/data/notes.ts. The CLI fully
 * re-renders this file on every mutation (`renderDailyFile`, notes.ts:115).
 * An empty file (last note removed) means "delete the file".
 */
class NotesFile(val project: String, val date: String, content: String?) {
    var notes: List<Note> = content?.let { parseDailyFile(it, project, date) } ?: emptyList()
        private set

    /** Returns null when no notes are left: the caller deletes the file (notes.ts:207). */
    fun render(): String? {
        if (notes.isEmpty()) return null
        val entries = notes.map { note ->
            val promoted = if (note.promoted) " <!-- promoted -->" else ""
            "## ${note.time} <!-- nid:${note.stableId} -->$promoted\n\n${note.text}"
        }
        return "# $project Notes — $date\n\n${entries.joinToString("\n\n")}\n"
    }

    // Mutations (notes.ts:163-225)

    fun add(text: String, time: String): Note {
        val normalized = normalizeNoteText(text)
        var stableId = FindingsFile.randomHexId()
        while (notes.any { it.stableId == stableId }) stableId = FindingsFile.randomHexId()
        val note = Note("nid:$stableId", stableId, project, date, time, normalized, false)
        notes = notes + note
        return note
    }

    private fun indexOf(stableId: String): Int {
        val idx = notes.indexOfFirst { it.stableId == stableId }
        if (idx < 0) throw PhrenKitError.NotFound("No note matching \"nid:$stableId\" was found.")
        return idx
    }

    private fun replaceAt(idx: Int, note: Note): Note {
        notes = notes.toMutableList().also { it[idx] = note }
        return note
    }

    fun edit(stableId: String, text: String): Note {
        val normalized = normalizeNoteText(text)
        val idx = indexOf(stableId)
        return replaceAt(idx, notes[idx].copy(text = normalized))
    }

    fun remove(stableId: String): Note {
        val idx = indexOf(stableId)
        val removed = notes[idx]
        notes = notes.toMutableList().also { it.removeAt(idx) }
        return removed
    }

    /**
     * notes.ts:223 `markNotePromoted`. Promotion is two files (core/note.ts:13):
     * the caller adds the finding first, then marks the note here; an
     * already-promoted note must be refused before the finding write.
     */
    fun markPromoted(stableId: String): Note {
        val idx = indexOf(stableId)
        if (notes[idx].promoted) throw PhrenKitError.Validation("Note nid:$stableId has already been promoted.")
        return replaceAt(idx, notes[idx].copy(promoted = true))
    }

    companion object {
        const val MAX_NOTE_LENGTH = 10_000

        // notes.ts:39 NOTE_HEADING_RE
        val headingRegex = JSRegex(
            """^##\s+(\d{2}:\d{2}(?::\d{2})?)\s+<!--\s*nid:([a-f0-9]{8})\s*-->(?:\s+<!--\s*promoted\s*-->)?\s*$""",
            caseInsensitive = true,
        )
        val promotedRegex = JSRegex("""<!--\s*promoted\s*-->""", caseInsensitive = true)
        private val CRLF = JSRegex("""\r\n?""")

        /** notes.ts:74 `parseDailyFile` */
        fun parseDailyFile(content: String, project: String, date: String): List<Note> {
            val items = mutableListOf<Note>()
            var stableId: String? = null
            var time = ""
            var promoted = false
            var body = mutableListOf<String>()

            fun finish() {
                val id = stableId ?: return
                val text = body.joinToString("\n").jsTrimmed
                if (text.isNotEmpty()) {
                    items += Note("nid:$id", id, project, date, if (time.length == 5) "$time:00" else time, text, promoted)
                }
            }

            for (line in content.split("\n")) {
                val m = headingRegex.firstMatch(line)
                if (m != null) {
                    finish()
                    stableId = m.group(2).lowercase()
                    time = m.group(1)
                    promoted = promotedRegex.test(line)
                    body = mutableListOf()
                } else if (stableId != null) {
                    body += line
                }
            }
            finish()
            return items
        }

        /** notes.ts:60 `normalizeNoteText` */
        fun normalizeNoteText(text: String): String {
            val normalized = CRLF.replaceAll(text, "\n").jsTrimmed
            if (normalized.isEmpty()) throw PhrenKitError.EmptyInput("Note text cannot be empty.")
            // UTF-16 length, like JS `.length` (notes.ts:63).
            if (normalized.length > MAX_NOTE_LENGTH) throw PhrenKitError.Validation("Note text exceeds $MAX_NOTE_LENGTH characters.")
            SecretScanner.scan(normalized)?.let {
                throw PhrenKitError.SecretDetected("Rejected: note appears to contain a secret ($it). Strip credentials before saving.")
            }
            // notes.ts:71 — a body line that would parse as a heading gets #-prefixed.
            return normalized.split("\n").joinToString("\n") { if (headingRegex.test(it)) "#$it" else it }
        }
    }
}
