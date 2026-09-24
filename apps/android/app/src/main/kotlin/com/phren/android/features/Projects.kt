package com.phren.android.features

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.android.AppTab
import com.phren.android.StoreProject
import com.phren.android.design.FormSection
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenActionSheet
import com.phren.android.design.PhrenChipRow
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenEmptyState
import com.phren.android.design.PhrenForm
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenPlainList
import com.phren.android.design.PhrenRail
import com.phren.android.design.PhrenSearchField
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenSingleSelect
import com.phren.android.design.PhrenSwipeRow
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PhrenType.mono
import com.phren.android.design.PhrenType.semibold
import com.phren.android.design.PlainSectionLabel
import com.phren.android.design.SF
import com.phren.android.design.SwipeAction
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.design.separatedCard
import com.phren.android.design.sessionCard
import com.phren.kit.ColdDocRef
import com.phren.kit.Finding
import com.phren.kit.LocalStore
import com.phren.kit.Note
import com.phren.kit.PendingOp
import com.phren.kit.TopicDocument
import kotlinx.coroutines.launch

/** Pull-to-refresh wrapper (`.refreshable { await model.pullToRefresh() }`). */
@Composable
fun Refreshable(content: @Composable () -> Unit) {
    val model = LocalModel.current
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    PullToRefreshBox(refreshing, onRefresh = {
        refreshing = true
        scope.launch { try { model.pullToRefresh() } finally { refreshing = false } }
    }) { content() }
}

// MARK: Projects

@Composable
fun ProjectsView() {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var showSearch by rememberSaveable { mutableStateOf(false) }
    var filter by rememberSaveable { mutableStateOf("") }
    var showStores by remember { mutableStateOf(false) }
    var showAddProject by remember { mutableStateOf(false) }
    var showVoiceCapture by remember { mutableStateOf(false) }
    val hasComputer = LiveBridge.hasComputer(model)

    val merged = model.mergedProjects
    val storeIsEmpty = model.storeContexts.all { it.snapshot.projects.isEmpty() }
    val projects = if (filter.isBlank()) merged else merged.filter { it.project.name.contains(filter.trim(), ignoreCase = true) }
    val voiceTargets = model.writableProjects

    fun open(item: StoreProject) = navigator.push("project:${item.id}") { ProjectDetailView(item.storeId, item.project.name) }

    LaunchedEffect(model.showingMemoryMaintenance) {
        // Review widget links select Projects first; Memory owns the request.
        if (model.showingMemoryMaintenance) model.selectedTab = AppTab.MEMORY
    }
    LaunchedEffect(model.pendingProjectVersion) {
        val target = LiveBridge.takePendingProject() ?: return@LaunchedEffect
        val item = model.mergedProjects.firstOrNull { it.storeId == target.first && it.project.name == target.second }
        if (item == null) { model.lastActionError = "That project is no longer available on this phone."; return@LaunchedEffect }
        navigator.popToRoot(); open(item)
    }

    PhrenNavScreen(
        "Projects",
        trailing = buildList {
            add(ToolbarItem(icon = SF("plus"), label = "Add project", identifier = "projects-add", raised = true) { showAddProject = true })
            add(ToolbarItem(icon = SF("magnifyingglass"), label = "Filter projects", identifier = "projects-search-toggle", raised = true) { showSearch = !showSearch })
            if (voiceTargets.isNotEmpty()) add(ToolbarItem(icon = SF("mic"), label = "Capture by voice", identifier = "projects-mic", raised = true) { showVoiceCapture = true })
        },
    ) {
        LiveStatusBar()
        ActionErrorBanner()
        if (model.hasMultipleStores || showSearch) {
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (model.hasMultipleStores) {
                    val options = listOf(PhrenOption<String?>(id = "all", value = null, title = "All stores")) +
                        model.storeDescriptors.map { PhrenOption<String?>(id = it.id, value = it.id, title = it.displayName) }
                    PhrenSingleSelect(options, model.storeFilter, placeholder = "Filter stores", identifier = "projects-stores") { showStores = true }
                }
                if (showSearch) PhrenSearchField(filter, { filter = it }, placeholder = "Filter projects", identifier = "projects-search")
            }
        }
        Refreshable {
            Box(Modifier.fillMaxSize()) {
                PhrenPlainList(Modifier.phrenIdentifier("projects-list")) {
                    item { Spacer(Modifier.height(12.dp)) }
                    if (projects.isEmpty() && !storeIsEmpty) item {
                        Text("No matching projects.", style = PhrenType.footnote, color = PhrenTheme.textMuted, modifier = Modifier.padding(horizontal = 16.dp))
                    }
                    items(projects, key = { it.id }) { item -> ProjectCard(item) { open(item) } }
                }
                if (storeIsEmpty && model.phase == AppModel.Phase.READY) {
                    PhrenEmptyState(
                        "Add your first project",
                        if (hasComputer) "Pick a repository on your computer, or clone one from GitHub. Phren adds it and your agents start remembering."
                        else "Connect a computer running Phren Hook, then add a repository from it. Your agents start remembering from there.",
                        Modifier.fillMaxSize(),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            if (!hasComputer) BorderedButton("Connect a computer", SF("desktopcomputer.and.arrow.down"), identifier = "projects-connect-computer") { LiveBridge.connectComputer(navigator) }
                            ProminentButton("Add a project", SF("plus"), identifier = "projects-add-first") { showAddProject = true }
                        }
                    }
                }
            }
        }
    }
    if (showStores) {
        PhrenActionSheet(
            "Store",
            listOf(PhrenControlAction(id = "all", title = "All stores", isSelected = model.storeFilter == null) { model.storeFilter = null }) +
                model.storeDescriptors.map { d -> PhrenControlAction(id = d.id, title = d.displayName, isSelected = model.storeFilter == d.id) { model.storeFilter = d.id } },
            identifier = "projects-store-sheet",
        ) { showStores = false }
    }
    if (showAddProject) PhrenSheet({ showAddProject = false }) {
        LiveBridge.AddProjectView { project ->
            model.mergedProjects.firstOrNull { it.project.name == project }?.let { navigator.popToRoot(); open(it) }
        }
    }
    if (showVoiceCapture) PhrenSheet({ showVoiceCapture = false }) { VoiceCaptureView(model, voiceTargets.voiceTargets()) }
}

