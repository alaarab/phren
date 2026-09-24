package com.phren.android.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowCircleUp
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FilterAlt
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.FilterAlt
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.android.StoreProject
import com.phren.kit.ColdDocRef
import com.phren.kit.ColdSummary
import com.phren.kit.Finding
import com.phren.kit.LocalStore
import com.phren.kit.Note
import com.phren.kit.PendingOp
import com.phren.kit.TopicDocument
import com.phren.kit.Truth

@Composable
fun ProjectsScreen(model: AppModel, stack: NavStack) {
    NavHostStack(stack, root = { ProjectsRoot(model, stack) }) { route ->
        when (route) {
            is Route.ProjectDetail -> ProjectDetailScreen(model, stack, route.storeId, route.project)
            is Route.Archive -> ArchiveBrowserScreen(model, stack, route.storeId, route.project)
            is Route.ArchiveTopic -> ArchiveTopicScreen(model, stack, route.storeId, route.topic)
            else -> {}
        }
    }
}

@Composable
private fun ProjectsRoot(model: AppModel, stack: NavStack) {
    var filter by rememberSaveable { mutableStateOf("") }
    var showVoiceCapture by remember { mutableStateOf(false) }
    val projects = model.mergedProjects.let { all -> if (filter.isEmpty()) all else all.filter { it.project.name.contains(filter, ignoreCase = true) } }
    val voiceTargets = model.writableProjects.map { VoiceCaptureTarget(it.storeId, it.storeName, it.project.name) }

    IosScreen(
        "Projects", large = true,
        leading = {
            if (model.hasMultipleStores) {
                IosPickerMenu(
                    if (model.storeFilter == null) Icons.Outlined.FilterAlt else Icons.Filled.FilterAlt,
                    listOf<Pair<String?, String>>(null to "All stores") + model.storeDescriptors.map { it.id to it.displayName },
                    model.storeFilter,
                    { model.storeFilter = it },
                    contentDescription = "Store",
                )
            }
        },
        trailing = {
            // Global quick capture: hidden (not just disabled) when nothing is writable.
            if (voiceTargets.isNotEmpty()) {
                ToolbarButton(ToolbarAction(icon = Icons.Filled.Mic, contentDescription = "Dictate a note or task") { showVoiceCapture = true })
            }
        },
    ) {
        LiveStatusBar(model)
        ActionErrorBanner(model)
        IosSearchField(filter, { filter = it }, "Filter projects")
        IosRefreshable({ model.pullToRefresh() }, Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize()) {
                iosSection("projects", projects, { it.id }) { item, pos ->
                    IosCell(pos, onClick = { stack.push(Route.ProjectDetail(item.storeId, item.project.name, detailTitle(model, item.storeId, item.project.name))) }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ProjectRowContent(model, item, Modifier.weight(1f))
                            DisclosureChevron()
                        }
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
            if (model.mergedProjects.isEmpty()) {
                PhrenEmptyState("No projects yet", "Projects appear here once your phren store has content.", Modifier.align(Alignment.Center))
            }
        }
    }
    if (showVoiceCapture) VoiceCaptureSheet(model, voiceTargets, null) { showVoiceCapture = false }
}

private fun detailTitle(model: AppModel, storeId: String, project: String) =
    if (model.hasMultipleStores) "$project · ${model.storeName(storeId)}" else project

@Composable
private fun ProjectRowContent(model: AppModel, item: StoreProject, modifier: Modifier) {
    Column(modifier.padding(vertical = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(item.project.name, style = IosType.headline, color = PhrenTheme.text)
            if (model.hasMultipleStores) TagChip(item.storeName, PhrenTheme.ChipRole.STORE)
            // `global` is the store's cross-project tier: visible, never editable here.
            if (LocalStore.isReadOnlyProject(item.project.name)) TagChip("read-only", PhrenTheme.ChipRole.STATUS)
            model.claimingStoreName(item)?.let { ClaimBadge(it) }
        }
        Spacer(Modifier.height(3.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CountLabel(Icons.Outlined.Lightbulb, item.project.findingCount)
            CountLabel(Icons.Outlined.Checklist, item.project.taskCount)
            CountLabel(Icons.AutoMirrored.Outlined.Notes, item.project.noteCount)
            if (item.project.reviewCount > 0) CountLabel(Icons.Outlined.Verified, item.project.reviewCount, PhrenTheme.systemOrange)
        }
    }
}

@Composable
fun CountLabel(icon: ImageVector, count: Int, color: Color = PhrenTheme.secondaryLabel) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = color, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(3.dp))
        Text("$count", style = IosType.caption, color = color)
    }
}

