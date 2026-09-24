package com.phren.kit

/**
 * Parser + renderer for a project's tasks.md (port of TasksFile.swift).
 *
 * Transcribes packages/cli/src/data/tasks.ts. The CLI fully re-renders
 * tasks.md on every mutation (`renderTask`, tasks.ts:332), so whole-file
 * re-serialization matches CLI behavior.
 */
class TasksFile(project: String, content: String?) {
    var doc: TaskDoc = if (content != null) parseTaskContent(project, content)
    else TaskDoc(project, "# $project tasks", emptyList(), emptyList(), emptyList())
        private set

    data class BidMetadata(
        val clean: String,
        val bid: String? = null,
        val rank: Int? = null,
        val lastActivity: String? = null,
        val createdAt: String? = null,
        val sessionId: String? = null,
        val scope: String? = null,
        val childFindings: List<String>? = null,
        val parentFinding: String? = null,
        val speculative: Boolean? = null,
    )

    data class Continuation(
        var context: String? = null,
        var githubIssue: Int? = null,
        var githubUrl: String? = null,
        var linesToSkip: Int = 0,
    )

    data class Updates(
        val text: String? = null,
        val priority: PhrenTask.Priority? = null,
        val section: PhrenTask.Section? = null,
    )

    fun render(): String {
        val out = mutableListOf(doc.title, "")
        for (section in SECTIONS) {
            out += "## ${section.rawValue}"
            out += ""
            for (item in doc.items(section)) {
                out += normalizeTaskItemLine(item)
                item.context?.let { out += "  Context: $it" }
                formatGitHubIssueReference(item)?.let { out += "  GitHub: $it" }
            }
            out += ""
        }
        return FindingsFile.normalizeWrite(out)
    }

    // Matching (tasks.ts:347 findItemByMatch)

    private fun findItem(match: String): Pair<PhrenTask.Section, Int> {
        val needle = match.jsTrimmed.lowercase()
        if (needle.isEmpty()) throw PhrenKitError.EmptyInput("Please provide the item text or ID to match against.")

        // 1a) Stable ID (bid:XXXX or bare 8-char hex)
        val bidNeedle = if (needle.startsWith("bid:")) needle.drop(4) else needle
        if (BID_NEEDLE.test(bidNeedle)) {
            for (section in SECTIONS) {
                val idx = doc.items(section).indexOfFirst { it.stableId == bidNeedle }
                if (idx >= 0) return section to idx
            }
        }
        // 1b) Positional ID (A1, Q2, D3)
        for (section in SECTIONS) {
            val idx = doc.items(section).indexOfFirst { it.id.lowercase() == needle }
            if (idx >= 0) return section to idx
        }
        // 2) Exact line match
        val exact = SECTIONS.flatMap { s ->
            doc.items(s).mapIndexedNotNull { i, item -> if (item.line.jsTrimmed.lowercase() == needle) s to i else null }
        }
        if (exact.size == 1) return exact[0]
        if (exact.size > 1) throw PhrenKitError.AmbiguousMatch("\"$match\" is ambiguous (${exact.size} exact matches). Use item ID.")
        // 3) Unique substring fallback
        val partial = SECTIONS.flatMap { s ->
            doc.items(s).mapIndexedNotNull { i, item -> if (item.line.lowercase().contains(needle)) s to i else null }
        }
        if (partial.size == 1) return partial[0]
        if (partial.size > 1) throw PhrenKitError.AmbiguousMatch("\"$match\" is ambiguous (${partial.size} partial matches). Use item ID.")
        throw PhrenKitError.NotFound("Item not found — no task matching \"$match\".")
    }

    private fun withSection(section: PhrenTask.Section, f: (MutableList<PhrenTask>) -> Unit) {
        val list = doc.items(section).toMutableList()
        f(list)
        doc = when (section) {
            PhrenTask.Section.ACTIVE -> doc.copy(active = list)
            PhrenTask.Section.QUEUE -> doc.copy(queue = list)
            PhrenTask.Section.DONE -> doc.copy(done = list)
        }
    }

    private fun removeItem(location: Pair<PhrenTask.Section, Int>): PhrenTask {
        lateinit var removed: PhrenTask
        withSection(location.first) { removed = it.removeAt(location.second) }
        return removed
    }

    private fun insertItem(item: PhrenTask, section: PhrenTask.Section, atFront: Boolean) {
        withSection(section) { if (atFront) it.add(0, item) else it.add(item) }
    }

    // Mutations (tasks.ts:485-735)