@Composable
private fun ProjectCard(item: StoreProject, onClick: () -> Unit) {
    val model = LocalModel.current
    Column(
        Modifier.padding(horizontal = 16.dp, vertical = 5.dp).fillMaxWidth()
            .background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.medium))
            .plainClickable(onClick = onClick).phrenIdentifier("project:${item.storeId}:${item.project.name}")
            .padding(horizontal = PhrenTheme.Space.medium, vertical = PhrenTheme.Space.small),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(item.project.name, style = PhrenType.headline, color = projectColor(item.storeId, item.project.name), maxLines = 1)
            if (model.hasMultipleStores) TagChip(item.storeName, PhrenTheme.ChipRole.STORE)
            if (LocalStore.isReadOnlyProject(item.project.name)) TagChip("read-only", PhrenTheme.ChipRole.STATUS)
            model.claimingStoreName(item)?.let { ClaimBadge(it) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetadataLabel(SF("lightbulb"), "${item.project.totalFindingCount}")
            MetadataLabel(SF("checklist"), "${item.project.taskCount}")
            MetadataLabel(SF("note.text"), "${item.project.noteCount}")
        }
    }
}

/** `stores.yaml` claims this project for a different store than the one it sits in. */
@Composable
private fun ClaimBadge(storeName: String) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        Modifier.background(PhrenTheme.warning.copy(alpha = 0.14f), shape).border(1.dp, PhrenTheme.warning.copy(alpha = 0.45f), shape).padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(SF("person.2"), null, tint = PhrenTheme.warning, modifier = Modifier.size(11.dp))
        Text(storeName, style = PhrenType.caption2.mono().semibold(), color = PhrenTheme.warning)
    }
}

@Composable
fun ProminentButton(title: String, icon: ImageVector? = null, identifier: String? = null, onClick: () -> Unit) {
    Row(
        Modifier.heightIn(min = 44.dp).background(PhrenTheme.cyan, RoundedCornerShape(50)).plainClickable(onClick = onClick)
            .then(if (identifier != null) Modifier.phrenIdentifier(identifier) else Modifier).padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = PhrenTheme.chatPanel, modifier = Modifier.size(17.dp))
        Text(title, style = PhrenType.body.medium(), color = PhrenTheme.chatPanel)
    }
}

