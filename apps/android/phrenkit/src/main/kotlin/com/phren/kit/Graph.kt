package com.phren.kit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.security.MessageDigest
import java.util.UUID

/**
 * The memory graph handed to the shared web renderer
 * (packages/cli/browser/graph), built on the phone from the hot tier
 * (GraphPayload.swift). Field names are the renderer's contract.
 */
@Serializable
data class GraphPayload(
    val nodes: List<Node>,
    val links: List<Link>,
    val topics: List<Topic>,
    val total: Int,
) {
    @Serializable
    data class Node(
        val id: String,
        val label: String,
        val fullLabel: String,
        val group: String,
        val refCount: Int,
        val project: String,
        val store: String,
        val tagged: Boolean,
        val scoreKey: String? = null,
        val scoreKeys: List<String>? = null,
        val refDocs: List<RefDoc>? = null,
        val topicSlug: String? = null,
        val topicLabel: String? = null,
        val date: String? = null,
        val priority: String? = null,
        val section: String? = null,
        val findingCount: Int? = null,
        val taskCount: Int? = null,
        val labelCount: Int? = null,
    )

    @Serializable data class RefDoc(val doc: String, val project: String, val scoreKey: String? = null)
    @Serializable data class Link(val source: String, val target: String)
    @Serializable data class Topic(val slug: String, val label: String)

    @Serializable
    enum class ContentFilter(val rawValue: String) {
        @SerialName("All") ALL("All"), @SerialName("Findings") FINDINGS("Findings"), @SerialName("Tasks") TASKS("Tasks")
    }

    /** Sorted keys, nulls omitted — the JSONEncoder(.sortedKeys) shape. */
    fun jsonString(): String {
        val element = graphJson.encodeToJsonElement(serializer(), this)
        return graphJson.encodeToString(JsonElement.serializer(), sortKeys(element))
    }

    fun filtered(filter: ContentFilter): GraphPayload {
        val kept = nodes.filter { n ->
            filter == ContentFilter.ALL || n.group == "project" ||
                (filter == ContentFilter.FINDINGS && n.group.startsWith("topic:")) ||
                (filter == ContentFilter.TASKS && n.group.startsWith("task-"))
        }.map { n ->
            if (n.group != "project") n else n.copy(labelCount = if (filter == ContentFilter.TASKS) n.taskCount else n.findingCount)
        }
        val ids = kept.map { it.id }.toSet()
        return GraphPayload(kept, links.filter { it.source in ids && it.target in ids }, topics, kept.size)
    }

    fun search(query: String): List<Node> {
        val terms = query.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (terms.isEmpty()) return emptyList()
        return nodes.filter { n ->
            val text = "${n.fullLabel} ${n.project} ${n.topicLabel ?: ""}"
            terms.all { text.contains(it, ignoreCase = true) }
        }
    }

    fun neighborhood(nodeID: String, steps: Int = 1): GraphPayload {
        if (nodes.none { it.id == nodeID }) return this
        val available = nodes.map { it.id }.toSet()
        val neighbors = mutableMapOf<String, MutableSet<String>>()
        for (l in links) if (l.source in available && l.target in available) {
            neighbors.getOrPut(l.source) { mutableSetOf() } += l.target
            neighbors.getOrPut(l.target) { mutableSetOf() } += l.source
        }
        val included = mutableSetOf(nodeID)
        var frontier: Set<String> = included.toSet()
        repeat(steps.coerceIn(1, 2)) {
            val next = frontier.flatMap { neighbors[it] ?: emptySet() }.toSet() - included
            included += next
            frontier = next
        }
        val slice = nodes.filter { it.id in included }
        return GraphPayload(slice, links.filter { it.source in included && it.target in included }, topics, slice.size)
    }

    companion object {
        private val graphJson = Json { explicitNulls = false; encodeDefaults = false }

        private fun sortKeys(e: JsonElement): JsonElement = when (e) {
            is JsonObject -> JsonObject(e.toSortedMap().mapValues { sortKeys(it.value) })
            is kotlinx.serialization.json.JsonArray -> kotlinx.serialization.json.JsonArray(e.map(::sortKeys))
            else -> e
        }
    }
}