    /** tasks.ts:485 `addTask` — appends to Queue with a fresh bid. */
    fun add(item: String, createdAt: String? = null, sessionId: String? = null): PhrenTask {
        val line = LEADING_DASH.replaceFirst(item, "").jsTrimmed
        if (line.isEmpty()) throw PhrenKitError.EmptyInput("Task text cannot be empty.")
        val newItem = PhrenTask(
            id = "Q${doc.queue.size + 1}",
            stableId = FindingsFile.randomHexId(),
            section = PhrenTask.Section.QUEUE,
            line = line,
            checked = false,
            priority = normalizePriority(line),
            createdAt = createdAt ?: ISO8601Dates.string(java.time.Instant.now(), fractionalSeconds = true),
            sessionId = sessionId,
        )
        doc = doc.copy(queue = doc.queue + newItem)
        return newItem
    }

    /** tasks.ts:578 `completeTask` — moves to the top of Done, checked. */
    fun complete(match: String): PhrenTask {
        val item = removeItem(findItem(match)).copy(section = PhrenTask.Section.DONE, checked = true)
        insertItem(item, PhrenTask.Section.DONE, atFront = true)
        return item
    }

    /** tasks.ts:599 `removeTask` */
    fun remove(match: String): PhrenTask = removeItem(findItem(match))

    /**
     * tasks.ts:642 `updateTask`, limited to the fields the web UI sends
     * (text / priority / section — server.ts handlePostTaskUpdate).
     */
    fun update(match: String, updates: Updates): PhrenTask {
        val location = findItem(match)
        var item = doc.items(location.first)[location.second]
        updates.text?.let { text ->
            val nextText = text.jsTrimmed
            if (nextText.isEmpty()) throw PhrenKitError.EmptyInput("Task text cannot be empty.")
            item = item.copy(line = nextText, priority = normalizePriority(nextText), pinned = if (detectPinned(nextText)) true else null)
        }
        updates.priority?.let { priority ->
            item = item.copy(priority = priority, line = "${stripPriorityTag(item.line)} [${priority.rawValue}]")
        }
        // tasks.ts:720 — a section update always splices + unshifts into the
        // target, even when it's the same section.
        val target = updates.section
        if (target != null) {
            removeItem(location)
            item = item.copy(section = target, checked = target == PhrenTask.Section.DONE)
            insertItem(item, target, atFront = true)
        } else {
            val updated = item
            withSection(location.first) { it[location.second] = updated }
        }
        return item
    }

