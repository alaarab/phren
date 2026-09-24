package com.phren.android.features

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.android.design.FormDivider
import com.phren.android.design.FormRow
import com.phren.android.design.FormSection
import com.phren.android.design.LocalDismiss
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenActionSheet
import com.phren.android.design.PhrenChip
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenEmptyState
import com.phren.android.design.PhrenFieldSurface
import com.phren.android.design.PhrenForm
import com.phren.android.design.PhrenIconButton
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenPlainList
import com.phren.android.design.PhrenRail
import com.phren.android.design.PhrenSearchField
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenSingleSelect
import com.phren.android.design.PhrenSingleSelectSheet
import com.phren.android.design.PhrenStepSlider
import com.phren.android.design.PhrenSwipeRow
import com.phren.android.design.PhrenSwitchRow
import com.phren.android.design.PhrenTextField
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PlainSectionLabel
import com.phren.android.design.SF
import com.phren.android.design.SwipeAction
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.design.separatedCard
import com.phren.android.design.sessionCard
import com.phren.kit.ISO8601Dates
import com.phren.kit.LocalStore
import com.phren.kit.PendingOp
import com.phren.kit.PhrenTask
import com.phren.kit.TasksFile
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

// MARK: Model (TasksModel.swift, TaskBrowsing.swift)

enum class TaskStatus(val raw: String, val title: String, val sections: List<PhrenTask.Section>, val emptyListTitle: String) {
    OPEN("open", "Open", listOf(PhrenTask.Section.ACTIVE, PhrenTask.Section.QUEUE), "No open tasks"),
    ACTIVE("active", "Active", listOf(PhrenTask.Section.ACTIVE), "No active tasks"),
    BACKLOG("backlog", "Backlog", listOf(PhrenTask.Section.QUEUE), "No backlog tasks"),
    DONE("done", "Done", listOf(PhrenTask.Section.DONE), "No completed tasks"),
    ALL("all", "All", listOf(PhrenTask.Section.ACTIVE, PhrenTask.Section.QUEUE, PhrenTask.Section.DONE), "No tasks");

    fun count(active: Int, queue: Int, done: Int) = when (this) {
        OPEN -> active + queue; ACTIVE -> active; BACKLOG -> queue; DONE -> done; ALL -> active + queue + done
    }

    companion object {
        fun of(section: PhrenTask.Section) = when (section) {
            PhrenTask.Section.ACTIVE -> ACTIVE; PhrenTask.Section.QUEUE -> BACKLOG; PhrenTask.Section.DONE -> DONE
        }
        fun from(raw: String?) = entries.firstOrNull { it.raw == raw } ?: OPEN
    }
}

enum class TaskSort(val raw: String) {
    MANUAL("Task order"), NEWEST("Newest first"), OLDEST("Oldest first"), PRIORITY("Priority");
    companion object { fun from(raw: String?) = entries.firstOrNull { it.raw == raw } ?: MANUAL }
}

enum class TaskAge(val raw: String) {
    ALL("Any age"), WEEK("Past 7 days"), MONTH("Past 30 days"), OLDER("30+ days old"), UNKNOWN("Date unknown");

    fun includes(date: Instant?, now: Instant): Boolean {
        if (this == ALL) return true
        if (this == UNKNOWN) return date == null
        if (date == null) return false
        val days = ChronoUnit.DAYS.between(date, now)
        return when (this) {
            WEEK -> !date.isAfter(now) && days < 7
            MONTH -> !date.isAfter(now) && days < 30
            OLDER -> days >= 30
            else -> false
        }
    }
}

data class TaskListRow(val storeId: String, val storeName: String, val project: String, val task: PhrenTask) {
    val id: String get() = "$storeId/$project/${task.stableId ?: task.id}"
    val displayLine: String get() = TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(task.line))
}

sealed interface TaskScope {
    data object All : TaskScope
    data class Project(val storeId: String, val project: String) : TaskScope
}

enum class TaskMove(val title: String, val symbol: String, val id: String, val section: PhrenTask.Section) {
    ACTIVE("Move to Active", "arrow.right", "move-active", PhrenTask.Section.ACTIVE),
    BACKLOG("Backlog", "tray", "backlog", PhrenTask.Section.QUEUE),
    DONE("Done", "checkmark", "done", PhrenTask.Section.DONE);

    fun operation(row: TaskListRow): PendingOp {
        val match = row.task.stableId ?: row.task.line
        return if (this == DONE) PendingOp.CompleteTask(row.project, match)
        else PendingOp.UpdateTask(row.project, match, section = section.rawValue)
    }
}

data class TaskMoveNotice(val destination: TaskStatus, val projects: Set<String>, val message: String, val id: String = java.util.UUID.randomUUID().toString()) {
    companion object {
        fun of(rows: List<TaskListRow>, section: PhrenTask.Section, status: TaskStatus): TaskMoveNotice? {
            val moved = rows.filter { it.task.section != section }
            if (moved.isEmpty() || section in status.sections) return null
            val destination = TaskStatus.of(section)
            return TaskMoveNotice(destination, moved.map { it.project }.toSet(),
                if (moved.size == 1) "Moved to ${destination.title}" else "${moved.size} tasks moved to ${destination.title}")
        }
    }
}

data class TaskSectionGroup(val project: String, val storeId: String, val rows: List<TaskListRow>, val activeCount: Int, val queueCount: Int, val doneCount: Int)

