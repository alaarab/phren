package com.phren.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.FilterAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.kit.PendingOp
import com.phren.kit.PhrenTask
import com.phren.kit.TasksFile

sealed interface TaskScope {
    data object All : TaskScope
    data class Project(val storeId: String, val project: String) : TaskScope
}

data class TaskListRow(val storeId: String, val storeName: String, val project: String, val task: PhrenTask) {
    val id: String get() = "$storeId/$project/${task.stableId ?: task.id}"
}

/** The Tasks tab root (TasksView.swift): the whole store's tasks. */
@Composable
fun TasksScreen(model: AppModel) {
    var showAdd by remember { mutableStateOf(false) }
    var selectedProject by rememberSaveable { mutableStateOf<String?>(null) }
    val addTargets = model.writableProjects
    val projectNames = model.mergedTaskDocs.map { it.doc.project }.toSortedSet().toList()
    IosScreen(
        "Tasks", large = true,
        leading = {
            IosFilterMenu(
                Icons.Outlined.FilterAlt,
                listOf(
                    listOf(MenuItemSpec("All projects", selectedProject == null) { selectedProject = null }) +
                        projectNames.map { n -> MenuItemSpec(n, selectedProject == n) { selectedProject = n } },
                    if (model.hasMultipleStores) listOf(MenuItemSpec("All stores", model.storeFilter == null) { model.storeFilter = null }) +
                        model.storeDescriptors.map { d -> MenuItemSpec(d.displayName, model.storeFilter == d.id) { model.storeFilter = d.id } } else emptyList(),
                ),
            )
        },
        trailing = {
            ToolbarButton(ToolbarAction(icon = Icons.Filled.Add, contentDescription = "Add task", enabled = addTargets.isNotEmpty()) { showAdd = true })
        },
    ) {
        LiveStatusBar(model)
        ActionErrorBanner(model)
        TaskListView(model, TaskScope.All, showAdd, { showAdd = false }, selectedProject)
    }
}