    companion object {
        private val SECTIONS = listOf(PhrenTask.Section.ACTIVE, PhrenTask.Section.QUEUE, PhrenTask.Section.DONE)

        // tasks.ts:18-20 — heading aliases
        val activeHeadings = setOf("active", "in progress", "in-progress", "current", "wip")
        val queueHeadings = setOf("queue", "queued", "task", "todo", "upcoming", "next")
        val doneHeadings = setOf("done", "completed", "finished", "archived")

        // tasks.ts:166 METADATA_PATTERN
        val metadataPattern = JSRegex(
            """\s*<!--\s*bid:([a-z0-9]{8})(?:\s+rank:(\d+))?(?:\s+lastActivity:([^\s>]+))?(?:\s+created:([^\s>]+))?(?:\s+session:([^\s>]+))?(?:\s+scope:([^\s>]+))?(?:\s+findings:((?:[a-z0-9]{8}(?::[a-z0-9]{8})?|fid:[a-z0-9]{8})(?:,[a-z0-9a-z:]{3,})*))?(?:\s+parentFinding:([^\s>]+))?(\s+speculative)?\s*-->""",
        )

        private val HEADING = JSRegex("""^##\s+(.+?)[\s]*$""")
        private val CHECKED = JSRegex("""^-\s*\[[xX]\]\s+""")
        private val CHECKBOX = JSRegex("""^-\s*\[[ xX]\]\s+""")
        private val LEADING_BULLET = JSRegex("""^-\s+""")
        private val LEADING_DASH = JSRegex("""^-\s*""")
        private val PINNED_STRIP = JSRegex("""\s*\[pinned\]""", caseInsensitive = true)
        private val PRIORITY_TAIL = JSRegex("""\[(high|medium|low)\]\s*$""", caseInsensitive = true)
        private val PRIORITY_TAG_ANCHORED = JSRegex("""\s*\[(high|medium|low)\](?=\s*(?:\[pinned\])?\s*$)""", caseInsensitive = true)
        private val MULTI_SPACE = JSRegex("""\s{2,}""")
        private val PINNED = JSRegex("""\[pinned\]""", caseInsensitive = true)
        private val GH_URL = JSRegex("""https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/(\d+)(?:[?#][^\s]*)?""")
        private val GH_NUM = JSRegex("""#?(\d+)""")
        private val PRIORITY_RUN = JSRegex("""(\s*\[(high|medium|low)\])+\s*$""", caseInsensitive = true)
        private val BID_NEEDLE = JSRegex("""^[a-f0-9]{8}$""")

        // Parse (tasks.ts:260 parseTaskContent)
        fun parseTaskContent(project: String, content: String): TaskDoc {
            val lines = content.split("\n")
            val title = if (lines.firstOrNull()?.jsTrimmed?.isNotEmpty() == true) lines[0].jsTrimmed else "# $project tasks"
            val items = SECTIONS.associateWith { mutableListOf<PhrenTask>() }
            val counters = SECTIONS.associateWith { 0 }.toMutableMap()
            var section = PhrenTask.Section.QUEUE
            var i = 0
            while (i < lines.size) {
                val line = lines[i]
                i++
                val heading = HEADING.group(line.jsTrimmed)
                if (heading != null) {
                    val token = heading.collapsedWhitespace.jsTrimmed.lowercase()
                    when (token) {
                        in activeHeadings -> section = PhrenTask.Section.ACTIVE
                        in queueHeadings -> section = PhrenTask.Section.QUEUE
                        in doneHeadings -> section = PhrenTask.Section.DONE
                    }
                    continue
                }
                if (!line.startsWith("- ")) continue

                val (checked, body) = stripBulletPrefix(line)
                val meta = stripBid(body)
                val continuation = parseContinuation(lines, i - 1)
                val prefix = when (section) {
                    PhrenTask.Section.ACTIVE -> "A"
                    PhrenTask.Section.QUEUE -> "Q"
                    PhrenTask.Section.DONE -> "D"
                }
                val n = counters.getValue(section) + 1
                counters[section] = n
                items.getValue(section) += PhrenTask(
                    id = "$prefix$n",
                    stableId = meta.bid,
                    section = section,
                    line = meta.clean,
                    checked = checked || section == PhrenTask.Section.DONE,
                    priority = normalizePriority(meta.clean),
                    context = continuation.context,
                    pinned = if (detectPinned(meta.clean)) true else null,
                    githubIssue = continuation.githubIssue,
                    githubUrl = continuation.githubUrl,
                    rank = meta.rank,
                    lastActivity = meta.lastActivity,
                    createdAt = meta.createdAt,
                    sessionId = meta.sessionId,
                    scope = meta.scope,
                    childFindings = meta.childFindings,
                    speculative = meta.speculative,
                    parentFinding = meta.parentFinding,
                )
                i += continuation.linesToSkip
            }
            // tasks.ts:319 — assign ranks to rank-less items
            SECTIONS.forEach { assignMissingRanks(items.getValue(it)) }
            return TaskDoc(
                project, title,
                items.getValue(PhrenTask.Section.ACTIVE),
                items.getValue(PhrenTask.Section.QUEUE),
                items.getValue(PhrenTask.Section.DONE),
            )
        }

        /** tasks.ts:86 `stripBulletPrefix` */
        fun stripBulletPrefix(line: String): Pair<Boolean, String> {
            val checked = CHECKED.test(line)
            var body = CHECKBOX.replaceFirst(line, "")
            body = LEADING_BULLET.replaceFirst(body, "")
            return checked to body.jsTrimmed
        }

        /** tasks.ts:174 `stripBid` */
        fun stripBid(text: String): BidMetadata {
            val m = metadataPattern.firstMatch(text) ?: return BidMetadata(clean = text)
            fun g(i: Int): String? = m.group(i)
            val childFindings = g(7)?.split(",")?.filter { it.isNotEmpty() }
            return BidMetadata(
                clean = trimEnd(metadataPattern.replaceFirst(text, "")),
                bid = g(1),
                rank = g(2)?.toIntOrNull(),
                lastActivity = g(3)?.ifEmpty { null },
                createdAt = g(4)?.ifEmpty { null },
                sessionId = g(5)?.ifEmpty { null },
                scope = g(6)?.ifEmpty { null },
                childFindings = childFindings?.ifEmpty { null },
                parentFinding = g(8)?.ifEmpty { null },
                speculative = if (g(9) != null) true else null,
            )
        }

        /** tasks.ts:59 `normalizePriority` */
        fun normalizePriority(text: String): PhrenTask.Priority? {
            val withoutPinned = PINNED_STRIP.replaceAll(text, "")
            return PRIORITY_TAIL.group(withoutPinned)?.let { PhrenTask.Priority.from(it.lowercase()) }
        }

        /** tasks.ts:65 `stripPriorityTag` — strips ALL trailing priority tags. */
        fun stripPriorityTag(text: String): String {
            var t = text
            do {
                val prev = t
                t = PRIORITY_TAG_ANCHORED.replaceAll(t, "")
            } while (t != prev)
            return MULTI_SPACE.replaceAll(t, " ").jsTrimmed
        }

        /** tasks.ts:78 `detectPinned` */
        fun detectPinned(text: String): Boolean = PINNED.test(text)

        /** tasks.ts:82 `stripPinnedTag` */
        fun stripPinnedTag(text: String): String = PINNED_STRIP.replaceAll(text, "").jsTrimmed

        /** tasks.ts:95 `parseGitHubIssueReference` */
        fun parseGitHubIssueReference(raw: String): Pair<Int?, String?> {
            val trimmed = raw.jsTrimmed
            if (trimmed.isEmpty()) return null to null
            val urlMatch = GH_URL.firstMatch(trimmed)
            val issue = if (urlMatch != null) urlMatch.group(1)?.toIntOrNull() else GH_NUM.group(trimmed)?.toIntOrNull()
            return issue to urlMatch?.group(0)
        }

        /** tasks.ts:126 `parseContinuation` */
        fun parseContinuation(lines: List<String>, idx: Int): Continuation {
            val result = Continuation()
            var cursor = idx + 1
            while (cursor < lines.size) {
                val raw = lines[cursor]
                cursor++
                if (!raw.startsWith("  ")) break
                val trimmed = raw.jsTrimmed
                if (trimmed.isEmpty()) { result.linesToSkip++; continue }
                if (trimmed.startsWith("Context:")) {
                    result.context = trimmed.removePrefix("Context:").jsTrimmed
                    result.linesToSkip++
                    continue
                }
                if (trimmed.startsWith("GitHub:")) {
                    val (issue, url) = parseGitHubIssueReference(trimmed.removePrefix("GitHub:"))
                    result.githubIssue = issue
                    result.githubUrl = url
                    result.linesToSkip++
                    continue
                }
                break
            }
            return result
        }

        /** tasks.ts:197 `assignMissingRanks` (stable sort, like JS Array.sort). */
        fun assignMissingRanks(items: MutableList<PhrenTask>) {
            val unranked = items.indices.filter { items[it].rank == null }
            if (unranked.isEmpty()) return
            val maxExisting = items.mapNotNull { it.rank }.maxOrNull() ?: 0
            fun order(idx: Int) = when (items[idx].priority) {
                PhrenTask.Priority.HIGH -> 0
                PhrenTask.Priority.MEDIUM -> 1
                PhrenTask.Priority.LOW -> 2
                null -> 3
            }
            var next = maxExisting + 1
            for (idx in unranked.sortedWith(compareBy({ order(it) }, { it }))) {
                items[idx] = items[idx].copy(rank = next++)
            }
        }

        // Render (tasks.ts:240 normalizeTaskItemLine, 332 renderTask)
        fun normalizeTaskItemLine(item: PhrenTask): String {
            var text = stripPinnedTag(item.line)
            text = PRIORITY_RUN.replaceAll(text, "").jsTrimmed
            item.priority?.let { text = "$text [${it.rawValue}]" }
            if (item.pinned == true) text = "$text [pinned]"
            val prefix = if (item.checked || item.section == PhrenTask.Section.DONE) "- [x] " else "- [ ] "
            val bid = item.stableId ?: FindingsFile.randomHexId()
            val meta = StringBuilder("bid:$bid")
            item.rank?.let { meta.append(" rank:$it") }
            item.lastActivity?.let { meta.append(" lastActivity:$it") }
            item.createdAt?.let { meta.append(" created:$it") }
            item.sessionId?.let { meta.append(" session:$it") }
            item.scope?.let { meta.append(" scope:$it") }
            item.childFindings?.takeIf { it.isNotEmpty() }?.let { meta.append(" findings:${it.joinToString(",")}") }
            item.parentFinding?.let { meta.append(" parentFinding:$it") }
            if (item.speculative == true) meta.append(" speculative")
            return "$prefix$text <!-- $meta -->"
        }

        /** tasks.ts:119 `formatGitHubIssueReference` */
        fun formatGitHubIssueReference(item: PhrenTask): String? = when {
            item.githubIssue != null && item.githubUrl != null -> "#${item.githubIssue} ${item.githubUrl}"
            item.githubIssue != null -> "#${item.githubIssue}"
            else -> item.githubUrl
        }
    }
}