object TaskBrowsing {
    fun creationDate(value: String?): Instant? = ISO8601Dates.parse(value)

    private fun priorityRank(p: PhrenTask.Priority?) = when (p) { PhrenTask.Priority.HIGH -> 0; PhrenTask.Priority.MEDIUM -> 1; PhrenTask.Priority.LOW -> 2; null -> 3 }

    fun rows(rows: List<TaskListRow>, query: String, priority: PhrenTask.Priority?, age: TaskAge, sort: TaskSort, now: Instant = Instant.now()): List<TaskListRow> {
        val q = query.trim()
        return rows.map { it to creationDate(it.task.createdAt) }.filter { (row, date) ->
            (priority == null || row.task.priority == priority) && age.includes(date, now) &&
                (q.isEmpty() || listOf(row.task.line, row.task.context ?: "", row.project, row.task.stableId ?: "").any { it.contains(q, ignoreCase = true) })
        }.sortedWith { (l, ld), (r, rd) ->
            if (sort == TaskSort.NEWEST || sort == TaskSort.OLDEST) {
                when {
                    ld != null && rd != null && ld != rd -> return@sortedWith if (sort == TaskSort.NEWEST) rd.compareTo(ld) else ld.compareTo(rd)
                    ld != null && rd == null -> return@sortedWith -1
                    ld == null && rd != null -> return@sortedWith 1
                }
            }
            if (sort == TaskSort.PRIORITY) {
                val a = priorityRank(l.task.priority); val b = priorityRank(r.task.priority)
                if (a != b) return@sortedWith a.compareTo(b)
            }
            val lp = l.task.pinned ?: false; val rp = r.task.pinned ?: false
            if (sort == TaskSort.MANUAL && lp != rp) return@sortedWith if (lp) -1 else 1
            if (l.task.rank != r.task.rank) return@sortedWith (l.task.rank ?: Int.MAX_VALUE).compareTo(r.task.rank ?: Int.MAX_VALUE)
            l.id.compareTo(r.id)
        }.map { it.first }
    }

    fun rawRows(model: AppModel, section: PhrenTask.Section, scope: TaskScope, selectedProject: String?): List<TaskListRow> = when (scope) {
        is TaskScope.Project -> model.snapshot(scope.storeId).tasks[scope.project]?.items(section)
            ?.map { TaskListRow(scope.storeId, model.storeName(scope.storeId), scope.project, it) } ?: emptyList()
        TaskScope.All -> model.mergedTaskDocs.filter { selectedProject == null || it.doc.project == selectedProject }
            .flatMap { d -> d.doc.items(section).map { TaskListRow(d.storeId, d.storeName, d.doc.project, it) } }
    }

    fun groups(model: AppModel, visible: List<TaskListRow>, scope: TaskScope, selectedProject: String?, status: TaskStatus): List<TaskSectionGroup> {
        fun counts(section: PhrenTask.Section) = rawRows(model, section, scope, selectedProject).groupingBy { it.project }.eachCount()
        val active = counts(PhrenTask.Section.ACTIVE); val queue = counts(PhrenTask.Section.QUEUE); val done = counts(PhrenTask.Section.DONE)
        val storeByProject = model.mergedTaskDocs.groupBy { it.doc.project }.mapValues { (_, d) -> d.map { it.storeId }.sorted().firstOrNull() ?: "" }
        return visible.groupBy { it.project }.map { (project, rows) ->
            TaskSectionGroup(project, storeByProject[project] ?: rows.map { it.storeId }.sorted().first(), rows, active[project] ?: 0, queue[project] ?: 0, done[project] ?: 0)
        }.sortedWith(compareByDescending<TaskSectionGroup> { status.count(it.activeCount, it.queueCount, it.doneCount) }.thenBy { it.project })
    }
}

val PhrenTask.Priority.color: Color
    get() = when (this) { PhrenTask.Priority.HIGH -> PhrenTheme.red; PhrenTask.Priority.MEDIUM -> PhrenTheme.amber; PhrenTask.Priority.LOW -> PhrenTheme.textDim }

private val shortDate = DateTimeFormatter.ofPattern("MMM d, yyyy")
private val longDate = DateTimeFormatter.ofPattern("MMMM d, yyyy 'at' h:mm a")
fun Instant.short(): String = shortDate.format(atZone(ZoneId.systemDefault()))
fun Instant.long(): String = longDate.format(atZone(ZoneId.systemDefault()))

/** The instruction handed to an agent started from a task (TaskAgentRequest). */
data class TaskAgentRequest(val row: TaskListRow) {
    val title: String get() = row.displayLine
    val prompt: String get() = buildList {
        add("Work on this Phren task and continue until it is complete:")
        add("Store: ${row.storeId}\nProject: ${row.project}")
        add("Task:\n$title")
        row.task.context?.trim()?.takeIf { it.isNotEmpty() }?.let { add("Context:\n$it") }
    }.joinToString("\n\n")
}

// MARK: Views

@Composable
fun TasksView() {
    PhrenTaskScreen(TaskScope.All)
}

/** The Tasks tab root: its own bar with Select and +, then the list. */
@Composable
private fun PhrenTaskScreen(scope: TaskScope) {
    val state = rememberTaskListState(scope)
    PhrenNavScreen("Tasks", leading = state.leadingItems(), trailing = state.trailingItems()) {
        LiveStatusBar()
        ActionErrorBanner()
        TaskList(state)
    }
    state.Presentations()
}