@Composable
fun TaskListView(model: AppModel, scope: TaskScope, showAdd: Boolean, closeAdd: () -> Unit, selectedProject: String? = null) {
    // Done is collapsed by default; its header keeps a live count.
    var doneExpanded by rememberSaveable { mutableStateOf(false) }
    var editing by remember { mutableStateOf<TaskListRow?>(null) }
    val isProjectScoped = scope is TaskScope.Project

    fun rows(section: PhrenTask.Section): List<TaskListRow> {
        val result = mutableListOf<TaskListRow>()
        when (scope) {
            is TaskScope.Project -> model.snapshot(scope.storeId).tasks[scope.project]?.items(section)?.forEach {
                // Project scope reads the store's snapshot directly — the global
                // store filter must not blank out a project-detail tab.
                result += TaskListRow(scope.storeId, model.storeName(scope.storeId), scope.project, it)
            }
            TaskScope.All -> model.mergedTaskDocs.forEach { d ->
                if (selectedProject != null && d.doc.project != selectedProject) return@forEach
                d.doc.items(section).forEach { result += TaskListRow(d.storeId, d.storeName, d.doc.project, it) }
            }
        }
        // Pinned first, then rank (tasks.ts display order).
        return result.sortedWith(compareBy<TaskListRow> { if (it.task.pinned == true) 0 else 1 }.thenBy { it.task.rank ?: Int.MAX_VALUE })
    }

    val active = rows(PhrenTask.Section.ACTIVE)
    val queue = rows(PhrenTask.Section.QUEUE)
    val done = rows(PhrenTask.Section.DONE)
    val addTargets = model.writableProjects

    fun matchOf(row: TaskListRow) = row.task.stableId ?: row.task.line
    fun toggle(row: TaskListRow) {
        if (row.task.checked) model.perform(PendingOp.UpdateTask(row.project, matchOf(row), section = PhrenTask.Section.ACTIVE.rawValue), row.storeId)
        else model.perform(PendingOp.CompleteTask(row.project, matchOf(row)), row.storeId)
    }
    fun delete(row: TaskListRow) = model.perform(PendingOp.RemoveTask(row.project, matchOf(row)), row.storeId)

    val rowContent: @Composable (TaskListRow, RowPosition) -> Unit = { row, pos ->
        var menu by remember { mutableStateOf(false) }
        Box {
            SwipeActionsRow(
                leading = listOf(
                    if (row.task.checked) SwipeAction("Reopen", Icons.AutoMirrored.Filled.Undo, PhrenTheme.systemBlue) { toggle(row) }
                    else SwipeAction("Complete", Icons.Filled.Check, PhrenTheme.systemGreen) { toggle(row) },
                ),
                trailing = listOf(
                    SwipeAction("Delete", Icons.Filled.Delete, PhrenTheme.systemRed) { delete(row) },
                    SwipeAction("Edit", Icons.Filled.Edit, PhrenTheme.systemBlue) { editing = row },
                ),
                position = pos,
            ) {
                IosCell(pos, onLongClick = { menu = true }) {
                    TaskRow(row, showProject = !isProjectScoped, showStore = !isProjectScoped && model.hasMultipleStores) { toggle(row) }
                }
            }
            ContextMenu(
                menu, { menu = false },
                listOf(
                    if (row.task.checked) Triple("Reopen", Icons.AutoMirrored.Filled.Undo, false to { toggle(row) })
                    else Triple("Complete", Icons.Filled.Check, false to { toggle(row) }),
                    Triple("Edit", Icons.Filled.Edit, false to { editing = row }),
                    Triple("Delete", Icons.Filled.Delete, true to { delete(row) }),
                ),
            )
        }
    }

    IosRefreshable({ model.pullToRefresh() }, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            iosSection("active", active, { it.id }, header = "Active (${active.size})", row = rowContent)
            iosSection("queue", queue, { it.id }, header = "Queue (${queue.size})", row = rowContent)
            val doneRows: List<TaskListRow?> = listOf<TaskListRow?>(null) + if (doneExpanded) done else emptyList()
            iosSection("done", doneRows, { it?.id ?: "header" }) { row, pos ->
                if (row == null) IosCell(pos) { DisclosureHeader("Done (${done.size})", doneExpanded) { doneExpanded = !doneExpanded } }
                else rowContent(row, pos)
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
        if (active.isEmpty() && queue.isEmpty() && done.isEmpty()) {
            PhrenEmptyState(
                "No tasks yet",
                if (!isProjectScoped && addTargets.isEmpty()) "No writable store yet — your GitHub token needs Contents: Read and write on the store repo before you can add tasks."
                else "Add a task with the + button.",
                Modifier.align(Alignment.Center),
            )
        }
    }

    if (showAdd) AddTaskSheet(model, scope, addTargets.map { AddTarget(it.storeId, it.storeName, it.project.name) }, closeAdd)
    editing?.let { TaskEditSheet(model, it) { editing = null } }
}

@Composable
private fun TaskRow(row: TaskListRow, showProject: Boolean, showStore: Boolean, onToggle: () -> Unit) {
    val task = row.task
    Row(verticalAlignment = Alignment.Top, modifier = Modifier.padding(vertical = 2.dp)) {
        Icon(
            if (task.checked) Icons.Filled.CheckCircle else Icons.Outlined.Circle,
            if (task.checked) "Reopen" else "Complete",
            tint = if (task.checked) PhrenTheme.systemGreen else PhrenTheme.secondaryLabel,
            modifier = Modifier.size(24.dp).clickable(interactionSource = null, indication = null, onClick = onToggle),
        )
        Spacer(Modifier.width(10.dp))
        Column {
            Text(
                TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(task.line)),
                style = IosType.callout.copy(textDecoration = if (task.checked) TextDecoration.LineThrough else null),
                color = PhrenTheme.text,
            )
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (showProject) TagChip(row.project, PhrenTheme.ChipRole.PROJECT)
                if (showStore) TagChip(row.storeName, PhrenTheme.ChipRole.STORE)
                task.priority?.let { TagChip(it.rawValue, priorityColor(it)) }
                if (task.pinned == true) Icon(Icons.Filled.PushPin, "Pinned", tint = PhrenTheme.systemOrange, modifier = Modifier.size(12.dp))
                task.githubIssue?.let { Text("#$it", style = IosType.caption2, color = PhrenTheme.secondaryLabel) }
            }
            task.context?.let {
                Spacer(Modifier.height(3.dp))
                Text(it, style = IosType.caption, color = PhrenTheme.secondaryLabel, maxLines = 2)
            }
        }
    }
}

