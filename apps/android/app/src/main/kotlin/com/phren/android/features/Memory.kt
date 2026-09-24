package com.phren.android.features

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.android.AppTab
import com.phren.android.design.IconSegmentItem
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenActionSheet
import com.phren.android.design.PhrenChip
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenDialog
import com.phren.android.design.PhrenIconSegment
import com.phren.android.design.PhrenMultiSelect
import com.phren.android.design.PhrenMultiSelectSheet
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenOptionRow
import com.phren.android.design.PhrenSearchField
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PhrenType.semibold
import com.phren.android.design.SF
import com.phren.android.design.SectionLabel
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.design.sessionCard
import com.phren.android.design.tabBarSafeArea
import com.phren.kit.Finding
import com.phren.kit.GraphPayload
import com.phren.kit.LocalStore
import com.phren.kit.PendingOp
import com.phren.kit.PhrenTask
import com.phren.kit.SearchIndex
import com.phren.kit.TasksFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// MARK: Browsing model (MemoryBrowsing.swift, MemoryListModel.swift)

data class MemoryItem(
    val kind: Kind,
    val key: String,
    val storeId: String,
    val project: String,
    val text: String,
    val date: String?,
    val typeTag: String?,
    val section: PhrenTask.Section?,
    val detail: String?,
    val nodeID: String?,
    val finding: Finding?,
    val task: PhrenTask?,
) {
    enum class Kind(val raw: String) { FINDING("finding"), NOTE("note"), TASK("task"), TOPIC("topic"), PROJECT("project") }
    val id: String get() = "${kind.raw}:$key"
    val rowIdentifier: String get() = "memory-row:$id"
}

enum class MemoryKind(val raw: String, val itemKind: MemoryItem.Kind) {
    FINDINGS("Findings", MemoryItem.Kind.FINDING), NOTES("Notes", MemoryItem.Kind.NOTE),
    TASKS("Tasks", MemoryItem.Kind.TASK), TOPICS("Topics", MemoryItem.Kind.TOPIC);
    val id: String get() = raw.lowercase()
}

data class MemoryCounts(val findings: Int = 0, val notes: Int = 0, val tasks: Int = 0, val topics: Int = 0) {
    fun line(kinds: Set<MemoryKind>): String {
        val effective = kinds.ifEmpty { MemoryKind.entries.toSet() }
        val parts = buildList {
            if (MemoryKind.FINDINGS in effective) add(count(findings, "finding"))
            if (MemoryKind.TASKS in effective) add(count(tasks, "task"))
            if (MemoryKind.TOPICS in effective) add(count(topics, "topic"))
            if (isEmpty() && MemoryKind.NOTES in effective) add(count(notes, "note"))
        }
        return parts.joinToString(" · ")
    }
    private fun count(v: Int, noun: String) = "$v $noun${if (v == 1) "" else "s"}"
}

object MemoryBrowsing {
    class NodeIndex(payload: GraphPayload?) {
        private val byText = mutableMapOf<String, String>()
        private val ids = mutableSetOf<String>()
        init {
            payload?.nodes?.forEach { node ->
                ids += node.id
                byText.putIfAbsent("${node.project}\u0001${node.fullLabel}", node.id)
            }
        }
        fun contains(id: String) = id in ids
        fun nodeID(project: String, text: String) = byText["$project\u0001$text"]
    }

    fun displayText(f: Finding): String {
        val tag = f.typeTag ?: return f.text
        val prefix = "[$tag]"
        return if (f.text.lowercase().startsWith(prefix)) f.text.drop(prefix.length).trim(' ') else f.text
    }

    fun topicLabel(slug: String) = slug.replace("-", " ").split(" ").joinToString(" ") { w -> w.lowercase().replaceFirstChar { it.uppercase() } }