/** A project's Tasks tab inside project detail. */
@Composable
fun TaskListView(storeId: String, project: String) {
    val state = rememberTaskListState(TaskScope.Project(storeId, project))
    Column(Modifier.fillMaxSize()) {
        // Project detail has no bar of its own for these; they sit above the list.
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            state.leadingItems().forEach { item ->
                Text(item.text ?: "", style = PhrenType.subheadline, color = PhrenTheme.accent,
                    modifier = Modifier.heightIn(min = 44.dp).plainClickable(item.enabled, onClick = item.onClick).phrenIdentifier(item.identifier ?: "").padding(horizontal = 8.dp, vertical = 12.dp))
            }
            Spacer(Modifier.weight(1f))
            state.trailingItems().forEach { item -> PhrenIconButton(item.icon!!, item.label, action = item.onClick) }
        }
        TaskList(state)
    }
    state.Presentations()
}

class TaskListState(val scope: TaskScope, val model: AppModel) {
    var selectedProject by mutableStateOf<String?>(null)
    var query by mutableStateOf("")
    var showSearch by mutableStateOf(false)
    var isSelecting by mutableStateOf(false)
    var selectedIDs by mutableStateOf(setOf<String>())
    var isMoving by mutableStateOf(false)
    var priority by mutableStateOf<PhrenTask.Priority?>(null)
    var age by mutableStateOf(TaskAge.ALL)
    var status by mutableStateOf(TaskStatus.from(model.prefs.getString("tasks.status")))
    var sort by mutableStateOf(TaskSort.from(model.prefs.getString("tasks.sort.v1")))
    var collapsed by mutableStateOf(model.prefs.getString(COLLAPSE_KEY)?.split("\n")?.filter { it.isNotEmpty() }?.toSet() ?: emptySet())
    var showAdd by mutableStateOf(false)
    var showStatus by mutableStateOf(false)
    var showFilters by mutableStateOf(false)
    var showSort by mutableStateOf(false)
    var actionRow by mutableStateOf<TaskListRow?>(null)
    var editing by mutableStateOf<TaskListRow?>(null)
    var launchingAgent by mutableStateOf<TaskListRow?>(null)
    var moveNotice by mutableStateOf<TaskMoveNotice?>(null)
    lateinit var openDetails: (TaskListRow) -> Unit

    val isProjectScoped get() = scope is TaskScope.Project
    val isReadOnlyScope get() = (scope as? TaskScope.Project)?.let { LocalStore.isReadOnlyProject(it.project) } ?: false
    val hasFilters get() = query.isNotBlank() || priority != null || age != TaskAge.ALL || (!isProjectScoped && (selectedProject != null || model.storeFilter != null))

    fun chooseStatus(value: TaskStatus) {
        status = value; model.prefs.putString("tasks.status", value.raw)
        selectedIDs = emptySet()
        moveNotice?.let { if (it.destination.sections.all { s -> s in value.sections }) moveNotice = null }
    }
    fun chooseSort(value: TaskSort) { sort = value; model.prefs.putString("tasks.sort.v1", value.raw) }
    fun fold(value: Set<String>) { collapsed = value; model.prefs.putString(COLLAPSE_KEY, value.sorted().joinToString("\n")) }
    fun toggleSection(project: String) = fold(if (project in collapsed) collapsed - project else collapsed + project)

    fun rows(status: TaskStatus = this.status) =
        TaskBrowsing.rows(status.sections.flatMap { TaskBrowsing.rawRows(model, it, scope, selectedProject) }, query, priority, age, sort)
    fun backlogCount() = TaskBrowsing.rows(TaskBrowsing.rawRows(model, PhrenTask.Section.QUEUE, scope, selectedProject), query, priority, age, sort).size
    val addTargets get() = model.writableProjects
    fun canWrite(row: TaskListRow) = !isMoving && model.canWrite(row.storeId, row.project)
    fun currentWritableRows() = rows().filter { model.canWrite(it.storeId, it.project) }

    fun clearFilters() {
        query = ""; priority = null; age = TaskAge.ALL
        if (!isProjectScoped) { selectedProject = null; model.storeFilter = null }
    }

    fun select(row: TaskListRow) {
        if (isMoving || !model.canWrite(row.storeId, row.project)) return
        selectedIDs = if (row.id in selectedIDs) selectedIDs - row.id else selectedIDs + row.id
    }

    fun move(rows: List<TaskListRow>, action: TaskMove) {
        val moving = rows.filter { it.task.section != action.section }
        if (isMoving || moving.isEmpty()) return
        isMoving = true
        val wasSelecting = isSelecting
        model.scope.launch {
            val failed = mutableSetOf<String>()
            var message: String? = null
            for (row in moving) {
                try {
                    if (!model.canWrite(row.storeId, row.project)) throw com.phren.android.StoreWriteError.ReadOnly(row.storeName)
                    model.enqueue(action.operation(row), row.storeId)
                } catch (e: Exception) { failed += row.id; message = e.message }
            }
            model.refresh()
            selectedIDs = failed
            model.lastActionError = message?.let { "${failed.size} task(s) couldn't move. $it" }
            isMoving = false
            moveNotice = TaskMoveNotice.of(moving.filter { it.id !in failed }, action.section, status)
            if (wasSelecting && failed.isEmpty()) isSelecting = false
        }
    }