/** `stores.yaml` claims this project for another, non-primary store. */
@Composable
private fun ClaimBadge(storeName: String) {
    Row(
        Modifier.background(PhrenTheme.warning.copy(alpha = 0.14f), RoundedCornerShape(4.dp))
            .border(1.dp, PhrenTheme.warning.copy(alpha = 0.45f), RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Groups, null, tint = PhrenTheme.warning, modifier = Modifier.size(11.dp))
        Spacer(Modifier.width(3.dp))
        Text(storeName, style = IosType.caption2.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold), color = PhrenTheme.warning)
    }
}

private enum class DetailTab(val label: String) { FINDINGS("Findings"), NOTES("Notes"), TASKS("Tasks"), SUMMARY("Summary") }

@Composable
internal fun ProjectDetailScreen(model: AppModel, stack: NavStack, storeId: String, project: String) {
    var tab by rememberSaveable { mutableStateOf(DetailTab.FINDINGS) }
    // Each tab contributes its own toolbar items, like SwiftUI's per-view `.toolbar`.
    var showAdd by remember { mutableStateOf(false) }
    var showVoice by remember { mutableStateOf(false) }
    val isReadOnly = LocalStore.isReadOnlyProject(project)
    val voiceTarget = if (model.canWrite(storeId, project)) VoiceCaptureTarget(storeId, model.storeName(storeId), project) else null

    IosScreen(
        detailTitle(model, storeId, project), backLabel = stack.backLabel.takeIf { stack.routes.size > 1 } ?: "Projects", onBack = { stack.pop() },
        trailing = {
            if (tab == DetailTab.NOTES && voiceTarget != null) {
                ToolbarButton(ToolbarAction(icon = Icons.Filled.Mic, contentDescription = "Dictate a note or task") { showVoice = true })
            }
            if (tab != DetailTab.SUMMARY && !isReadOnly) {
                ToolbarButton(ToolbarAction(icon = Icons.Filled.Add, contentDescription = "Add") { showAdd = true })
            }
        },
    ) {
        LiveStatusBar(model)
        ActionErrorBanner(model)
        IosSegmented(DetailTab.entries, tab, { it.label }, { tab = it }, Modifier.padding(start = 16.dp, end = 16.dp, bottom = 4.dp))
        when (tab) {
            DetailTab.FINDINGS -> FindingsTab(model, stack, storeId, project, showAdd) { showAdd = false }
            DetailTab.NOTES -> NotesTab(model, storeId, project, showAdd, { showAdd = false }, showVoice, voiceTarget) { showVoice = false }
            DetailTab.TASKS -> TaskListView(model, TaskScope.Project(storeId, project), showAdd, closeAdd = { showAdd = false })
            DetailTab.SUMMARY -> SummaryTab(model, storeId, project)
        }
    }
}

// Findings