    fun taskText(t: PhrenTask) = TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(t.line))

    fun contents(snapshot: LocalStore.Snapshot, storeId: String, project: String?, nodes: NodeIndex): List<MemoryItem> {
        val projects = project?.let { listOf(it) } ?: snapshot.projects.map { it.name }.sorted()
        val findings = mutableListOf<Pair<String, MemoryItem>>()
        val notes = mutableListOf<Pair<String, MemoryItem>>()
        val tasks = mutableListOf<MemoryItem>()
        val topicCounts = sortedMapOf<String, Int>()
        for (name in projects) {
            for (f in snapshot.findings[name].orEmpty()) {
                if (f.archived) continue
                val text = displayText(f)
                val node = nodes.nodeID(name, text) ?: nodes.nodeID(name, f.text)
                findings += f.date to MemoryItem(MemoryItem.Kind.FINDING, f.stableId ?: "$name-${f.id}", storeId, name, text, f.date, f.typeTag, null, null, node, f, null)
                topicCounts[f.typeTag ?: "general"] = (topicCounts[f.typeTag ?: "general"] ?: 0) + 1
            }
            for (n in snapshot.notes[name].orEmpty()) {
                notes += "${n.date} ${n.time}" to MemoryItem(MemoryItem.Kind.NOTE, n.stableId, storeId, name, n.text, n.date, null, null, null, null, null, null)
            }
            val doc = snapshot.tasks[name] ?: continue
            for (t in doc.allItems) {
                val nodeID = "$name:task:${t.id}"
                tasks += MemoryItem(MemoryItem.Kind.TASK, t.stableId ?: "$name-${t.id}", storeId, name, taskText(t), t.createdAt?.take(10),
                    t.priority?.rawValue, t.section, null, if (nodes.contains(nodeID)) nodeID else null, null, t)
            }
        }
        fun newestFirst(dated: List<Pair<String, MemoryItem>>) = dated.withIndex()
            .sortedWith(compareByDescending<IndexedValue<Pair<String, MemoryItem>>> { it.value.first }.thenBy { it.index }).map { it.value.second }
        val topics = topicCounts.map { (slug, count) ->
            MemoryItem(MemoryItem.Kind.TOPIC, slug, storeId, project ?: "", topicLabel(slug), null, null, null, "$count finding${if (count == 1) "" else "s"}", null, null, null)
        }
        return newestFirst(findings) + newestFirst(notes) + tasks + topics
    }

    fun counts(items: List<MemoryItem>) = MemoryCounts(
        items.count { it.kind == MemoryItem.Kind.FINDING }, items.count { it.kind == MemoryItem.Kind.NOTE },
        items.count { it.kind == MemoryItem.Kind.TASK }, items.count { it.kind == MemoryItem.Kind.TOPIC },
    )

    fun filter(items: List<MemoryItem>, kinds: Set<MemoryKind>): List<MemoryItem> {
        if (kinds.isEmpty() || kinds == MemoryKind.entries.toSet()) return items.filter { it.kind != MemoryItem.Kind.PROJECT }
        val allowed = kinds.map { it.itemKind }.toSet()
        return items.filter { it.kind == MemoryItem.Kind.PROJECT || it.kind in allowed }
    }

    fun graphFilter(kinds: Set<MemoryKind>): GraphPayload.ContentFilter {
        val effective = kinds.ifEmpty { MemoryKind.entries.toSet() }
        val findings = MemoryKind.FINDINGS in effective || MemoryKind.TOPICS in effective
        val tasks = MemoryKind.TASKS in effective
        return when {
            findings && !tasks -> GraphPayload.ContentFilter.FINDINGS
            !findings && tasks -> GraphPayload.ContentFilter.TASKS
            else -> GraphPayload.ContentFilter.ALL
        }
    }

    fun results(hits: List<SearchIndex.Result>, graphMatches: List<GraphPayload.Node>, contents: List<MemoryItem>, storeId: String): List<MemoryItem> {
        val byKey = contents.associateBy { item ->
            val raw = when (item.kind) {
                MemoryItem.Kind.FINDING -> item.finding?.text ?: item.text
                MemoryItem.Kind.TASK -> item.task?.line ?: item.text
                else -> item.text
            }
            "${item.kind.raw}\u0001${item.project}\u0001$raw"
        }
        val seen = mutableSetOf<String>()
        val items = mutableListOf<MemoryItem>()
        for (hit in hits) {
            val kind = when (hit.kind) {
                SearchIndex.DocKind.FINDING -> MemoryItem.Kind.FINDING
                SearchIndex.DocKind.NOTE -> MemoryItem.Kind.NOTE
                SearchIndex.DocKind.TASK -> MemoryItem.Kind.TASK
                else -> continue
            }
            val item = byKey["${kind.raw}\u0001${hit.project}\u0001${hit.text}"] ?: continue
            if (seen.add(item.id)) items += item
        }
        for (node in graphMatches) {
            if (node.group != "project" || !seen.add("project:${node.id}")) continue
            val f = node.findingCount ?: 0; val t = node.taskCount ?: 0
            items += MemoryItem(MemoryItem.Kind.PROJECT, node.id, storeId, node.project, node.label, null, null, null,
                "$f finding${if (f == 1) "" else "s"} · $t task${if (t == 1) "" else "s"}", node.id, null, null)
        }
        return items
    }

    fun grouped(items: List<MemoryItem>): List<Pair<String, List<MemoryItem>>> = items.groupBy { it.project }.toList()

    fun scoped(contents: List<MemoryItem>, projects: Set<String>) =
        if (projects.isEmpty()) contents else contents.filter { it.kind == MemoryItem.Kind.TOPIC || it.project in projects }
}