    fun start(row: TaskListRow) {
        if (isMoving || selectedIDs.size > 1) return
        val current = currentWritableRows().firstOrNull { it.id == row.id } ?: return
        if (!current.task.checked) launchingAgent = current
    }

    fun delete(row: TaskListRow) = model.perform(PendingOp.RemoveTask(row.project, row.task.stableId ?: row.task.line), row.storeId)

    fun taskMoved(row: TaskListRow, section: PhrenTask.Section) { moveNotice = TaskMoveNotice.of(listOf(row), section, status) }

    fun leadingItems(): List<ToolbarItem> = if (isReadOnlyScope) emptyList() else listOf(
        ToolbarItem(text = if (isSelecting) "Cancel" else "Select", label = if (isSelecting) "Cancel" else "Select", identifier = "task-selection-mode",
            enabled = !isMoving && (isSelecting || rows().any { model.canWrite(it.storeId, it.project) })) {
            isSelecting = !isSelecting; selectedIDs = emptySet()
        },
    )

    fun trailingItems(): List<ToolbarItem> = if (isReadOnlyScope || isSelecting) emptyList() else listOf(
        ToolbarItem(icon = SF("plus"), label = "Add task", identifier = "task-add", enabled = isProjectScoped || addTargets.isNotEmpty()) { showAdd = true },
    )

    @Composable
    fun Presentations() {
        if (showAdd) PhrenSheet({ showAdd = false }) { AddTaskSheet(scope, addTargets.map { Triple(it.storeId, it.storeName, it.project.name) }) }
        editing?.let { row -> PhrenSheet({ editing = null }) { TaskEditSheet(row, ::taskMoved) } }
        launchingAgent?.let { row -> PhrenSheet({ launchingAgent = null }) { LiveBridge.LaunchSessionView(row.storeId, row.project, TaskAgentRequest(row)) } }
        if (showStatus) PhrenSingleSelectSheet("Task status", TaskStatus.entries.map { PhrenOption(id = it.raw, value = it, title = it.title) }, status, ::chooseStatus, rowPrefix = "tasks-status") { showStatus = false }
        if (showSort) PhrenSingleSelectSheet("Sort tasks", TaskSort.entries.map { PhrenOption(id = it.raw, value = it, title = it.raw) }, sort, ::chooseSort, rowPrefix = "task-sort") { showSort = false }
        if (showFilters) PhrenActionSheet("Task filters", filterActions(), identifier = "task-filters-sheet") { showFilters = false }
        actionRow?.let { row -> PhrenActionSheet("Task actions", rowActions(row), identifier = "task-actions-sheet") { actionRow = null } }
    }

    private fun filterActions(): List<PhrenControlAction> = buildList {
        add(PhrenControlAction("any-priority", "Any priority", SF("flag"), isSelected = priority == null) { priority = null })
        PhrenTask.Priority.entries.forEach { v -> add(PhrenControlAction("priority-${v.rawValue}", v.rawValue.replaceFirstChar { it.uppercase() }, SF("flag"), isSelected = priority == v) { priority = v }) }
        TaskAge.entries.forEach { v -> add(PhrenControlAction("age-${v.raw}", v.raw, SF("calendar"), isSelected = age == v) { age = v }) }
        if (!isProjectScoped) {
            add(PhrenControlAction("all-projects", "All projects", SF("square.grid.2x2"), isSelected = selectedProject == null) { selectedProject = null })
            model.mergedTaskDocs.map { it.doc.project }.toSortedSet().forEach { name ->
                add(PhrenControlAction("project-$name", name, SF("square.grid.2x2"), isSelected = selectedProject == name) { selectedProject = name })
            }
            if (model.hasMultipleStores) {
                add(PhrenControlAction("all-stores", "All stores", SF("externaldrive"), isSelected = model.storeFilter == null) { model.storeFilter = null })
                model.storeDescriptors.forEach { d -> add(PhrenControlAction("store-${d.id}", d.displayName, SF("externaldrive"), isSelected = model.storeFilter == d.id) { model.storeFilter = d.id }) }
            }
        }
        if (hasFilters) add(PhrenControlAction("clear", "Clear filters", SF("xmark.circle")) { clearFilters() })
    }

    private fun rowActions(row: TaskListRow): List<PhrenControlAction> {
        if (isSelecting || isMoving || !model.canWrite(row.storeId, row.project)) return emptyList()
        return buildList {
            if (!row.task.checked) add(PhrenControlAction("start", "Start", SF("play"), caption = "Start an agent on this task") { start(row) })
            TaskMove.entries.filter { it.section != row.task.section }.forEach { a -> add(PhrenControlAction(a.id, a.title, SF(a.symbol)) { move(listOf(row), a) }) }
            add(PhrenControlAction("edit", "Edit", SF("pencil")) { editing = row })
            add(PhrenControlAction("delete", "Delete", SF("trash"), role = PhrenControlAction.Role.DESTRUCTIVE) { delete(row) })
        }
    }

    companion object { const val COLLAPSE_KEY = "tasks.collapsed.v1" }
}