@Composable
private fun FindingsTab(model: AppModel, stack: NavStack, storeId: String, project: String, showAdd: Boolean, closeAdd: () -> Unit) {
    val findings = model.findings(storeId, project)
    val truths = model.truths(storeId, project)
    val isReadOnly = LocalStore.isReadOnlyProject(project)
    val isJournalled = !isReadOnly && model.usesTeamJournal(storeId)
    var editing by remember { mutableStateOf<Finding?>(null) }
    val expanded = remember { mutableStateListOf<String>() }
    val grouped = findings.groupBy { it.date }.entries.sortedByDescending { it.key }
    val hasArchive = model.consolidatedDate(storeId, project) != null || (model.coldSummary(storeId, project)?.topicCount ?: 0) > 0
    val isEmpty = findings.isEmpty() && truths.isEmpty() && !hasArchive

    fun matchKey(f: Finding) = f.stableId?.let { "fid:$it" } ?: f.text

    IosRefreshable({ model.pullToRefresh() }, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            // Pinned first: the CLI injects these into every session.
            if (truths.isNotEmpty()) {
                iosSection(
                    "truths", truths, { it.id }, header = "Pinned truths", headerIcon = Icons.Filled.PushPin,
                    footer = "Always injected, never decayed. Pin one from your computer: phren pin $project \"…\"",
                ) { truth, pos -> IosCell(pos) { TruthRow(truth) } }
            }
            grouped.forEach { (date, items) ->
                iosSection("d-$date", items, { it.stableId ?: it.id }, header = date) { finding, pos ->
                    // A journal entry has no edit or delete: the CLI's edit/remove
                    // splice FINDINGS.md in every store.
                    val actions = if (!isReadOnly && !finding.isJournalEntry) listOf(
                        SwipeAction("Delete", Icons.Filled.Delete, PhrenTheme.systemRed) { model.perform(PendingOp.RemoveFinding(project, matchKey(finding)), storeId) },
                        SwipeAction("Edit", Icons.Filled.Edit, PhrenTheme.systemBlue) { editing = finding },
                    ) else emptyList()
                    SwipeActionsRow(trailing = actions, position = pos) {
                        IosCell(pos) { ExpandableFindingRow(finding, expanded) }
                    }
                }
            }
            archiveFooter(model, stack, storeId, project)
            if (isJournalled) {
                iosSection("journal-note", listOf(Unit), { "j" }) { _, pos ->
                    IosCell(pos) {
                        Row {
                            Icon(Icons.Outlined.Groups, null, tint = PhrenTheme.secondaryLabel, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "Shared store — findings you add here append to today's journal file, so they merge with your teammates' instead of colliding.",
                                style = IosType.caption, color = PhrenTheme.secondaryLabel,
                            )
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
        if (isEmpty) {
            PhrenEmptyState(
                "No findings",
                if (isReadOnly) "$project is phren's cross-project tier — the consolidate skill writes it from your computer." else "Capture your first finding with the + button.",
                Modifier.align(Alignment.Center),
            )
        }
    }
    if (showAdd) {
        TextEntrySheet("Add finding", showsTypePicker = true, confirmLabel = "Add", onDismiss = closeAdd) { text, type ->
            model.perform(PendingOp.AddFinding(project, text, type?.rawValue), storeId)
        }
    }
    editing?.let { finding ->
        TextEntrySheet("Edit finding", initialText = finding.text, confirmLabel = "Save", onDismiss = { editing = null }) { text, _ ->
            model.perform(PendingOp.EditFinding(project, matchKey(finding), text), storeId)
        }
    }
}

/** A pinned truth. Read-only: pinning is `phren pin` on a computer. */
@Composable
private fun TruthRow(truth: Truth) {
    Column(Modifier.padding(vertical = 2.dp)) {
        SelectionContainer { Text(truth.text, style = IosType.callout, color = PhrenTheme.text) }
        truth.addedDate?.let {
            Spacer(Modifier.height(4.dp))
            Text("pinned $it", style = IosType.caption2, color = PhrenTheme.tertiaryLabel)
        }
    }
}

private const val COLLAPSED_LINE_LIMIT = 5
private const val TRUNCATION_CHAR_THRESHOLD = 260

/** Collapsed to five lines; tapping toggles the full text. */
@Composable
private fun ExpandableFindingRow(finding: Finding, expandedIds: SnapshotStateList<String>) {
    val key = finding.stableId ?: finding.id
    val isExpanded = key in expandedIds
    val text = finding.displayText()
    Column(
        Modifier.fillMaxWidth().animateContentSize().padding(vertical = 2.dp)
            .clickable(interactionSource = null, indication = null) { if (isExpanded) expandedIds.remove(key) else expandedIds.add(key) },
    ) {
        Text(text, style = IosType.callout, color = PhrenTheme.text, maxLines = if (isExpanded) Int.MAX_VALUE else COLLAPSED_LINE_LIMIT)
        if (text.length > TRUNCATION_CHAR_THRESHOLD) {
            Spacer(Modifier.height(4.dp))
            Text(if (isExpanded) "Show less" else "Show more", style = IosType.caption2.copy(fontWeight = FontWeight.SemiBold), color = PhrenTheme.lavender)
        }
        Spacer(Modifier.height(4.dp))
        FindingMeta(finding)
    }
}

// Archive

object ArchiveFormat {
    fun size(bytes: Int): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1_048_576 -> "%.0f KB".format(bytes / 1024.0)
        else -> "%.1f MB".format(bytes / 1_048_576.0)
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.archiveFooter(model: AppModel, stack: NavStack, storeId: String, project: String) {
    val consolidatedDate = model.consolidatedDate(storeId, project)
    val summary = model.coldSummary(storeId, project)
    if (summary != null && summary.topicCount > 0) {
        iosSection("archive", listOf(summary), { "a" }) { s, pos ->
            IosCell(pos, onClick = { stack.push(Route.Archive(storeId, project)) }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Archive, null, tint = PhrenTheme.accent, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f).padding(vertical = 2.dp)) {
                        Text(archiveHeadline(s, consolidatedDate), style = IosType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = PhrenTheme.text)
                        Spacer(Modifier.height(2.dp))
                        Text("${ArchiveFormat.size(s.totalBytes)}, downloaded when you open it", style = IosType.caption, color = PhrenTheme.secondaryLabel)
                    }
                    DisclosureChevron()
                }
            }
        }
    } else if (consolidatedDate != null) {
        iosSection("archive", listOf(consolidatedDate), { "a" }) { date, pos ->
            IosCell(pos) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Archive, null, tint = PhrenTheme.secondaryLabel, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Consolidated $date — no archive topics in this store", style = IosType.caption, color = PhrenTheme.secondaryLabel)
                }
            }
        }
    }
}