private fun priorityColor(p: PhrenTask.Priority): Color = when (p) {
    PhrenTask.Priority.HIGH -> PhrenTheme.red
    PhrenTask.Priority.MEDIUM -> PhrenTheme.amber
    PhrenTask.Priority.LOW -> PhrenTheme.textDim
}

data class AddTarget(val storeId: String, val storeName: String, val project: String) {
    val id: String get() = "$storeId|$project"
}

@Composable
private fun AddTaskSheet(model: AppModel, scope: TaskScope, targets: List<AddTarget>, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<AddTarget?>(null) }
    val fixed: Pair<String, String>? = when {
        scope is TaskScope.Project -> scope.storeId to scope.project
        targets.size == 1 -> targets[0].storeId to targets[0].project
        else -> null
    }
    val resolved = fixed ?: selected?.let { it.storeId to it.project }
    fun label(t: AddTarget) = if (model.hasMultipleStores) "${t.project} · ${t.storeName}" else t.project

    IosSheet(
        onDismiss, "Add to Queue", confirmLabel = "Add",
        confirmEnabled = text.isNotBlank() && resolved != null,
        onConfirm = {
            resolved?.let { (storeId, project) -> model.perform(PendingOp.AddTask(project, text), storeId) }
            onDismiss()
        },
    ) {
        LazyColumn {
            item { Spacer(Modifier.height(20.dp)) }
            item {
                val pos = if (fixed == null) RowPosition.FIRST else RowPosition.ONLY
                FormCell(pos) { FormTextField(text, { text = it }, "Task", minLines = 2, autofocus = true) }
            }
            if (fixed == null) {
                item {
                    FormCell(RowPosition.LAST) {
                        FormPicker("Project", listOf<Pair<AddTarget?, String>>(null to "Choose…") + targets.map { it to label(it) }, selected) { selected = it }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskEditSheet(model: AppModel, row: TaskListRow, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf(TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line))) }
    var priority by remember { mutableStateOf(row.task.priority) }
    var section by remember { mutableStateOf(row.task.section) }
    var pinned by remember { mutableStateOf(row.task.pinned ?: false) }
    IosSheet(
        onDismiss, "Edit task", confirmLabel = "Save", confirmEnabled = text.isNotBlank(),
        onConfirm = {
            // TasksFile.update recomputes `pinned` from the text, so re-append the tag.
            var newText = text.trim()
            if (pinned) newText += " [pinned]"
            model.perform(
                PendingOp.UpdateTask(
                    row.project, row.task.stableId ?: row.task.line, newText, priority?.rawValue,
                    if (section != row.task.section) section.rawValue else null,
                ),
                row.storeId,
            )
            onDismiss()
        },
    ) {
        LazyColumn {
            item { Spacer(Modifier.height(20.dp)) }
            item { FormCell(RowPosition.FIRST) { FormTextField(text, { text = it }, "Task", minLines = 2) } }
            item { FormCell(RowPosition.MIDDLE) { FormToggle("Pinned", pinned) { pinned = it } } }
            item {
                FormCell(RowPosition.MIDDLE) {
                    FormPicker("Priority", listOf<Pair<PhrenTask.Priority?, String>>(null to "none") + PhrenTask.Priority.entries.map { it to it.rawValue }, priority) { priority = it }
                }
            }
            item {
                FormCell(RowPosition.LAST) {
                    FormPicker("Section", PhrenTask.Section.entries.map { it to it.rawValue }, section) { section = it }
                }
            }
        }
    }
}