@Composable
private fun rememberTaskListState(scope: TaskScope): TaskListState {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val state = remember(scope) { TaskListState(scope, model) }
    state.openDetails = { row -> navigator.push("task:${row.id}") { TaskDetailsView(row, state::taskMoved) } }
    val notice = state.moveNotice
    LaunchedEffect(notice?.id, state.editing, state.launchingAgent) {
        if (notice == null || state.editing != null || state.launchingAgent != null) return@LaunchedEffect
        delay(10_000)
        if (state.moveNotice?.id == notice.id) state.moveNotice = null
    }
    return state
}

@Composable
private fun ColumnScope.TaskList(state: TaskListState) {
    val model = LocalModel.current
    // Reading every store's revision recomputes the rows when anything syncs.
    model.storeContexts.forEach { it.snapshot.revision }
    val visible = state.rows()
    val visibleIds = visible.map { it.id }.toSet()
    if (!state.selectedIDs.all { it in visibleIds }) state.selectedIDs = state.selectedIDs intersect visibleIds
    val writable = visible.filter { model.canWrite(it.storeId, it.project) }

    Controls(state, visible.size, writable.count { it.project !in state.collapsed })
    state.moveNotice?.let { MoveNoticeLine(state, it) }
    if (state.showSearch && !state.isSelecting) {
        PhrenSearchField(state.query, { state.query = it }, placeholder = "Search tasks", identifier = "task-search-field",
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 6.dp).fillMaxWidth())
    }
    Box(Modifier.weight(1f)) {
        Refreshable {
            PhrenPlainList(bottomPadding = if (state.isSelecting) 20.dp else 110.dp) {
                item { Spacer(Modifier.height(8.dp)) }
                when {
                    visible.isNotEmpty() && !state.isProjectScoped && state.selectedProject == null -> {
                        val groups = TaskBrowsing.groups(model, visible, state.scope, state.selectedProject, state.status)
                        item(key = "all") { AllSectionsControl(state, groups) }
                        groups.forEach { group ->
                            item(key = "h:${group.project}") { SectionHeader(state, group) }
                            if (group.project !in state.collapsed) taskRows(state, group.rows)
                        }
                    }
                    visible.isNotEmpty() -> {
                        item(key = "status") { PlainSectionLabel(state.status.title) }
                        taskRows(state, visible)
                    }
                    state.status == TaskStatus.ACTIVE && !state.hasFilters -> item {
                        FormSection(modifier = Modifier.padding(horizontal = 16.dp)) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Icon(SF("checkmark.circle"), null, tint = PhrenTheme.success, modifier = Modifier.size(26.dp))
                                Text("No active tasks", style = PhrenType.headline, color = PhrenTheme.text)
                                Text("Start work from your backlog, or add a task.", style = PhrenType.subheadline, color = PhrenTheme.textMuted)
                            }
                            val backlog = state.backlogCount()
                            if (backlog > 0) {
                                FormDivider(16.dp)
                                FormRow("View backlog ($backlog)", titleColor = PhrenTheme.accent, chevron = false) { state.chooseStatus(TaskStatus.BACKLOG) }
                            }
                        }
                    }
                }
            }
        }
        if (visible.isEmpty() && (state.status != TaskStatus.ACTIVE || state.hasFilters)) {
            PhrenEmptyState(
                if (state.hasFilters) "No matching tasks" else state.status.emptyListTitle,
                when {
                    state.hasFilters -> "Try another filter or task status."
                    !state.isProjectScoped && state.addTargets.isEmpty() -> "No writable store yet. Your GitHub token needs Contents: Read and write on the store repo before you can add tasks."
                    else -> "Add a task with the + button."
                },
                Modifier.fillMaxSize(),
            ) { if (state.hasFilters) Text("Clear filters", style = PhrenType.body, color = PhrenTheme.accent, modifier = Modifier.plainClickable { state.clearFilters() }.padding(8.dp)) }
        }
    }
    if (state.isSelecting) SelectionActions(state, visible)
}

@Composable
private fun Controls(state: TaskListState, visibleCount: Int, writableCount: Int) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) {
            PhrenSingleSelect(TaskStatus.entries.map { PhrenOption(id = it.raw, value = it, title = it.title) }, state.status,
                placeholder = "Task status", identifier = "tasks-status", enabled = !state.isMoving) { state.showStatus = true }
        }
        Text(if (state.isSelecting) "${state.selectedIDs.size}/$visibleCount" else "$visibleCount", style = PhrenType.subheadline, color = PhrenTheme.textMuted,
            modifier = Modifier.padding(horizontal = 8.dp))
        if (state.isSelecting) {
            Text(if (state.selectedIDs.size == writableCount) "Deselect all" else "Select all", style = PhrenType.subheadline, color = PhrenTheme.accent,
                modifier = Modifier.heightIn(min = 44.dp).plainClickable(!state.isMoving) {
                    val rows = state.currentWritableRows().filter { it.project !in state.collapsed }
                    state.selectedIDs = if (state.selectedIDs.size == rows.size) emptySet() else rows.map { it.id }.toSet()
                }.padding(horizontal = 8.dp, vertical = 12.dp))
        } else {
            BarGlyph(SF("magnifyingglass"), if (state.showSearch) "Hide task search" else "Search tasks", "task-search-toggle") {
                state.showSearch = !state.showSearch; if (!state.showSearch) state.query = ""
            }
            BarGlyph(SF(if (state.hasFilters) "line.3.horizontal.decrease.circle.fill" else "line.3.horizontal.decrease"),
                if (state.hasFilters) "Task filters, applied" else "Task filters", "task-filters") { state.showFilters = true }
            BarGlyph(SF("arrow.up.arrow.down"), "Sort tasks, ${state.sort.raw}", "task-sort") { state.showSort = true }
        }
    }
}