/** A named graph slice the user saved (GraphSavedView.swift). */
@Serializable
data class GraphSavedView(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val storeID: String,
    val project: String? = null,
    val filter: GraphPayload.ContentFilter,
    val nodeID: String? = null,
    val steps: Int = 1,
)

/** Builds [GraphPayload] from markdown, mirroring the CLI's graph builder. */
object GraphBuilder {
    data class Input(
        val findingsMarkdown: Map<String, String>,
        val tasks: Map<String, TaskDoc>,
        val projects: List<String>,
        val storeName: String,
        val journalFindings: Map<String, List<Finding>> = emptyMap(),
        val findingTotals: Map<String, Int> = emptyMap(),
    )

    private fun sha1Hex(text: String): String =
        MessageDigest.getInstance("SHA-1").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 0xFF) }

    fun entryScoreKey(project: String, filename: String, snippet: String): String {
        val short = snippet.replace(Regex("\\s+"), " ").take(200)
        return "$project/$filename:${sha1Hex("$project:$filename:$short").take(12)}"
    }

    fun findingStableId(scoreKey: String) = "finding:${sha1Hex(scoreKey).take(12)}"

    internal val taggedBullet = JSRegex("""^-\s+\[([a-z_-]+)\]\s+(.+?)(?:\s*<!--.*-->)?$""")
    internal val plainBullet = JSRegex("""^-\s+(.+?)(?:\s*<!--.*-->)?$""")
    private val dateHeading = JSRegex("""^##\s+(\d{4}-\d{2}-\d{2})""")
    private const val MIN_PLAIN_LENGTH = 10
    private const val MAX_TAGGED = 200
    private const val MAX_UNTAGGED = 100
    private const val MAX_TASKS = 50
    private val projectToken = JSRegex("""[a-z0-9_-]+""")

    internal fun truncate(text: String) = if (text.length > 55) "${text.take(52)}..." else text

    /** `slug.replacingOccurrences(of: "-", with: " ").capitalized` */
    private fun topicLabel(slug: String) =
        slug.replace("-", " ").split(" ").joinToString(" ") { w -> w.lowercase().replaceFirstChar { it.uppercase() } }

    fun build(input: Input, focusProject: String? = null): GraphPayload {
        val nodes = mutableListOf<GraphPayload.Node>()
        val links = mutableListOf<GraphPayload.Link>()
        val usedIds = mutableMapOf<String, Int>()
        val topics = mutableMapOf<String, String>()
        val findingCounts = mutableMapOf<String, Int>()
        val taskCounts = mutableMapOf<String, Int>()
        val projectSet = input.projects.toSet()
        val considered = focusProject?.let { listOf(it) } ?: input.projects
        val focused = focusProject != null

        fun uniqueId(id: String): String {
            val seen = usedIds[id] ?: 0
            usedIds[id] = seen + 1
            return if (seen == 0) id else "$id-${seen + 1}"
        }

        for (project in considered.sorted()) {
            val markdown = input.findingsMarkdown[project]
            nodes += GraphPayload.Node(project, project, project, "project", if (markdown == null) 0 else 1, project, input.storeName, false, findingCount = 0, taskCount = 0)
            var tagged = 0
            var untagged = 0
            var currentDate: String? = null
            for (line in (markdown ?: "").split("\n")) {
                dateHeading.group(line, 1)?.let { currentDate = it; null } ?: run {
                    val tag = taggedBullet.group(line, 1)
                    val text = (if (tag != null) taggedBullet.group(line, 2) else plainBullet.group(line, 1))?.trim(' ', '\t')
                    if (text.isNullOrEmpty()) return@run
                    val isTagged = tag != null
                    if (isTagged) { if (!focused && tagged >= MAX_TAGGED) return@run }
                    else {
                        if (text.length < MIN_PLAIN_LENGTH) return@run
                        if (!focused && untagged >= MAX_UNTAGGED) return@run
                    }
                    val snippet = tag?.let { "[$it] $text" } ?: text
                    val scoreKey = entryScoreKey(project, "FINDINGS.md", snippet)
                    val nodeId = uniqueId(findingStableId(scoreKey))
                    val slug = tag ?: "general"
                    topics.putIfAbsent(slug, topicLabel(slug))
                    if (isTagged) tagged++ else untagged++
                    nodes += GraphPayload.Node(
                        nodeId, truncate(text), text, "topic:$slug", if (isTagged) tagged else untagged, project, input.storeName, isTagged,
                        scoreKey = scoreKey, scoreKeys = listOf(scoreKey),
                        refDocs = listOf(GraphPayload.RefDoc("$project/FINDINGS.md", project, scoreKey)),
                        topicSlug = slug, topicLabel = topics[slug], date = currentDate,
                    )
                    links += GraphPayload.Link(project, nodeId)
                    exactProjectMentions(text, projectSet, project).forEach { links += GraphPayload.Link(project, it) }
                }
            }
            for (finding in input.journalFindings[project] ?: emptyList()) {
                val file = finding.journalFile
                if (finding.archived || file == null) continue
                if (!focused && tagged + untagged >= MAX_TAGGED + MAX_UNTAGGED) break
                val slug = finding.typeTag ?: "general"
                topics.putIfAbsent(slug, topicLabel(slug))
                val key = entryScoreKey(project, file, finding.rawLine)
                val id = uniqueId("journal:${findingStableId(key)}")
                nodes += GraphPayload.Node(
                    id, truncate(finding.text), finding.text, "topic:$slug", 0, project, input.storeName, finding.typeTag != null,
                    topicSlug = slug, topicLabel = topics[slug], date = finding.date,
                )
                links += GraphPayload.Link(project, id)
                if (finding.typeTag == null) untagged++ else tagged++
            }
            findingCounts[project] = tagged + untagged

            input.tasks[project]?.let { doc ->
                var count = 0
                for (section in listOf(PhrenTask.Section.ACTIVE, PhrenTask.Section.QUEUE)) {
                    val group = if (section == PhrenTask.Section.ACTIVE) "task-active" else "task-queue"
                    for (item in doc.items(section)) {
                        if (!focused && count >= MAX_TASKS) break
                        val scoreKey = entryScoreKey(project, "tasks.md", item.line)
                        val id = "$project:task:${item.id}"
                        nodes += GraphPayload.Node(
                            id, truncate(item.line), item.line, group, 0, project, input.storeName, false,
                            scoreKey = scoreKey, scoreKeys = listOf(scoreKey),
                            refDocs = listOf(GraphPayload.RefDoc("$project/tasks.md", project, scoreKey)),
                            priority = item.priority?.rawValue, section = item.section.rawValue,
                        )
                        links += GraphPayload.Link(project, id)
                        count++
                    }
                }
                taskCounts[project] = count
            }
        }

        val finalNodes = nodes.map { n ->
            if (n.group != "project") n
            else n.copy(
                findingCount = input.findingTotals[n.id] ?: findingCounts[n.id] ?: 0,
                taskCount = input.tasks[n.id]?.let { it.active.size + it.queue.size } ?: taskCounts[n.id] ?: 0,
            )
        }
        val ids = finalNodes.map { it.id }.toSet()
        return GraphPayload(
            finalNodes,
            links.filter { it.source in ids && it.target in ids },
            topics.map { GraphPayload.Topic(it.key, it.value) }.sortedBy { it.slug },
            finalNodes.size,
        )
    }

    fun findBulletText(project: String, scoreKey: String, findingsMarkdown: String): String? {
        for (line in findingsMarkdown.split("\n")) {
            val tag = taggedBullet.group(line, 1)
            val entry = if (tag != null) taggedBullet.group(line, 2)?.let { "[$tag] ${it.trim(' ', '\t')}" }
            else plainBullet.group(line, 1)?.trim(' ', '\t')
            if (entry.isNullOrEmpty()) continue
            if (entryScoreKey(project, "FINDINGS.md", entry) == scoreKey) return entry
        }
        return null
    }

    internal fun exactProjectMentions(text: String, projectSet: Set<String>, current: String): List<String> {
        val tokens = projectToken.allMatches(text.lowercase()).toSet()
        return projectSet.filter { it != current && it.lowercase() in tokens }.sorted()
    }
}