/** The projects slice of one store's payload, keeping links whose endpoints survive. */
fun GraphPayload.keeping(projects: Set<String>): GraphPayload {
    val kept = nodes.filter { it.project in projects }
    val ids = kept.map { it.id }.toSet()
    return GraphPayload(kept, links.filter { it.source in ids && it.target in ids }, topics, kept.size)
}

private object MemorySettings {
    const val MODE = "memory.mode.v1"
    const val KINDS = "memory.kinds.v1"
    const val PROJECTS = "memory.projects.v1"
    fun decodeKinds(raw: String?) = raw.orEmpty().split(",").mapNotNull { r -> MemoryKind.entries.firstOrNull { it.raw == r } }.toSet().ifEmpty { MemoryKind.entries.toSet() }
    fun encodeKinds(k: Set<MemoryKind>) = k.map { it.raw }.sorted().joinToString(",")
    fun decodeProjects(raw: String?) = raw.orEmpty().split(",").filter { it.isNotEmpty() }.toSet()
    fun encodeProjects(p: Set<String>) = p.sorted().joinToString(",")
}

private class MemoryEdit(val title: String, val text: String, val save: suspend (String) -> Unit)
private class MemoryDeletion(val isTask: Boolean, val text: String, val run: suspend () -> Unit)

// MARK: View