@Composable
private fun BarGlyph(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, id: String, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).plainClickable(onClick = onClick).phrenIdentifier(id).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = PhrenTheme.accent, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun AllSectionsControl(state: TaskListState, groups: List<TaskSectionGroup>) {
    val visible = groups.map { it.project }.toSet()
    val allFolded = visible.isNotEmpty() && visible.all { it in state.collapsed }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).plainClickable {
            state.fold(if (allFolded) state.collapsed - visible else state.collapsed + visible)
        }.phrenIdentifier("tasks-section-all"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("ALL", style = PhrenType.sectionLabel, color = PhrenTheme.textMuted, modifier = Modifier.padding(start = 14.dp).weight(1f))
        Icon(SF("chevron.down"), null, tint = PhrenTheme.textDim, modifier = Modifier.padding(end = 14.dp).size(14.dp).rotate(if (allFolded) -90f else 0f))
    }
}

@Composable
private fun SectionHeader(state: TaskListState, group: TaskSectionGroup) {
    val folded = group.project in state.collapsed
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(top = 10.dp).plainClickable { state.toggleSection(group.project) }
            .phrenIdentifier("tasks-section-toggle:${group.project}"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(group.project.uppercase(), style = PhrenType.sectionLabel, color = projectColor(group.storeId, group.project), modifier = Modifier.padding(start = 14.dp))
        val s = state.status.sections
        if (PhrenTask.Section.ACTIVE in s && group.activeCount > 0) PhrenChip("${group.activeCount} active", color = PhrenTheme.success)
        if (PhrenTask.Section.QUEUE in s && group.queueCount > 0) PhrenChip("${group.queueCount} queue", color = PhrenTheme.textSecondary)
        if (PhrenTask.Section.DONE in s && group.doneCount > 0) PhrenChip("${group.doneCount} done", color = PhrenTheme.textMuted)
        Spacer(Modifier.weight(1f))
        Icon(SF("chevron.down"), null, tint = PhrenTheme.textDim, modifier = Modifier.padding(end = 14.dp).size(14.dp).rotate(if (folded) -90f else 0f))
    }
}

private fun LazyListScope.taskRows(state: TaskListState, rows: List<TaskListRow>) {
    items(rows, key = { it.id }) { row -> TaskCard(state, row) }
}

@Composable
private fun TaskCard(state: TaskListState, row: TaskListRow) {
    val model = LocalModel.current
    val canWrite = state.canWrite(row)
    val swipes = canWrite && !state.isSelecting
    PhrenSwipeRow(
        leading = if (!swipes) emptyList() else buildList {
            if (!row.task.checked) add(SwipeAction("Start", SF("play"), PhrenTheme.accent) { state.start(row) })
            if (row.task.section != PhrenTask.Section.DONE) add(SwipeAction("Done", SF("checkmark"), PhrenTheme.success) { state.move(listOf(row), TaskMove.DONE) })
        },
        trailing = if (!swipes) emptyList() else buildList {
            add(SwipeAction("Delete", SF("trash"), Color(0xFFFF453A), destructive = true) { state.delete(row) })
            add(SwipeAction("Edit", SF("pencil"), PhrenTheme.accent) { state.editing = row })
            if (row.task.section != PhrenTask.Section.QUEUE) add(SwipeAction("Backlog", SF("tray"), PhrenTheme.textDim) { state.move(listOf(row), TaskMove.BACKLOG) })
        },
    ) {
        Box(Modifier.separatedCard().sessionCard()) {
            TaskRowContent(state, row, canWrite, model.hasMultipleStores)
            row.task.priority?.let { PhrenRail(it.color, Modifier.align(Alignment.CenterStart).padding(vertical = 10.dp).height(60.dp)) }
            if (swipes) {
                Box(Modifier.align(Alignment.CenterEnd).padding(end = 4.dp)) {
                    PhrenIconButton(SF("ellipsis"), "Task actions", modifier = Modifier.phrenIdentifier("task-actions:${row.id}")) { state.actionRow = row }
                }
            }
        }
    }
}

