package com.phren.android.features

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.phren.android.StoreQueueEntry
import com.phren.android.design.FormRow
import com.phren.android.design.FormRows
import com.phren.android.design.FormSection
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenActionSheet
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenForm
import com.phren.android.design.PhrenIconButton
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.SF
import com.phren.android.design.SectionLabel
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.design.sessionCard
import com.phren.kit.PendingOp
import com.phren.kit.QueueItem
import kotlinx.coroutines.launch

/** An optional project overview, not an inbox of required decisions (MemoryMaintenanceView). */
@Composable
fun MemoryMaintenanceView() {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val groups = model.mergedReviewQueue.groupBy { "${it.storeId}/${it.entry.project}" }.values
        .map { entries -> Triple(entries.first().storeId, entries.first().entry.project, entries) }
        .sortedWith(compareBy({ it.second }, { it.first }))
    PhrenNavScreen("Memory maintenance", onBack = navigator::pop) {
        Refreshable {
            PhrenForm {
                FormSection {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Your agents capture and use memory as you work. You can leave routine maintenance to an agent, or inspect a project here.",
                            style = PhrenType.body, color = PhrenTheme.textSecondary)
                        Text("These entries can include candidates, stale memories, and conflicts. They are not approvals required for every agent action.",
                            style = PhrenType.caption, color = PhrenTheme.textSecondary)
                    }
                }
                FormSection("By project") {
                    if (groups.isEmpty()) {
                        Text("No maintenance entries in these stores.", style = PhrenType.body, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
                    } else FormRows(groups.size, inset = 16.dp) { i ->
                        val (storeId, project, entries) = groups[i]
                        val summary = QueueItem.Section.entries.mapNotNull { section ->
                            val count = entries.count { it.entry.item.section == section }
                            if (count == 0) null else "$count ${if (section == QueueItem.Section.REVIEW) "candidates" else section.rawValue.lowercase()}"
                        }.joinToString(" · ")
                        FormRow(project, identifier = "maintenance-project:$storeId:$project", onClick = {
                            navigator.push("review:$storeId/$project") { ReviewView(storeId, project) }
                        }, trailing = null, subtitle = "$storeId\n$summary")
                    }
                }
            }
        }
    }
}