private fun archiveHeadline(summary: ColdSummary, consolidatedDate: String?): String {
    val topics = "${summary.topicCount} topic${if (summary.topicCount == 1) "" else "s"}"
    val scope = summary.findingCount?.let { "$it finding${if (it == 1) "" else "s"} in $topics" } ?: topics
    return if (consolidatedDate == null) "Archived findings — $scope" else "Archived $consolidatedDate — $scope"
}

@Composable
internal fun ArchiveBrowserScreen(model: AppModel, stack: NavStack, storeId: String, project: String) {
    var topics by remember { mutableStateOf<List<ColdDocRef>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(storeId, project) {
        topics = model.coldTopics(storeId, project)
        loaded = true
    }
    IosScreen("Archive", backLabel = stack.backLabel, onBack = { stack.pop() }) {
        Box(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize()) {
                iosSection(
                    "topics", topics, { it.path },
                    footer = "Consolidated findings the phren CLI moved out of FINDINGS.md. Read-only, downloaded one topic at a time, and left out of search so a search returns live knowledge.",
                ) { topic, pos ->
                    IosCell(pos, onClick = { stack.push(Route.ArchiveTopic(storeId, topic)) }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f).padding(vertical = 2.dp)) {
                                Text(topic.displayName, style = IosType.headline, color = PhrenTheme.text)
                                Spacer(Modifier.height(3.dp))
                                Text(topic.size?.let { "${ArchiveFormat.size(it)} of archived findings" } ?: "archived findings", style = IosType.caption, color = PhrenTheme.secondaryLabel)
                            }
                            DisclosureChevron()
                        }
                    }
                }
            }
            if (loaded && topics.isEmpty()) {
                PhrenEmptyState("Nothing archived", "$project hasn't passed its findings cap yet, so nothing has been consolidated.", Modifier.align(Alignment.Center))
            }
        }
    }
}

@Composable
internal fun ArchiveTopicScreen(model: AppModel, stack: NavStack, storeId: String, topic: ColdDocRef) {
    var document by remember { mutableStateOf<TopicDocument?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(topic.path) {
        // A cached copy still goes through here: the sha is compared first.
        try { document = model.coldDocument(storeId, topic.path) } catch (e: Exception) { error = e.message }
        loading = false
    }
    IosScreen(topic.displayName, backLabel = stack.backLabel, onBack = { stack.pop() }) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val doc = document
            when {
                doc != null -> LazyColumn(Modifier.fillMaxSize()) {
                    doc.groupedByDate.forEach { (date, entries) ->
                        iosSection("a-$date", entries, { it.stableId ?: it.id }, header = "Archived $date") { entry, pos ->
                            IosCell(pos) { ArchivedFindingRow(entry) }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
                loading -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    IosSpinner()
                    Spacer(Modifier.height(8.dp))
                    Text("Fetching ${topic.displayName}…", style = IosType.body, color = PhrenTheme.secondaryLabel)
                }
                else -> PhrenEmptyState("Couldn't open this topic", error ?: "The archive document is no longer in this store.")
            }
        }
    }
}

@Composable
private fun ArchivedFindingRow(finding: Finding) {
    Column(Modifier.padding(vertical = 2.dp)) {
        SelectionContainer { Text(finding.displayText(), style = IosType.callout, color = PhrenTheme.secondaryLabel) }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TagChip("archived", PhrenTheme.ChipRole.STATUS)
            finding.typeTag?.let { TagChip(it, PhrenTheme.ChipRole.TYPE) }
            finding.scope?.let { TagChip(it, PhrenTheme.ChipRole.SCOPE) }
            Spacer(Modifier.weight(1f))
            Text(finding.date, style = IosType.caption2, color = PhrenTheme.tertiaryLabel)
        }
    }
}

// Notes