@Composable
fun MemoryView() {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    var storeId by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf(model.prefs.getString(MemorySettings.MODE) ?: "map") }
    var kinds by remember { mutableStateOf(MemorySettings.decodeKinds(model.prefs.getString(MemorySettings.KINDS))) }
    var projectFilter by remember { mutableStateOf(MemorySettings.decodeProjects(model.prefs.getString(MemorySettings.PROJECTS))) }
    var showingSearch by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var payload by remember { mutableStateOf<GraphPayload?>(null) }
    var visible by remember { mutableStateOf<GraphPayload?>(null) }
    var nodes by remember { mutableStateOf(MemoryBrowsing.NodeIndex(null)) }
    var error by remember { mutableStateOf<String?>(null) }
    var selection by remember { mutableStateOf<GraphNodeRef?>(null) }
    var focusedNodeID by remember { mutableStateOf<String?>(null) }
    var command by remember { mutableStateOf<GraphCommand?>(null) }
    var rendererKey by remember { mutableStateOf(0) }
    var renderedScope by remember { mutableStateOf<String?>(null) }
    var results by remember { mutableStateOf<List<MemoryItem>>(emptyList()) }
    var highlightedID by remember { mutableStateOf<String?>(null) }
    var scrollTarget by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<MemoryEdit?>(null) }
    var deleting by remember { mutableStateOf<MemoryDeletion?>(null) }
    var actionItem by remember { mutableStateOf<MemoryItem?>(null) }
    var editingTask by remember { mutableStateOf<TaskListRow?>(null) }
    var kindsPresented by remember { mutableStateOf(false) }
    var projectsPresented by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }

    val selectedStore = storeId.ifEmpty { model.storeFilter ?: model.storeDescriptors.firstOrNull()?.id ?: "" }
    val snapshot = model.snapshot(selectedStore)
    val projects = snapshot.projects.map { it.name }.sorted()
    val trimmed = query.trim()
    val refreshProject = projectFilter.singleOrNull()
    val showsKindChips = kinds == MemoryKind.entries.toSet()

    fun setMode(value: String) {
        mode = value; model.prefs.putString(MemorySettings.MODE, value)
        if (value == "list") { selection = null; command = GraphCommand(GraphCommand.Action.Clear) }
    }
    fun setKinds(value: Set<MemoryKind>) { kinds = value; model.prefs.putString(MemorySettings.KINDS, MemorySettings.encodeKinds(value)) }
    fun setProjects(value: Set<String>) {
        projectFilter = value; model.prefs.putString(MemorySettings.PROJECTS, MemorySettings.encodeProjects(value))
        selection = null; focusedNodeID = null; highlightedID = null
    }
    fun openProject(store: String, project: String) = navigator.push("project:$store/$project") { ProjectDetailView(store, project) }

    // Pull the payload when the scope or the store's content changes.
    LaunchedEffect(selectedStore, refreshProject, snapshot.revision, rendererKey) {
        try {
            val next = model.graphPayload(selectedStore, refreshProject)
            payload = next
            val scope = "$selectedStore/${refreshProject ?: "*"}"
            if (focusedNodeID != null && next.nodes.none { it.id == focusedNodeID }) focusedNodeID = null
            if (renderedScope != scope) { command = GraphCommand(GraphCommand.Action.Reset); renderedScope = scope }
            selection = selection?.let { s -> next.nodes.firstOrNull { it.id == s.id }?.let { GraphNodeRef.of(it) } }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) { error = e.message }
    }
    LaunchedEffect(payload, kinds, focusedNodeID, projectFilter) {
        val p = payload ?: return@LaunchedEffect
        val filter = MemoryBrowsing.graphFilter(kinds)
        val focus = focusedNodeID
        val chosen = projectFilter
        val v = withContext(Dispatchers.Default) {
            val scoped = if (chosen.isEmpty()) p else p.keeping(chosen)
            val filtered = scoped.filtered(filter)
            focus?.let { filtered.neighborhood(it, 1) } ?: filtered
        }
        visible = v
        nodes = MemoryBrowsing.NodeIndex(v)
    }
    val contents = remember(selectedStore, snapshot.revision, nodes) { MemoryBrowsing.contents(snapshot, selectedStore, null, nodes) }
    LaunchedEffect(trimmed, selectedStore, refreshProject, model.searchRevision, nodes) {
        if (trimmed.isEmpty()) { results = emptyList(); return@LaunchedEffect }
        delay(120)
        val index = model.searchIndex
        val hits = withContext(Dispatchers.Default) { index.search(trimmed, selectedStore, refreshProject) }
        results = MemoryBrowsing.results(hits, visible?.search(trimmed).orEmpty(), contents, selectedStore)
    }
    LaunchedEffect(model.showingMemoryMaintenance) {
        if (!model.showingMemoryMaintenance) return@LaunchedEffect
        model.showingMemoryMaintenance = false
        model.selectedTab = AppTab.MEMORY
        navigator.popToRoot()
        navigator.push("maintenance") { MemoryMaintenanceView() }
    }

    val scopedContents = MemoryBrowsing.scoped(contents, projectFilter)
    val rows = if (trimmed.isEmpty()) MemoryBrowsing.filter(scopedContents, kinds) else results
    val grouped = projectFilter.size != 1
    val counts = MemoryBrowsing.counts(rows)
    val emptyText = when {
        trimmed.isNotEmpty() -> "No matches"
        scopedContents.isEmpty() -> refreshProject?.let { "Nothing saved for $it yet" } ?: "Nothing saved in $selectedStore yet"
        else -> "No rows for these filters"
    }

    fun selectNode(id: String) {
        val node = visible?.nodes?.firstOrNull { it.id == id } ?: return
        selection = GraphNodeRef.of(node)
        command = GraphCommand(GraphCommand.Action.Focus(node.id))
    }
    fun showOnMap(item: MemoryItem) { val id = item.nodeID ?: return; setMode("map"); selectNode(id) }
    fun open(item: MemoryItem) {
        highlightedID = null
        when (item.kind) {
            MemoryItem.Kind.TOPIC -> contents.firstOrNull { it.kind == MemoryItem.Kind.FINDING && (it.typeTag ?: "general") == item.key && it.nodeID != null }?.let { showOnMap(it) }
            MemoryItem.Kind.PROJECT -> if (item.nodeID != null) showOnMap(item)
            MemoryItem.Kind.NOTE -> openProject(item.storeId, item.project)
            MemoryItem.Kind.FINDING, MemoryItem.Kind.TASK -> if (item.nodeID != null) showOnMap(item) else openProject(item.storeId, item.project)
        }
    }
    fun taskRow(item: MemoryItem) = item.task?.let { TaskListRow(item.storeId, model.storeName(item.storeId), item.project, it) }
    fun move(item: MemoryItem, action: TaskMove) {
        val row = taskRow(item) ?: return
        if (moving) return
        moving = true
        model.scope.launch {
            try {
                if (!model.canWrite(row.storeId, row.project)) throw com.phren.android.StoreWriteError.ReadOnly(row.storeName)
                model.enqueue(action.operation(row), row.storeId)
            } catch (e: Exception) { model.lastActionError = e.message }
            model.refresh()
            moving = false
        }
    }
    fun edit(item: MemoryItem) {
        when (item.kind) {
            MemoryItem.Kind.TASK -> editingTask = taskRow(item)
            MemoryItem.Kind.FINDING -> {
                val f = item.finding ?: return
                editing = MemoryEdit("Edit finding", f.text) { text ->
                    model.performNow(PendingOp.EditFinding(item.project, f.stableId?.let { "fid:$it" } ?: f.text, text), item.storeId)
                    selection = null
                }
            }
            else -> {}
        }
    }
    fun confirmDelete(item: MemoryItem) {
        when (item.kind) {
            MemoryItem.Kind.TASK -> { val t = item.task ?: return
                deleting = MemoryDeletion(true, item.text) { model.performNow(PendingOp.RemoveTask(item.project, t.stableId ?: t.line), item.storeId); selection = null } }
            MemoryItem.Kind.FINDING -> { val f = item.finding ?: return
                deleting = MemoryDeletion(false, item.text) { model.performNow(PendingOp.RemoveFinding(item.project, f.stableId?.let { "fid:$it" } ?: f.text), item.storeId); selection = null } }
            else -> {}
        }
    }
    fun taskMatch(node: GraphNodeRef): String {
        val i = node.id.indexOf(":task:")
        return if (i < 0) node.fullLabel ?: node.text ?: "" else node.id.substring(i + 6)
    }
    fun editNode(node: GraphNodeRef) {
        contents.firstOrNull { it.nodeID == node.id }?.let { edit(it); return }
        val store = node.store ?: return; val project = node.project ?: return
        if (!node.isTask && !node.isFinding) return
        val match = node.fullLabel ?: node.text ?: ""
        editing = MemoryEdit(if (node.isTask) "Edit task" else "Edit finding", match) { text ->
            if (node.isTask) model.performNow(PendingOp.UpdateTask(project, taskMatch(node), text), store)
            else model.performNow(PendingOp.EditFinding(project, match, text), store)
            selection = null
        }
    }
    fun deleteNode(node: GraphNodeRef) {
        contents.firstOrNull { it.nodeID == node.id }?.let { confirmDelete(it); return }
        val store = node.store ?: return; val project = node.project ?: return
        if (!node.isTask && !node.isFinding) return
        val match = node.fullLabel ?: node.text ?: ""
        deleting = MemoryDeletion(node.isTask, match) {
            if (node.isTask) model.performNow(PendingOp.RemoveTask(project, taskMatch(node)), store)
            else model.performNow(PendingOp.RemoveFinding(project, match), store)
            selection = null
        }
    }
    fun showInList() {
        val selected = selection ?: return
        setMode("list"); selection = null; command = GraphCommand(GraphCommand.Action.Clear)
        query = ""; showingSearch = false; focusedNodeID = null
        val target = contents.firstOrNull { it.nodeID == selected.id } ?: return
        if (MemoryBrowsing.filter(scopedContents, kinds).none { it.id == target.id }) { setKinds(MemoryKind.entries.toSet()); setProjects(emptySet()) }
        highlightedID = target.id
        scrollTarget = target.id
    }

    PhrenNavScreen(
        "Memory",
        trailing = listOf(
            ToolbarItem(icon = SF("folder"), label = "Files", identifier = "memory-files", raised = true) { navigator.push("files") { FilesView() } },
            ToolbarItem(icon = SF("wrench.and.screwdriver"), label = "Memory maintenance", identifier = "memory-maintenance", raised = true) {
                navigator.push("maintenance") { MemoryMaintenanceView() }
            },
            ToolbarItem(icon = SF("magnifyingglass"), label = if (showingSearch) "Close search" else "Search memory", identifier = "memory-search-toggle", raised = true) {
                showingSearch = !showingSearch; if (!showingSearch) query = ""
            },
        ),
    ) {
        ActionErrorBanner()
        if (showingSearch) {
            PhrenSearchField(query, { query = it; if (it.isEmpty()) showingSearch = false }, placeholder = "Search memory", identifier = "memory-search",
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp).fillMaxWidth(),
                onSubmit = { if (trimmed.isEmpty()) showingSearch = false else if (mode == "map") visible?.search(trimmed)?.firstOrNull()?.let { selectNode(it.id) } })
        }
        Row(Modifier.padding(horizontal = 16.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.weight(1f)) {
                PhrenMultiSelect(MemoryKind.entries.map { PhrenOption(id = it.id, value = it, title = it.raw) }, kinds, "All kinds", "memory-kinds") { kindsPresented = true }
            }
            Box(Modifier.weight(1f)) {
                PhrenMultiSelect(projects.map { PhrenOption(id = it, value = it, title = it) }, projectFilter, "All projects", "memory-projects") { projectsPresented = true }
            }
            PhrenIconSegment(
                listOf(IconSegmentItem("map", SF("point.3.connected.trianglepath.dotted"), "Map"), IconSegmentItem("list", SF("list.bullet"), "List")),
                mode, ::setMode, identifier = { "memory-mode:$it" },
            )
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (mode == "map") Box(Modifier.fillMaxSize().tabBarSafeArea()) {
                val v = visible
                if (v != null && v.nodes.isNotEmpty() && error == null) {
                    androidx.compose.runtime.key(rendererKey) {
                        GraphWebView(v, command,
                            onSelect = { node ->
                                if (node == null) selection = null
                                else if (node.store == selectedStore && v.nodes.any { it.id == node.id }) selection = node
                            },
                            onAction = { action ->
                                when (action) {
                                    is GraphAction.Select -> selectNode(action.id)
                                    is GraphAction.Focus -> { focusedNodeID = action.id; selection = null; command = GraphCommand(GraphCommand.Action.Reveal(action.id)) }
                                    is GraphAction.OpenProject -> selection?.takeIf { it.id == action.id }?.let { s -> if (s.store != null && s.project != null) openProject(s.store, s.project) }
                                    is GraphAction.Share -> selection?.takeIf { it.id == action.id }?.let { s ->
                                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, s.sourceText ?: s.label ?: s.id), null))
                                    }
                                    is GraphAction.Edit -> selection?.takeIf { it.id == action.id }?.let { editNode(it) }
                                    is GraphAction.Delete -> selection?.takeIf { it.id == action.id }?.let { deleteNode(it) }
                                    GraphAction.Close -> selection = null
                                }
                            },
                            onError = { error = it },
                            modifier = Modifier.fillMaxSize().phrenIdentifier("memory-graph"))
                    }
                    CameraControls(Modifier.align(Alignment.TopEnd).padding(12.dp)) { command = GraphCommand(it) }
                    if (selection != null) {
                        Row(
                            Modifier.align(Alignment.TopStart).padding(12.dp).heightIn(min = 44.dp).background(PhrenTheme.surface.copy(alpha = 0.92f), CircleShape)
                                .plainClickable { showInList() }.phrenIdentifier("memory-show-in-list").padding(horizontal = 12.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(SF("list.bullet"), null, tint = PhrenTheme.accent, modifier = Modifier.size(13.dp))
                            Text("Show in list", style = PhrenType.subheadline.medium(), color = PhrenTheme.accent)
                        }
                    }
                } else if (v == null && error == null) {
                    CircularProgressIndicator(color = PhrenTheme.textMuted, strokeWidth = 2.dp, modifier = Modifier.align(Alignment.Center).size(24.dp))
                }
                error?.let { message ->
                    Column(Modifier.fillMaxSize().background(PhrenTheme.bg).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)) {
                        Text("Graph unavailable", style = PhrenType.subheadline.semibold(), color = PhrenTheme.text)
                        Text(message, style = PhrenType.caption, color = PhrenTheme.textMuted, textAlign = TextAlign.Center)
                        Text("Try again", style = PhrenType.body.medium(), color = PhrenTheme.accent,
                            modifier = Modifier.heightIn(min = 44.dp).background(PhrenTheme.surfaceRaised, CircleShape)
                                .plainClickable { error = null; rendererKey += 1 }.phrenIdentifier("memory-retry").padding(horizontal = 16.dp, vertical = 12.dp))
                    }
                }
            } else {
                MemoryPanel(rows, if (grouped) MemoryBrowsing.grouped(rows) else null, counts, kinds, showsKindChips, projectFilter.size != 1,
                    emptyText, highlightedID, scrollTarget, { scrollTarget = null }, ::open) { actionItem = it }
            }
        }
    }

    if (kindsPresented) PhrenMultiSelectSheet("Kinds", MemoryKind.entries.map { PhrenOption(id = it.id, value = it, title = it.raw) }, kinds, ::setKinds,
        rowPrefix = "memory-kind", requiresSelection = true) { kindsPresented = false }
    if (projectsPresented) PhrenMultiSelectSheet("Projects", projects.map { PhrenOption(id = it, value = it, title = it) }, projectFilter, ::setProjects,
        rowPrefix = "memory-project",
        leading = if (!model.hasMultipleStores) null else ({
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("Store")
                model.storeDescriptors.forEach { d ->
                    PhrenOptionRow(d.id, selected = d.id == selectedStore, mark = com.phren.android.design.OptionMark.CHECK, modifier = Modifier.phrenIdentifier("memory-store:${d.id}")) {
                        if (d.id != selectedStore) {
                            selection = null; focusedNodeID = null; highlightedID = null
                            storeId = d.id; setProjects(emptySet()); payload = null; visible = null; error = null
                        }
                    }
                }
                Box(Modifier.fillMaxWidth().heightIn(max = 0.5.dp).background(PhrenTheme.border))
            }
        }),
    ) { projectsPresented = false }

    actionItem?.let { item ->
        val writable = model.canWrite(item.storeId, item.project)
        val actions = buildList {
            if (item.nodeID != null) add(PhrenControlAction("graph", "Show on graph", SF("point.3.connected.trianglepath.dotted")) { open(item) })
            when (item.kind) {
                MemoryItem.Kind.TASK -> taskRow(item)?.let { row ->
                    add(PhrenControlAction("details", "Task details", SF("doc.text")) { navigator.push("task:${row.id}") { TaskDetailsView(row) { _, _ -> } } })
                    if (writable) {
                        TaskMove.entries.filter { it.section != row.task.section }.forEach { m -> add(PhrenControlAction(m.title.lowercase(), m.title, SF(m.symbol)) { move(item, m) }) }
                        add(PhrenControlAction("edit", "Edit", SF("pencil")) { edit(item) })
                        add(PhrenControlAction("delete", "Delete", SF("trash"), role = PhrenControlAction.Role.DESTRUCTIVE) { confirmDelete(item) })
                    }
                }
                MemoryItem.Kind.FINDING, MemoryItem.Kind.NOTE -> {
                    add(PhrenControlAction("project", "Open ${item.project}", SF("square.grid.2x2")) { openProject(item.storeId, item.project) })
                    if (writable && item.kind == MemoryItem.Kind.FINDING) {
                        add(PhrenControlAction("edit", "Edit", SF("pencil")) { edit(item) })
                        add(PhrenControlAction("delete", "Delete", SF("trash"), role = PhrenControlAction.Role.DESTRUCTIVE) { confirmDelete(item) })
                    }
                }
                else -> {}
            }
        }
        PhrenActionSheet(if (item.text.length > 80) item.text.take(77) + "..." else item.text, actions, identifier = "memory-actions") { actionItem = null }
    }
    deleting?.let { d ->
        PhrenDialog(if (d.isTask) "Delete this task?" else "Delete this finding?", d.text, listOf(
            PhrenControlAction("delete", "Delete", role = PhrenControlAction.Role.DESTRUCTIVE) { model.scope.launch { d.run() } },
            PhrenControlAction("keep", "Keep", role = PhrenControlAction.Role.CANCEL) {},
        ), identifier = "memory-delete") { deleting = null }
    }
    editing?.let { e -> PhrenSheet({ editing = null }) { TextEntrySheet(e.title, initialText = e.text, confirmLabel = "Save") { text, _ -> e.save(text) } } }
    editingTask?.let { row -> PhrenSheet({ editingTask = null }) { TaskEditSheet(row) } }
}