@Composable
fun BorderedButton(title: String, icon: ImageVector? = null, identifier: String? = null, tint: androidx.compose.ui.graphics.Color = PhrenTheme.cyan, onClick: () -> Unit) {
    Row(
        Modifier.heightIn(min = 44.dp).background(tint.copy(alpha = 0.15f), RoundedCornerShape(50)).plainClickable(onClick = onClick)
            .then(if (identifier != null) Modifier.phrenIdentifier(identifier) else Modifier).padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = tint, modifier = Modifier.size(17.dp))
        Text(title, style = PhrenType.body.medium(), color = tint)
    }
}

// MARK: Project detail

private enum class ProjectTab(val title: String) { FINDINGS("Findings"), NOTES("Notes"), TASKS("Tasks"), SUMMARY("Summary") }

@Composable
fun ProjectDetailView(storeId: String, project: String) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var tab by rememberSaveable { mutableStateOf(ProjectTab.FINDINGS) }
    var showingKnobs by remember { mutableStateOf(false) }
    var showAdd by remember { mutableStateOf(false) }
    val readOnly = LocalStore.isReadOnlyProject(project)
    val displayTitle = if (model.hasMultipleStores) "$project · ${model.storeName(storeId)}" else project
    val addable = !readOnly && (tab == ProjectTab.FINDINGS || tab == ProjectTab.NOTES)

    PhrenNavScreen(
        displayTitle,
        onBack = navigator::pop,
        trailing = if (addable) listOf(ToolbarItem(icon = SF("plus"), label = "Add", identifier = "project-add") { showAdd = true }) else emptyList(),
        titleContent = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(displayTitle, style = PhrenType.subheadline.semibold(), color = PhrenTheme.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                LiveStatusBar(compact = true)
            }
        },
    ) {
        Box(Modifier.size(1.dp).phrenIdentifier("project-detail:$storeId:$project"))
        ActionErrorBanner()
        LiveBridge.ProjectComputerRows(storeId, project)
        ControlBand(storeId, project, openSkills = {
            val depth = navigator.depth
            navigator.push("skills:$storeId:$project") { SkillsView(project, storeId) { while (navigator.depth > depth) navigator.pop() } }
        }, openKnobs = { showingKnobs = true })
        Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp)) {
            PhrenChipRow(ProjectTab.entries.map { PhrenOption(id = it.title, value = it, title = it.title) }, tab, { tab = it }, identifier = "project-section")
        }
        Box(Modifier.weight(1f)) {
            when (tab) {
                ProjectTab.FINDINGS -> FindingsTab(storeId, project, showAdd && tab == ProjectTab.FINDINGS) { showAdd = false }
                ProjectTab.NOTES -> NotesTab(storeId, project, showAdd && tab == ProjectTab.NOTES) { showAdd = false }
                ProjectTab.TASKS -> LiveBridge.TaskListView(storeId, project)
                ProjectTab.SUMMARY -> SummaryTab(storeId, project)
            }
        }
    }
    if (showingKnobs) PhrenSheet({ showingKnobs = false }) { ProjectKnobsView(storeId, project) }
}

/** Equal columns keep four destinations readable on a narrow phone. */
@Composable
private fun ControlBand(storeId: String, project: String, openSkills: () -> Unit, openKnobs: () -> Unit) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val knobs = model.snapshot(storeId).projectKnobs[project]?.setCount ?: 0
    Row(
        Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp).fillMaxWidth().height(52.dp)
            .background(PhrenTheme.surface, RoundedCornerShape(12.dp)).phrenIdentifier("project-control-band"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val cells = buildList<Triple<String, String, Pair<String, () -> Unit>>> {
            add(Triple("wand.and.stars", "Skills", "project-skills" to openSkills))
            add(Triple("slider.horizontal.3", "Knobs", "project-knobs-row" to openKnobs))
            if (LiveBridge.allowsSchedules()) add(Triple("clock.badge.checkmark", "Schedules", "project-schedules-row" to {
                navigator.push("schedules:$storeId:$project") { LiveBridge.SchedulesView(storeId, project) }
            }))
            if (LiveBridge.showsCode(model)) add(Triple("curlybraces", "Code", "project-code-row" to {
                navigator.push("code:$storeId:$project") { LiveBridge.CodeView(storeId, project) }
            }))
        }
        cells.forEachIndexed { i, (icon, title, action) ->
            if (i > 0) Box(Modifier.width(1.dp).height(28.dp).background(PhrenTheme.border))
            Column(
                Modifier.weight(1f).fillMaxSize().plainClickable(onClick = action.second).phrenIdentifier(action.first),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
            ) {
                Icon(SF(icon), null, tint = PhrenTheme.textSecondary, modifier = Modifier.size(17.dp))
                Text(title, style = PhrenType.caption.semibold(), color = PhrenTheme.text, maxLines = 1)
            }
        }
        @Suppress("UNUSED_EXPRESSION") knobs
    }
}