@Composable
private fun TaskRowContent(state: TaskListState, row: TaskListRow, canWrite: Boolean, multipleStores: Boolean) {
    val done = row.task.section == PhrenTask.Section.DONE
    val selection = if (state.isSelecting) row.id in state.selectedIDs else null
    val glyph = selection?.let { if (it) "checkmark.circle.fill" else "circle" } ?: if (done) "checkmark.circle" else "circle"
    val caption = if (done) {
        (TaskBrowsing.creationDate(row.task.lastActivity) ?: TaskBrowsing.creationDate(row.task.createdAt))?.let { "Done " + it.short() } ?: "Date unknown"
    } else TaskBrowsing.creationDate(row.task.createdAt)?.let { "Created " + it.short() } ?: "Date unknown"
    Row(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(SF(glyph), if (selection != null) (if (selection) "Deselect task" else "Select task") else if (row.task.checked) "Reopen task" else "Complete task",
            tint = if (selection != null) PhrenTheme.accent else PhrenTheme.textMuted,
            modifier = Modifier.size(24.dp).plainClickable(canWrite) {
                if (state.isSelecting) state.select(row) else state.move(listOf(row), if (row.task.checked) TaskMove.ACTIVE else TaskMove.DONE)
            }.phrenIdentifier("task-select:${row.id}"))
        Column(
            Modifier.weight(1f).plainClickable { if (state.isSelecting) state.select(row) else state.openDetails(row) }.phrenIdentifier("task-detail:${row.id}"),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(inlineMarkdown(row.displayLine), style = PhrenType.callout, color = if (done) PhrenTheme.textMuted else PhrenTheme.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
                textDecoration = if (row.task.checked) TextDecoration.LineThrough else null)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (!state.isProjectScoped) TagChip(row.project, PhrenTheme.ChipRole.PROJECT)
                if (!state.isProjectScoped && multipleStores) TagChip(row.storeId, PhrenTheme.ChipRole.STORE)
                row.task.priority?.let { TagChip(it.rawValue, color = it.color) }
                if (row.task.pinned == true) Icon(SF("pin.fill"), null, tint = Color(0xFFFF9F0A), modifier = Modifier.size(11.dp))
                row.task.githubIssue?.let { Text("#$it", style = PhrenType.caption2, color = PhrenTheme.textSecondary) }
            }
            Text(caption, style = PhrenType.caption2, color = PhrenTheme.textMuted)
        }
    }
}

@Composable
private fun MoveNoticeLine(state: TaskListState, notice: TaskMoveNotice) {
    Row(Modifier.fillMaxWidth().background(PhrenTheme.surface).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(notice.message, style = PhrenType.caption, color = PhrenTheme.textSecondary, modifier = Modifier.weight(1f).phrenIdentifier("task-move-notice"))
        Text("View ${notice.destination.title}", style = PhrenType.subheadline, color = PhrenTheme.accent,
            modifier = Modifier.padding(vertical = 4.dp).heightIn(min = 44.dp).background(PhrenTheme.surfaceRaised, CircleShape)
                .plainClickable {
                    state.chooseStatus(notice.destination)
                    state.fold(state.collapsed - notice.projects)
                    state.selectedIDs = emptySet(); state.isSelecting = false; state.moveNotice = null
                }.phrenIdentifier("task-move-follow").padding(horizontal = 12.dp, vertical = 12.dp))
    }
}

@Composable
private fun SelectionActions(state: TaskListState, visible: List<TaskListRow>) {
    Column(Modifier.fillMaxWidth().background(PhrenTheme.surface).padding(horizontal = 12.dp).padding(bottom = 96.dp)) {
        val single = if (state.selectedIDs.size == 1) visible.firstOrNull { it.id in state.selectedIDs } else null
        if (single != null && !single.task.checked) {
            com.phren.android.design.PhrenRow(SF("play"), "Start", chevron = false, enabled = !state.isMoving, modifier = Modifier.phrenIdentifier("task-bulk-Start")) { state.start(single) }
        }
        Row {
            TaskMove.entries.forEach { action ->
                val enabled = state.selectedIDs.isNotEmpty() && !state.isMoving && state.status.sections != listOf(action.section)
                Row(
                    Modifier.weight(1f).heightIn(min = 44.dp).plainClickable(enabled) {
                        state.move(state.currentWritableRows().filter { it.id in state.selectedIDs }, action)
                    }.phrenIdentifier("task-bulk-${action.title}"),
                    horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                ) {
                    val c = if (enabled) PhrenTheme.accent else PhrenTheme.textDim
                    Icon(SF(action.symbol), null, tint = c, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(action.title, style = PhrenType.subheadline.medium(), color = c, maxLines = 1)
                }
            }
        }
    }
}

// MARK: Sheets and details

@Composable
fun AddTaskSheet(scope: TaskScope, targets: List<Triple<String, String, String>>) {
    val model = LocalModel.current
    val dismiss = LocalDismiss.current ?: {}
    var text by remember { mutableStateOf("") }
    var target by remember { mutableStateOf<Triple<String, String, String>?>(null) }
    var picking by remember { mutableStateOf(false) }
    val fixed = (scope as? TaskScope.Project)?.let { it.storeId to it.project } ?: targets.singleOrNull()?.let { it.first to it.third }
    val resolved = fixed ?: target?.let { it.first to it.third }
    fun label(t: Triple<String, String, String>) = if (model.hasMultipleStores) "${t.third} · ${t.second}" else t.third
    val options = listOf(PhrenOption<Triple<String, String, String>?>(id = "none", value = null, title = "Choose…")) +
        targets.map { PhrenOption<Triple<String, String, String>?>(id = "${it.first}|${it.third}", value = it, title = label(it)) }
    Column {
        PhrenNavBar("Add to Backlog", inSheet = true,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", onClick = dismiss)),
            trailing = listOf(ToolbarItem(text = "Add", label = "Add", bold = true, enabled = text.isNotBlank() && resolved != null, identifier = "add-task-confirm") {
                val (storeId, project) = resolved ?: return@ToolbarItem
                model.perform(PendingOp.AddTask(project, text), storeId)
                dismiss()
            }))
        PhrenForm {
            FormSection {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    PhrenTextField("Task", text, { text = it }, identifier = "add-task-text", multiline = true, minLines = 2, surface = PhrenFieldSurface.BARE)
                }
            }
            if (fixed == null) FormSection {
                Box(Modifier.padding(16.dp)) { PhrenSingleSelect(options, target, placeholder = "Project", identifier = "add-task-project") { picking = true } }
            }
        }
    }
    if (picking) PhrenSingleSelectSheet("Project", options, target, { target = it }, rowPrefix = "add-task-project") { picking = false }
}