@Composable
private fun NotesTab(
    model: AppModel, storeId: String, project: String,
    showAdd: Boolean, closeAdd: () -> Unit,
    showVoice: Boolean, voiceTarget: VoiceCaptureTarget?, closeVoice: () -> Unit,
) {
    val notes = model.notes(storeId, project)
    val isReadOnly = LocalStore.isReadOnlyProject(project)
    var editing by remember { mutableStateOf<Note?>(null) }
    var promoting by remember { mutableStateOf<Note?>(null) }
    val expanded = remember { mutableStateListOf<String>() }
    val grouped = notes.groupBy { it.date }.entries.sortedByDescending { it.key }.map { (d, items) -> d to items.sortedByDescending { it.time } }

    IosRefreshable({ model.pullToRefresh() }, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            grouped.forEach { (date, items) ->
                iosSection("n-$date", items, { it.stableId }, header = date) { note, pos ->
                    val trailing = if (!isReadOnly) listOf(
                        SwipeAction("Delete", Icons.Filled.Delete, PhrenTheme.systemRed) { model.perform(PendingOp.RemoveNote(project, note.date, note.stableId), storeId) },
                        SwipeAction("Edit", Icons.Filled.Edit, PhrenTheme.systemBlue) { editing = note },
                    ) else emptyList()
                    val leading = if (!note.promoted && !isReadOnly) listOf(
                        SwipeAction("Promote", Icons.Filled.ArrowCircleUp, PhrenTheme.systemGreen) { promoting = note },
                    ) else emptyList()
                    SwipeActionsRow(leading, trailing, pos) {
                        IosCell(pos) { NoteRow(note, expanded) }
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
        if (notes.isEmpty()) {
            PhrenEmptyState("No notes", "Jot down a note with the + button. Promote the good ones to findings.", Modifier.align(Alignment.Center))
        }
    }
    if (showAdd) {
        TextEntrySheet("Add note", confirmLabel = "Add", onDismiss = closeAdd) { text, _ ->
            val (date, time) = AppModel.nowNoteTimestamp()
            model.perform(PendingOp.AddNote(project, date, time, text), storeId)
        }
    }
    if (showVoice && voiceTarget != null) VoiceCaptureSheet(model, listOf(voiceTarget), voiceTarget, closeVoice)
    editing?.let { note ->
        TextEntrySheet("Edit note", initialText = note.text, onDismiss = { editing = null }) { text, _ ->
            model.perform(PendingOp.EditNote(project, note.date, note.stableId, text), storeId)
        }
    }
    promoting?.let { note ->
        // promoteNote uses the note's text verbatim (core/note.ts:24); only the type is chosen.
        TextEntrySheet("Promote to finding", initialText = note.text, showsTypePicker = true, confirmLabel = "Promote", onDismiss = { promoting = null }) { _, type ->
            model.perform(PendingOp.PromoteNote(project, note.date, note.stableId, type?.rawValue), storeId)
        }
    }
}

@Composable
private fun NoteRow(note: Note, expandedIds: SnapshotStateList<String>) {
    val isExpanded = note.stableId in expandedIds
    Column(
        Modifier.fillMaxWidth().animateContentSize()
            .clickable(interactionSource = null, indication = null) { if (isExpanded) expandedIds.remove(note.stableId) else expandedIds.add(note.stableId) },
    ) {
        Text(note.text, style = IosType.callout, color = PhrenTheme.text, maxLines = if (isExpanded) Int.MAX_VALUE else COLLAPSED_LINE_LIMIT)
        if (note.text.length > TRUNCATION_CHAR_THRESHOLD) {
            Spacer(Modifier.height(4.dp))
            Text(if (isExpanded) "Show less" else "Show more", style = IosType.caption2.copy(fontWeight = FontWeight.SemiBold), color = PhrenTheme.lavender)
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(note.time, style = IosType.caption2, color = PhrenTheme.tertiaryLabel)
            if (note.promoted) TagChip("promoted", PhrenTheme.ChipRole.GOOD)
        }
    }
}

// Summary

@Composable
private fun SummaryTab(model: AppModel, storeId: String, project: String) {
    IosRefreshable({ model.pullToRefresh() }, Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            val summary = model.summary(storeId, project)
            if (summary != null) {
                SelectionContainer {
                    Text(summary, style = IosType.callout.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.text, modifier = Modifier.fillMaxWidth().padding(16.dp))
                }
            } else {
                PhrenEmptyState("No summary", "This project has no summary.md yet.", Modifier.fillMaxWidth().padding(top = 60.dp))
            }
        }
    }
}