// MARK: Findings

private const val COLLAPSED_LINES = 5
private const val TRUNCATION_CHARS = 260

@Composable
fun FindingsTab(storeId: String, project: String, showAdd: Boolean, closeAdd: () -> Unit) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val findings = model.findings(storeId, project)
    val truths = model.truths(storeId, project)
    val readOnly = LocalStore.isReadOnlyProject(project)
    val journalled = !readOnly && model.usesTeamJournal(storeId)
    var editing by remember { mutableStateOf<Finding?>(null) }
    var expanded by rememberSaveable { mutableStateOf(setOf<String>()) }
    val grouped = findings.groupBy { it.date }.toSortedMap(reverseOrder())
    val hasArchive = model.consolidatedDate(storeId, project) != null || (model.coldSummary(storeId, project)?.topicCount ?: 0) > 0
    val isEmpty = findings.isEmpty() && truths.isEmpty() && !hasArchive

    fun remove(f: Finding) = model.perform(PendingOp.RemoveFinding(project, f.stableId?.let { "fid:$it" } ?: f.text), storeId)

    Refreshable {
        Box(Modifier.fillMaxSize()) {
            PhrenPlainList {
                if (truths.isNotEmpty()) {
                    item { PlainSectionLabel("Pinned truths") }
                    items(truths, key = { "truth:${it.id}" }) { truth ->
                        Box(Modifier.separatedCard().sessionCard()) {
                            Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                SelectionContainer { Text(truth.text, style = PhrenType.callout, color = PhrenTheme.text) }
                                truth.addedDate?.let { Text("pinned $it", style = PhrenType.caption2, color = PhrenTheme.textDim) }
                            }
                            PhrenRail(PhrenTheme.cyan, Modifier.padding(vertical = 10.dp).height(24.dp).align(Alignment.CenterStart))
                        }
                    }
                    item {
                        Text("Always injected, never decayed. Pin one from your computer: phren pin $project \"…\"",
                            style = PhrenType.caption2, color = PhrenTheme.textMuted, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 6.dp))
                    }
                }
                grouped.forEach { (date, items) ->
                    item(key = "d:$date") { PlainSectionLabel(date) }
                    items(items, key = { "f:${it.stableId ?: it.id}" }) { finding ->
                        val key = finding.stableId ?: finding.id
                        val actions = if (!readOnly && !finding.isJournalEntry) listOf(
                            SwipeAction("Delete", SF("trash"), androidx.compose.ui.graphics.Color(0xFFFF453A), destructive = true) { remove(finding) },
                            SwipeAction("Edit", SF("pencil"), androidx.compose.ui.graphics.Color(0xFF0A84FF)) { editing = finding },
                        ) else emptyList()
                        PhrenSwipeRow(trailing = actions) {
                            ExpandableText(finding.displayText, key in expanded, { expanded = if (key in expanded) expanded - key else expanded + key }) {
                                FindingMeta(finding)
                            }
                        }
                    }
                }
                item { ArchiveFooter(storeId, project) { navigator.push("archive:$storeId:$project") { ArchiveBrowserView(storeId, project) } } }
                if (journalled) item {
                    FormSection(modifier = Modifier.padding(horizontal = 16.dp)) {
                        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(SF("person.2"), null, tint = PhrenTheme.textSecondary, modifier = Modifier.size(16.dp))
                            Text("Shared store — findings you add here append to today's journal file, so they merge with your teammates' instead of colliding.",
                                style = PhrenType.caption, color = PhrenTheme.textSecondary)
                        }
                    }
                }
            }
            if (isEmpty) PhrenEmptyState(
                "No findings",
                if (readOnly) "$project is phren's cross-project tier — the consolidate skill writes it from your computer." else "Capture your first finding with the + button.",
                Modifier.fillMaxSize(),
            )
        }
    }
    if (showAdd) PhrenSheet(closeAdd) {
        TextEntrySheet("Add finding", showsTypePicker = true, confirmLabel = "Add") { text, type ->
            model.performNow(PendingOp.AddFinding(project, text, type?.rawValue), storeId)
        }
    }
    editing?.let { f ->
        PhrenSheet({ editing = null }) {
            TextEntrySheet("Edit finding", initialText = f.text, confirmLabel = "Save") { text, _ ->
                model.performNow(PendingOp.EditFinding(project, f.stableId?.let { "fid:$it" } ?: f.text, text), storeId)
            }
        }
    }
}