@Composable
private fun CameraControls(modifier: Modifier, send: (GraphCommand.Action) -> Unit) {
    val shape = RoundedCornerShape(PhrenTheme.Radius.large)
    Column(modifier.background(PhrenTheme.surface.copy(alpha = 0.92f), shape).border(1.dp, PhrenTheme.border, shape), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        listOf(Triple("Zoom in", "plus", GraphCommand.Action.ZoomIn), Triple("Zoom out", "minus", GraphCommand.Action.ZoomOut),
            Triple("Fit graph", "arrow.up.left.and.arrow.down.right", GraphCommand.Action.Reset)).forEach { (label, icon, action) ->
            Box(Modifier.size(44.dp).plainClickable { send(action) }.phrenIdentifier("memory-camera:$icon"), contentAlignment = Alignment.Center) {
                Icon(SF(icon), label, tint = PhrenTheme.text, modifier = Modifier.size(18.dp))
            }
        }
    }
}

// MARK: List mode (MemoryPanel.swift)

@Composable
private fun MemoryPanel(
    rows: List<MemoryItem>,
    groups: List<Pair<String, List<MemoryItem>>>?,
    counts: MemoryCounts,
    countKinds: Set<MemoryKind>,
    showKind: Boolean,
    showProject: Boolean,
    emptyText: String,
    highlightedID: String?,
    scrollTarget: String?,
    scrolled: () -> Unit,
    onSelect: (MemoryItem) -> Unit,
    onActions: (MemoryItem) -> Unit,
) {
    val listState = rememberLazyListState()
    val keys = buildList {
        add("counts")
        if (rows.isEmpty()) add("empty")
        else if (groups != null) groups.forEach { (p, r) -> add("section:$p"); r.forEach { add(it.id) } }
        else rows.forEach { add(it.id) }
    }
    LaunchedEffect(scrollTarget) {
        val target = scrollTarget ?: return@LaunchedEffect
        delay(60)
        val index = keys.indexOf(target)
        if (index >= 0) listState.animateScrollToItem(index)
        scrolled()
    }
    LazyColumn(Modifier.fillMaxSize().phrenIdentifier("memory-list"), state = listState,
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 110.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item(key = "counts") {
            Text(counts.line(countKinds), style = PhrenType.subheadline.semibold(), color = PhrenTheme.text, maxLines = 2,
                modifier = Modifier.fillMaxWidth().heightIn(min = 32.dp).padding(top = 6.dp).phrenIdentifier("memory-counts"))
        }
        if (rows.isEmpty()) item(key = "empty") {
            Text(emptyText, style = PhrenType.body, color = PhrenTheme.textMuted, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).phrenIdentifier("memory-empty"))
        } else if (groups != null) {
            groups.forEach { (project, items) ->
                item(key = "section:$project") { SectionLabel(project, Modifier.phrenIdentifier("memory-section:$project")) }
                items(items, key = { it.id }) { MemoryRowCard(it, showKind, showProject, highlightedID == it.id, { onSelect(it) }, { onActions(it) }) }
            }
        } else {
            items(rows, key = { it.id }) { MemoryRowCard(it, showKind, showProject, highlightedID == it.id, { onSelect(it) }, { onActions(it) }) }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun MemoryRowCard(item: MemoryItem, showKind: Boolean, showProject: Boolean, highlighted: Boolean, onSelect: () -> Unit, onActions: () -> Unit) {
    val hasActions = item.kind != MemoryItem.Kind.TOPIC
    val shape = RoundedCornerShape(PhrenTheme.Radius.medium)
    Box(Modifier.fillMaxWidth().sessionCard().then(if (highlighted) Modifier.border(2.dp, PhrenTheme.accent, shape) else Modifier)) {
        Column(
            Modifier.fillMaxWidth().heightIn(min = 44.dp)
                .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = { if (hasActions) onActions() }, onClick = onSelect)
                .phrenIdentifier(item.rowIdentifier)
                .padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = if (hasActions) 52.dp else 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(item.text, style = PhrenType.body, color = PhrenTheme.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val meta = showKind || item.kind == MemoryItem.Kind.TASK || item.typeTag != null ||
                (showProject && item.kind != MemoryItem.Kind.PROJECT && item.project.isNotEmpty()) || item.detail != null || item.date != null
            if (meta) Row(Modifier.heightIn(min = 28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (showKind || item.kind == MemoryItem.Kind.TASK) PhrenChip(kindTitle(item), color = kindColor(item))
                item.typeTag?.let { tag ->
                    PhrenChip(tag, color = if (item.kind == MemoryItem.Kind.TASK) (PhrenTask.Priority.from(tag)?.color ?: PhrenTheme.textDim) else PhrenTheme.chipColor(PhrenTheme.ChipRole.TYPE))
                }
                if (showProject && item.kind != MemoryItem.Kind.PROJECT && item.project.isNotEmpty()) PhrenChip(item.project, color = projectColor(item.storeId, item.project))
                item.detail?.let { Text(it, style = PhrenType.caption2, color = PhrenTheme.textMuted, maxLines = 1) }
                Spacer(Modifier.weight(1f))
                item.date?.let { Text(it, style = PhrenType.caption2, color = PhrenTheme.textDim) }
            }
        }
        if (hasActions) {
            Box(Modifier.align(Alignment.TopEnd).size(44.dp).plainClickable(onClick = onActions).phrenIdentifier("${item.rowIdentifier}:actions"), contentAlignment = Alignment.Center) {
                Icon(SF("ellipsis"), "Actions, ${item.text}", tint = PhrenTheme.accent, modifier = Modifier.size(18.dp))
            }
        }
    }
}

private fun kindTitle(item: MemoryItem) = when (item.kind) {
    MemoryItem.Kind.TASK -> when (item.section) { PhrenTask.Section.QUEUE -> "Backlog"; PhrenTask.Section.ACTIVE -> "Active"; PhrenTask.Section.DONE -> "Done"; null -> "Task" }
    else -> item.kind.raw
}

private fun kindColor(item: MemoryItem): Color = when (item.kind) {
    MemoryItem.Kind.FINDING -> PhrenTheme.warning
    MemoryItem.Kind.NOTE -> PhrenTheme.cyan
    MemoryItem.Kind.TASK -> if (item.section == PhrenTask.Section.DONE) PhrenTheme.textMuted else PhrenTheme.success
    MemoryItem.Kind.TOPIC -> PhrenTheme.lavender
    MemoryItem.Kind.PROJECT -> PhrenTheme.sessionProject
}


@Suppress("unused") private fun unused(m: AppModel) = m