/** Optional maintenance for one project's queue, scoped to its source store (ReviewView). */
@Composable
fun ReviewView(storeId: String, project: String) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    var flaggedOnly by remember { mutableStateOf(false) }
    var selection by remember { mutableStateOf(setOf<String>()) }
    var selecting by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<StoreQueueEntry?>(null) }
    var triaging by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var showingOptions by remember { mutableStateOf(false) }
    var actionEntry by remember { mutableStateOf<StoreQueueEntry?>(null) }

    val items = model.snapshot(storeId).reviewQueue
        .filter { it.project == project && (!flaggedOnly || it.item.risky) }
        .map { StoreQueueEntry(storeId, model.storeName(storeId), it) }
    val deck = QueueItem.Section.entries.flatMap { s -> items.filter { it.entry.item.section == s } }
    val ids = items.map { it.id }.toSet()
    if (!selection.all { it in ids }) selection = selection intersect ids

    fun approve(entries: List<StoreQueueEntry>) = model.scope.launch {
        entries.forEach { model.performNow(PendingOp.ApproveQueue(it.entry.project, it.entry.item.line), it.storeId) }
        selection = emptySet()
    }
    fun reject(entries: List<StoreQueueEntry>) = model.scope.launch {
        entries.forEach { model.performNow(PendingOp.RejectQueue(it.entry.project, it.entry.item.line), it.storeId) }
        selection = emptySet()
    }
    fun read(entry: StoreQueueEntry) = navigator.push("queue:${entry.id}") {
        PhrenNavScreen("Memory entry", onBack = navigator::pop) {
            PhrenForm {
                FormSection {
                    SelectionContainer { Text(inlineMarkdown(entry.entry.item.text), style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.padding(16.dp)) }
                }
                FormSection {
                    val fields = listOf("Project" to entry.entry.project, "Store" to entry.storeId, "Category" to entry.entry.item.section.rawValue)
                    FormRows(fields.size, inset = 16.dp) { i -> FormRow(fields[i].first, value = fields[i].second, chevron = false) }
                }
            }
        }
    }

    PhrenNavScreen(
        project, onBack = navigator::pop,
        trailing = listOf(
            ToolbarItem(icon = SF("line.3.horizontal.decrease"), label = "Maintenance options", identifier = "review-options") { showingOptions = true },
            ToolbarItem(text = if (selecting) "Done" else "Select", label = if (selecting) "Done" else "Select", identifier = "review-select") {
                selecting = !selecting; selection = emptySet()
            },
        ),
    ) {
        LiveStatusBar()
        ActionErrorBanner()
        Box(Modifier.weight(1f)) {
            Refreshable {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 8.dp, bottom = if (selecting) 24.dp else 110.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    item(key = "header") {
                        Column(Modifier.fillMaxWidth().sessionCard().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(storeId, style = PhrenType.caption, color = PhrenTheme.textSecondary)
                            Row(Modifier.heightIn(min = 32.dp).plainClickable {
                                val request = """
                                    Inspect memory maintenance for project $project in Phren store $storeId.
                                    Read its review queue and current project context. Summarize candidates,
                                    stale memories, and conflicts by theme. Suggest a batch of useful updates and
                                    call out ambiguous or destructive decisions for me. Do not blindly approve
                                    or discard the queue just to clear its count.
                                """.trimIndent()
                                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Agent request", request))
                                copied = true
                            }.phrenIdentifier("review-copy-request"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Icon(SF("doc.on.doc"), null, tint = PhrenTheme.navigation, modifier = Modifier.size(16.dp))
                                Text(if (copied) "Agent request copied" else "Copy request for my agent", style = PhrenType.body, color = PhrenTheme.navigation)
                            }
                            Text("Paste this into your agent conversation. You can also select several entries below for manual maintenance.",
                                style = PhrenType.caption, color = PhrenTheme.textMuted)
                        }
                    }
                    QueueItem.Section.entries.forEach { section ->
                        val sectionItems = items.filter { it.entry.item.section == section }
                        if (sectionItems.isNotEmpty()) {
                            item(key = "s:${section.rawValue}") { SectionLabel("${section.rawValue} (${sectionItems.size})", leading = 0.dp) }
                            items(sectionItems, key = { it.id }) { entry ->
                                val selected = selecting && entry.id in selection
                                Box(Modifier.fillMaxWidth().sessionCard()
                                    .then(if (entry.entry.item.risky) Modifier.background(PhrenTheme.amber.copy(alpha = 0.08f), RoundedCornerShape(PhrenTheme.Radius.medium)) else Modifier)) {
                                    Row(
                                        Modifier.fillMaxWidth().plainClickable {
                                            if (selecting) selection = if (entry.id in selection) selection - entry.id else selection + entry.id else read(entry)
                                        }.phrenIdentifier("review-row:${entry.id}").padding(start = 12.dp, top = 12.dp, bottom = 12.dp, end = 56.dp),
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        if (selecting) Icon(SF(if (selected) "checkmark.circle.fill" else "circle"), null,
                                            tint = if (selected) PhrenTheme.cyan else PhrenTheme.textDim, modifier = Modifier.size(20.dp))
                                        ReviewRow(entry, showStore = false)
                                    }
                                    Box(Modifier.align(Alignment.CenterEnd).padding(end = 4.dp)) {
                                        PhrenIconButton(SF("ellipsis"), "Entry actions", modifier = Modifier.phrenIdentifier("review-actions:${entry.id}")) { actionEntry = entry }
                                    }
                                }
                            }
                        }
                    }
                    if (items.isEmpty()) item {
                        Text("No maintenance entries for this project and filter.", style = PhrenType.caption, color = PhrenTheme.textMuted, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                    }
                }
            }
        }
        if (selecting) {
            val allSelected = items.isNotEmpty() && selection.size == items.size
            Row(Modifier.fillMaxWidth().background(PhrenTheme.surface).padding(16.dp).padding(bottom = 80.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(if (allSelected) "Deselect All" else "Select All", style = PhrenType.footnote, color = if (items.isEmpty()) PhrenTheme.textDim else PhrenTheme.navigation,
                    modifier = Modifier.plainClickable(items.isNotEmpty()) { selection = if (allSelected) emptySet() else ids })
                Text(if (selection.isEmpty()) "None selected" else "${selection.size} selected", style = PhrenType.footnote, color = PhrenTheme.textSecondary)
                Spacer(Modifier.weight(1f))
                Text("Reject", style = PhrenType.body, color = if (selection.isEmpty()) PhrenTheme.textDim else Color(0xFFFF453A),
                    modifier = Modifier.plainClickable(selection.isNotEmpty()) { reject(items.filter { it.id in selection }) }.phrenIdentifier("review-batch-reject"))
                Text("Approve", style = PhrenType.body.medium(), color = Color.White,
                    modifier = Modifier.background(if (selection.isEmpty()) PhrenTheme.surfaceRaised else PhrenTheme.accentSolid, CircleShape)
                        .plainClickable(selection.isNotEmpty()) { approve(items.filter { it.id in selection }) }.phrenIdentifier("review-batch-approve")
                        .padding(horizontal = 14.dp, vertical = 7.dp))
            }
        }
    }

    if (showingOptions) PhrenActionSheet("Maintenance options", listOf(
        PhrenControlAction("flagged", "Flagged only", SF("flag"), isSelected = flaggedOnly, dismisses = false) { flaggedOnly = !flaggedOnly; selection = emptySet() },
        PhrenControlAction("triage", "Review individually", SF("square.stack"), isEnabled = deck.isNotEmpty()) { triaging = true },
    ), identifier = "review-options-sheet") { showingOptions = false }
    actionEntry?.let { entry ->
        PhrenActionSheet("Memory entry", listOf(
            PhrenControlAction("approve", "Approve", SF("checkmark")) { approve(listOf(entry)) },
            PhrenControlAction("edit", "Edit", SF("pencil")) { editing = entry },
            PhrenControlAction("reject", "Reject", SF("xmark"), role = PhrenControlAction.Role.DESTRUCTIVE) { reject(listOf(entry)) },
        ), identifier = "review-entry-actions") { actionEntry = null }
    }
    editing?.let { entry ->
        PhrenSheet({ editing = null }) {
            TextEntrySheet("Edit before approving", initialText = entry.entry.item.text, confirmLabel = "Save") { text, _ ->
                model.performNow(PendingOp.EditQueue(entry.entry.project, entry.entry.item.line, text), entry.storeId)
            }
        }
    }
    if (triaging) {
        // `.fullScreenCover`
        Dialog({ triaging = false }, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
            TriageView(model, deck) { triaging = false }
        }
    }
}

@Composable
fun ReviewRow(entry: StoreQueueEntry, showStore: Boolean) {
    val item = entry.entry.item
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(inlineMarkdown(item.text), style = PhrenType.callout, color = PhrenTheme.text, maxLines = 4, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TagChip(entry.entry.project, PhrenTheme.ChipRole.PROJECT)
            if (showStore) TagChip(entry.storeName, PhrenTheme.ChipRole.STORE)
            item.confidence?.let { TagChip("%.0f%%".format(it * 100), color = if (it < 0.7) PhrenTheme.amber else PhrenTheme.green) }
            item.machine?.let { Text(it, style = PhrenType.caption2, color = PhrenTheme.textSecondary) }
            item.model?.let { Text(it, style = PhrenType.caption2, color = PhrenTheme.textSecondary) }
            Spacer(Modifier.weight(1f))
            Text(item.date, style = PhrenType.caption2, color = PhrenTheme.textDim)
        }
    }
}
