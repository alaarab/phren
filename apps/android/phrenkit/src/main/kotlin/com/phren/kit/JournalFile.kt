package com.phren.kit

/**
 * One team-store journal file: `<project>/journal/YYYY-MM-DD-<actor>.md`.
 * Port of JournalFile.swift, transcribing `appendTeamJournal` (journal.ts:150)
 * and `readTeamJournalEntries` (journal.ts:176). A `role: team` store never
 * line-splices FINDINGS.md on an add; it appends to a per-actor, per-day file
 * so git merges concurrent captures instead of conflicting.
 */
class JournalFile(val date: String, val actor: String, content: String? = null) {
    /** null means the file does not exist yet (decides whether to write the heading). */
    var content: String? = content
        private set

    val fileName: String get() = fileName(date, actor)

    fun path(project: String): String = path(project, date, actor)

    /** The raw entry strings, exactly what `readTeamJournalEntries` reports (journal.ts:201). */
    val entries: List<String>
        get() = (content ?: "").split("\n").filter { it.startsWith("- ") }.map { it.drop(2).jsTrimmed }

    /**
     * The file's entries as findings. `ids` continue from `idOffset` (`J…`) so
     * they never collide with FINDINGS.md's positional `L…` ids. Date and actor
     * come from the filename, the CLI's own source of truth (journal.ts:196).
     */
    fun findings(idOffset: Int = 0): List<Finding> =
        FindingsFile(content ?: "").parse().mapIndexed { index, parsed ->
            parsed.copy(
                id = "J${idOffset + index + 1}",
                date = date,
                actor = parsed.actor ?: actor,
                journalFile = fileName,
            )
        }

    /**
     * Appends one finding, byte-for-byte as `appendTeamJournal` writes it
     * (journal.ts:161-170). No dedup and no type auto-detection, matching the
     * CLI's team branch.
     */
    fun append(finding: String, machine: String? = null) {
        val sourceComment = buildSourceComment(FindingProvenance(source = "human", machine = machine, actor = actor))
        val entry = "- $finding${if (sourceComment.isEmpty()) "" else " $sourceComment"}\n"
        val existing = content
        content = if (existing != null) existing + entry else "## $date ($actor)\n\n$entry"
    }

    companion object {
        /** journal.ts:143 `TEAM_JOURNAL_DIR` */
        const val DIRECTORY_NAME = "journal"

        private val FILE_NAME = JSRegex("""^(\d{4}-\d{2}-\d{2})-(.+)\.md$""")
        private val UNSAFE = JSRegex("""[^a-zA-Z0-9._-]+""")
        private val EDGE_UNDERSCORES = JSRegex("""^_+|_+$""")
        private val TYPE_PREFIX = JSRegex("""^\s*\[[^\]]+\]\s*""")

        /** journal.ts:158 — `${date}-${resolvedActor}.md` */
        fun fileName(date: String, actor: String) = "$date-$actor.md"

        fun path(project: String, date: String, actor: String) = "$project/$DIRECTORY_NAME/${fileName(date, actor)}"

        /** journal.ts:196 — the authoritative date/actor split. */
        fun parseFileName(name: String): Pair<String, String>? {
            val m = FILE_NAME.firstMatch(name) ?: return null
            return m.group(1) to m.group(2)
        }

        /**
         * A filename component safe to put between the date and `.md`: the CLI's
         * own session-id sanitizer (journal.ts:36) applied to the actor slot.
         */
        fun sanitizeActor(actor: String?): String {
            val raw = (actor ?: "").jsTrimmed
            val safe = UNSAFE.replaceAll(raw, "_")
            val trimmed = EDGE_UNDERSCORES.replaceAll(safe, "")
            // machine-identity.ts:41 — `getCurrentActor` falls back to "unknown".
            return trimmed.ifEmpty { "unknown" }
        }

        /**
         * The bullet text an add would journal, with the type tag applied like
         * `applyFindingTypePrefix` (core/finding.ts:24). Stricter than the CLI's
         * team branch: the secret scan still runs.
         */
        fun preparedFinding(text: String, type: FindingType? = null): String {
            val trimmed = text.jsTrimmed
            if (trimmed.isEmpty()) throw PhrenKitError.EmptyInput("Finding text cannot be empty.")
            SecretScanner.scan(trimmed)?.let {
                throw PhrenKitError.SecretDetected("Rejected: finding appears to contain a secret ($it). Strip credentials before saving.")
            }
            if (type == null) return trimmed
            if (TYPE_PREFIX.test(trimmed)) return trimmed
            return "[${type.rawValue}] $trimmed"
        }
    }
}

/**
 * Reader for a project's `truths.md` (port of TruthsFile.swift). Written by
 * `upsertCanonical` (content/learning.ts:269) as `- <memory> _(added DATE)_`.
 * Read-only by construction.
 */
class TruthsFile(val content: String) {
    /** The pinned truths, in file order (newest first). */
    val truths: List<Truth>
        get() = content.split("\n").filter { it.startsWith("- ") }.mapNotNull(::parse)

    private fun parse(line: String): Truth? {
        val body = line.drop(2).jsTrimmed
        if (body.isEmpty()) return null
        val m = ADDED_SUFFIX.firstMatch(body) ?: return Truth(body, null)
        val text = body.substring(0, m.start()).jsTrimmed
        return if (text.isEmpty()) null else Truth(text, m.group(1))
    }

    private companion object {
        val ADDED_SUFFIX = JSRegex("""\s*_\(added\s+(\d{4}-\d{2}-\d{2})\)_\s*$""", caseInsensitive = true)
    }
}

/**
 * A parsed `reference/topics/<slug>.md`, the cold tier's on-disk shape
 * (`appendArchivedEntriesToTopicDoc`, project-topics.ts:799). Bullets are
 * parsed by [FindingsFile]; every entry is stamped `archived`, which keeps it
 * out of [SearchIndex] by construction.
 */
class TopicDocument(val project: String, val slug: String, content: String) {
    /** The document's own `# ` heading, or the slug when there is none. */
    val title: String = heading(content) ?: slug
    val entries: List<Finding> = FindingsFile(content).parse().map { it.copy(archived = true) }

    constructor(reference: ColdDocRef, content: String) : this(reference.project, reference.slug, content)

    /** Archived entries newest-day first. */
    val groupedByDate: List<Pair<String, List<Finding>>>
        get() {
            val groups = entries.groupBy { it.date }
            return groups.keys.sortedDescending().map { it to groups.getValue(it) }
        }

    private companion object {
        /** `# myproj - Build tooling` → `Build tooling`. */
        fun heading(content: String): String? {
            val line = content.split("\n").firstOrNull { it.startsWith("# ") } ?: return null
            val text = line.drop(2).jsTrimmed
            val sep = text.indexOf(" - ")
            if (sep < 0) return text.ifEmpty { null }
            val label = text.substring(sep + 3).jsTrimmed
            return label.ifEmpty { text }
        }
    }
}