@Composable
fun TaskEditSheet(row: TaskListRow, onMoved: ((TaskListRow, PhrenTask.Section) -> Unit)? = null) {
    val model = LocalModel.current
    val dismiss = LocalDismiss.current ?: {}
    var text by remember { mutableStateOf(row.displayLine) }
    var priority by remember { mutableStateOf(row.task.priority) }
    var section by remember { mutableStateOf(row.task.section) }
    var pinned by remember { mutableStateOf(row.task.pinned ?: false) }
    var picking by remember { mutableStateOf(false) }
    val sectionOptions = PhrenTask.Section.entries.map { PhrenOption(id = it.rawValue.lowercase(), value = it, title = if (it == PhrenTask.Section.QUEUE) "Backlog" else it.rawValue) }
    Column {
        PhrenNavBar("Edit task", inSheet = true,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", onClick = dismiss)),
            trailing = listOf(ToolbarItem(text = "Save", label = "Save", bold = true, enabled = text.isNotBlank(), identifier = "task-edit-save") {
                // TasksFile.update recomputes `pinned` from the text, so the tag goes back on.
                val newText = text.trim() + if (pinned) " [pinned]" else ""
                val newSection = if (section != row.task.section) section else null
                val p = priority
                model.scope.launch {
                    try {
                        model.enqueue(PendingOp.UpdateTask(row.project, row.task.stableId ?: row.task.line, newText, p?.rawValue, newSection?.rawValue), row.storeId)
                        model.lastActionError = null
                        model.refresh()
                        if (newSection != null) onMoved?.invoke(row, newSection)
                    } catch (e: Exception) { model.lastActionError = e.message }
                }
                dismiss()
            }))
        PhrenForm {
            FormSection {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    PhrenTextField("Task", text, { text = it }, identifier = "task-edit-text", multiline = true, minLines = 2, surface = PhrenFieldSurface.BARE)
                }
                FormDivider(16.dp)
                Box(Modifier.padding(horizontal = 16.dp)) { PhrenSwitchRow("Pinned", pinned, { pinned = it }) }
                FormDivider(16.dp)
                Box(Modifier.padding(16.dp)) {
                    PhrenStepSlider(listOf(PhrenOption<PhrenTask.Priority?>(id = "none", value = null, title = "none")) +
                        PhrenTask.Priority.entries.map { PhrenOption<PhrenTask.Priority?>(id = it.rawValue, value = it, title = it.rawValue) }, priority, { priority = it }, identifier = "task-priority")
                }
                FormDivider(16.dp)
                Box(Modifier.padding(16.dp)) { PhrenSingleSelect(sectionOptions, section, placeholder = "Section", identifier = "task-section") { picking = true } }
            }
        }
    }
    if (picking) PhrenSingleSelectSheet("Section", sectionOptions, section, { section = it }, rowPrefix = "task-section") { picking = false }
}

/** Reading a long task never opens an editor or changes its state (TaskDetailsSheet). */
@Composable
fun TaskDetailsView(initial: TaskListRow, onMoved: (TaskListRow, PhrenTask.Section) -> Unit) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var editing by remember { mutableStateOf(false) }
    var launching by remember { mutableStateOf(false) }
    val task = model.snapshot(initial.storeId).tasks[initial.project]?.allItems?.firstOrNull {
        initial.task.stableId?.let { id -> it.stableId == id } ?: (it.id == initial.task.id)
    } ?: initial.task
    val row = initial.copy(task = task)
    PhrenNavScreen("Task details", onBack = navigator::pop,
        trailing = if (model.canWrite(row.storeId, row.project)) listOf(ToolbarItem(text = "Edit", label = "Edit", identifier = "task-details-edit") { editing = true }) else emptyList()) {
        PhrenForm {
            if (!row.task.checked) FormSection("Agent", footer = "Choose a computer and harness. Phren sends this task to the new agent and marks backlog work active after delivery succeeds.") {
                FormRow("Start an agent on this task", icon = SF("sparkles"), identifier = "task-start-agent") { launching = true }
            }
            FormSection {
                SelectionContainer { Text(inlineMarkdown(row.displayLine), style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.padding(16.dp)) }
            }
            row.task.context?.let { ctx ->
                FormSection("Context") { SelectionContainer { Text(inlineMarkdown(ctx), style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.padding(16.dp)) } }
            }
            FormSection {
                val fields = buildList {
                    add("Project" to row.project)
                    add("Store" to row.storeId)
                    add("Status" to if (row.task.section == PhrenTask.Section.QUEUE) "Backlog" else row.task.section.rawValue)
                    add("Created" to (TaskBrowsing.creationDate(row.task.createdAt)?.long() ?: "Date unknown"))
                    row.task.priority?.let { add("Priority" to it.rawValue) }
                }
                com.phren.android.design.FormRows(fields.size, inset = 16.dp) { i -> FormRow(fields[i].first, value = fields[i].second, chevron = false) }
            }
        }
    }
    if (editing) PhrenSheet({ editing = false }) { TaskEditSheet(row, onMoved) }
    if (launching) PhrenSheet({ launching = false }) { LiveBridge.LaunchSessionView(row.storeId, row.project, TaskAgentRequest(row)) }
}