/** A card collapsed to five lines, with Show more/less when it is long enough to clip. */
@Composable
private fun ExpandableText(text: String, expanded: Boolean, toggle: () -> Unit, meta: @Composable () -> Unit) {
    Column(
        Modifier.separatedCard().sessionCard().plainClickable(onClick = toggle).animateContentSize()
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(text, style = PhrenType.callout, color = PhrenTheme.text, maxLines = if (expanded) Int.MAX_VALUE else COLLAPSED_LINES, overflow = TextOverflow.Ellipsis)
        if (text.length > TRUNCATION_CHARS) Text(if (expanded) "Show less" else "Show more", style = PhrenType.caption2.semibold(), color = PhrenTheme.lavender)
        meta()
    }
}

// MARK: Notes

@Composable
fun NotesTab(storeId: String, project: String, showAdd: Boolean, closeAdd: () -> Unit) {
    val model = LocalModel.current
    val notes = model.notes(storeId, project)
    val readOnly = LocalStore.isReadOnlyProject(project)
    var editing by remember { mutableStateOf<Note?>(null) }
    var promoting by remember { mutableStateOf<Note?>(null) }
    var expanded by rememberSaveable { mutableStateOf(setOf<String>()) }
    val grouped = notes.groupBy { it.date }.toSortedMap(reverseOrder()).mapValues { (_, v) -> v.sortedByDescending { it.time } }

    Refreshable {
        Box(Modifier.fillMaxSize()) {
            PhrenPlainList {
                grouped.forEach { (date, items) ->
                    item(key = "d:$date") { PlainSectionLabel(date) }
                    items(items, key = { "n:${it.stableId}" }) { note ->
                        PhrenSwipeRow(
                            trailing = if (readOnly) emptyList() else listOf(
                                SwipeAction("Delete", SF("trash"), androidx.compose.ui.graphics.Color(0xFFFF453A), destructive = true) {
                                    model.perform(PendingOp.RemoveNote(project, note.date, note.stableId), storeId)
                                },
                                SwipeAction("Edit", SF("pencil"), androidx.compose.ui.graphics.Color(0xFF0A84FF)) { editing = note },
                            ),
                            leading = if (note.promoted || readOnly) emptyList() else listOf(
                                SwipeAction("Promote", SF("arrow.up.circle"), androidx.compose.ui.graphics.Color(0xFF30D158)) { promoting = note },
                            ),
                        ) {
                            ExpandableText(note.text, note.stableId in expanded, {
                                expanded = if (note.stableId in expanded) expanded - note.stableId else expanded + note.stableId
                            }) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(note.time, style = PhrenType.caption2, color = PhrenTheme.textDim)
                                    if (note.promoted) TagChip("promoted", PhrenTheme.ChipRole.GOOD)
                                }
                            }
                        }
                    }
                }
            }
            if (notes.isEmpty()) PhrenEmptyState("No notes", "Jot down a note with the + button. Promote the good ones to findings.", Modifier.fillMaxSize())
        }
    }
    if (showAdd) PhrenSheet(closeAdd) {
        TextEntrySheet("Add note", confirmLabel = "Add") { text, _ ->
            val (date, time) = AppModel.nowNoteTimestamp()
            model.performNow(PendingOp.AddNote(project, date, time, text), storeId)
        }
    }
    editing?.let { n ->
        PhrenSheet({ editing = null }) {
            TextEntrySheet("Edit note", initialText = n.text) { text, _ ->
                model.performNow(PendingOp.EditNote(project, n.date, n.stableId, text), storeId)
            }
        }
    }
    promoting?.let { n ->
        PhrenSheet({ promoting = null }) {
            TextEntrySheet("Promote to finding", initialText = n.text, showsTypePicker = true, confirmLabel = "Promote") { _, type ->
                model.performNow(PendingOp.PromoteNote(project, n.date, n.stableId, type?.rawValue), storeId)
            }
        }
    }
}

// MARK: Summary

@Composable
fun SummaryTab(storeId: String, project: String) {
    val model = LocalModel.current
    val summary = model.summary(storeId, project)
    Refreshable {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            if (summary != null) {
                SelectionContainer {
                    Text(summary, style = PhrenType.callout.mono(), color = PhrenTheme.text, modifier = Modifier.fillMaxWidth().padding(16.dp).padding(bottom = 100.dp))
                }
            } else {
                PhrenEmptyState("No summary", "This project has no summary.md yet.", Modifier.padding(top = 60.dp).fillMaxWidth())
            }
        }
    }
}

// MARK: Archive

@Composable
private fun ArchiveFooter(storeId: String, project: String, open: () -> Unit) {
    val model = LocalModel.current
    val consolidated = model.consolidatedDate(storeId, project)
    val summary = model.coldSummary(storeId, project)
    if (summary != null && summary.topicCount > 0) {
        val topics = "${summary.topicCount} topic${if (summary.topicCount == 1) "" else "s"}"
        val scope = summary.findingCount?.let { "$it finding${if (it == 1) "" else "s"} in $topics" } ?: topics
        val headline = consolidated?.let { "Archived $it — $scope" } ?: "Archived findings — $scope"
        FormSection(modifier = Modifier.padding(horizontal = 16.dp)) {
            com.phren.android.design.FormRow(headline, icon = SF("archivebox"), subtitle = "${archiveSize(summary.totalBytes)}, downloaded when you open it",
                identifier = "archive-footer", onClick = open)
        }
    } else if (consolidated != null) {
        FormSection(modifier = Modifier.padding(horizontal = 16.dp)) {
            Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(SF("archivebox"), null, tint = PhrenTheme.textSecondary, modifier = Modifier.size(16.dp))
                Text("Consolidated $consolidated — no archive topics in this store", style = PhrenType.caption, color = PhrenTheme.textSecondary)
            }
        }
    }
}

fun archiveSize(bytes: Int): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1_048_576 -> "%.0f KB".format(bytes / 1024.0)
    else -> "%.1f MB".format(bytes / 1_048_576.0)
}

@Composable
fun ArchiveBrowserView(storeId: String, project: String) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var topics by remember { mutableStateOf<List<ColdDocRef>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { topics = model.coldTopics(storeId, project); loaded = true }
    PhrenNavScreen("Archive", onBack = navigator::pop) {
        Box(Modifier.fillMaxSize()) {
            PhrenForm {
                FormSection(footer = "Consolidated findings the phren CLI moved out of FINDINGS.md. Read-only, downloaded one topic at a time, and left out of search so a search returns live knowledge.") {
                    com.phren.android.design.FormRows(topics.size, inset = 16.dp) { i ->
                        val topic = topics[i]
                        com.phren.android.design.FormRow(topic.displayName, subtitle = topic.size?.let { "${archiveSize(it)} of archived findings" } ?: "archived findings") {
                            navigator.push("archive-topic:${topic.path}") { ArchiveTopicView(storeId, topic) }
                        }
                    }
                }
            }
            if (loaded && topics.isEmpty()) PhrenEmptyState("Nothing archived", "$project hasn't passed its findings cap yet, so nothing has been consolidated.", Modifier.fillMaxSize())
        }
    }
}

@Composable
fun ArchiveTopicView(storeId: String, topic: ColdDocRef) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var document by remember { mutableStateOf<TopicDocument?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        try { document = model.coldDocument(storeId, topic.path) } catch (e: Exception) { error = e.message }
        loading = false
    }
    PhrenNavScreen(topic.displayName, onBack = navigator::pop) {
        val doc = document
        when {
            doc != null -> PhrenForm {
                doc.groupedByDate.forEach { (date, entries) ->
                    FormSection("Archived $date") {
                        com.phren.android.design.FormRows(entries.size, inset = 16.dp) { i ->
                            val f = entries[i]
                            Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                SelectionContainer { Text(f.displayText, style = PhrenType.callout, color = PhrenTheme.textSecondary) }
                                FindingMeta(f, archived = true)
                            }
                        }
                    }
                }
            }
            loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    androidx.compose.material3.CircularProgressIndicator(color = PhrenTheme.textMuted, modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                    Text("Fetching ${topic.displayName}…", style = PhrenType.body, color = PhrenTheme.textMuted)
                }
            }
            else -> PhrenEmptyState("Couldn't open this topic", error ?: "The archive document is no longer in this store.", Modifier.fillMaxSize())
        }
    }
}

@Suppress("unused") private val keepNavBar: @Composable (String) -> Unit = { PhrenNavBar(it) }
