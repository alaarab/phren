package com.phren.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.FilterAlt
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.android.StoreQueueEntry
import com.phren.kit.PendingOp
import com.phren.kit.QueueItem
import kotlinx.coroutines.launch

@Composable
fun ReviewScreen(model: AppModel, onTriage: (List<StoreQueueEntry>) -> Unit) {
    var projectFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var flaggedOnly by rememberSaveable { mutableStateOf(false) }
    var editMode by remember { mutableStateOf(false) }
    val selection = remember { mutableStateListOf<String>() }
    var editing by remember { mutableStateOf<StoreQueueEntry?>(null) }
    val scope = rememberCoroutineScope()

    val items = model.mergedReviewQueue.filter { e ->
        (projectFilter == null || e.entry.project == projectFilter) && (!flaggedOnly || e.entry.item.risky)
    }
    val triageDeck = QueueItem.Section.entries.flatMap { s -> items.filter { it.entry.item.section == s } }
    val projectNames = model.mergedReviewQueue.map { it.entry.project }.toSortedSet().toList()

    fun approve(entries: List<StoreQueueEntry>) = scope.launch {
        entries.forEach { model.performNow(PendingOp.ApproveQueue(it.entry.project, it.entry.item.line), it.storeId) }
        selection.clear()
    }
    fun reject(entries: List<StoreQueueEntry>) = scope.launch {
        entries.forEach { model.performNow(PendingOp.RejectQueue(it.entry.project, it.entry.item.line), it.storeId) }
        selection.clear()
    }

    IosScreen(
        "Review", large = true,
        leading = {
            IosFilterMenu(
                Icons.Outlined.FilterAlt,
                listOf(
                    listOf(MenuItemSpec("All projects", projectFilter == null) { projectFilter = null }) +
                        projectNames.map { n -> MenuItemSpec(n, projectFilter == n) { projectFilter = n } },
                    if (model.hasMultipleStores) listOf(MenuItemSpec("All stores", model.storeFilter == null) { model.storeFilter = null }) +
                        model.storeDescriptors.map { d -> MenuItemSpec(d.displayName, model.storeFilter == d.id) { model.storeFilter = d.id } } else emptyList(),
                    listOf(MenuItemSpec("Flagged only", flaggedOnly) { flaggedOnly = !flaggedOnly }),
                ),
            )
        },
        trailing = {
            if (!editMode) {
                ToolbarButton(ToolbarAction(icon = Icons.Outlined.Layers, text = "Triage", bold = true, tint = PhrenTheme.accentHover, enabled = triageDeck.isNotEmpty()) { onTriage(triageDeck) })
            }
            ToolbarButton(ToolbarAction(icon = if (editMode) null else Icons.Outlined.Checklist, text = if (editMode) "Done" else "Select", bold = editMode) {
                editMode = !editMode
                if (!editMode) selection.clear()
            })
        },
    ) {
        LiveStatusBar(model)
        ActionErrorBanner(model)
        Box(Modifier.weight(1f)) {
            IosRefreshable({ model.pullToRefresh() }, Modifier.fillMaxSize()) {
                LazyColumn(Modifier.fillMaxSize()) {
                    QueueItem.Section.entries.forEach { section ->
                        val sectionItems = items.filter { it.entry.item.section == section }
                        if (sectionItems.isNotEmpty()) {
                            iosSection("s-${section.rawValue}", sectionItems, { it.id }, header = "${section.rawValue} (${sectionItems.size})") { entry, pos ->
                                ReviewRowCell(
                                    model, entry, pos, editMode, entry.id in selection,
                                    onToggleSelect = { if (entry.id in selection) selection.remove(entry.id) else selection.add(entry.id) },
                                    onApprove = { approve(listOf(entry)) },
                                    onReject = { reject(listOf(entry)) },
                                    onEdit = { editing = entry },
                                )
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
                if (items.isEmpty()) {
                    PhrenEmptyState(
                        "Review queue is clear",
                        "Auto-captured findings land here for approval — approving keeps the finding, rejecting deletes it permanently.",
                        Modifier.align(Alignment.Center),
                    )
                }
            }
        }
        if (editMode) {
            val allSelected = items.isNotEmpty() && selection.size == items.size
            Column(Modifier.fillMaxWidth().background(IosColors.row.copy(alpha = 0.94f))) {
                HorizontalDivider(thickness = 0.5.dp, color = PhrenTheme.separator)
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (allSelected) "Deselect All" else "Select All", style = IosType.footnote,
                        color = if (items.isEmpty()) PhrenTheme.accent.copy(alpha = 0.35f) else PhrenTheme.accent,
                        modifier = Modifier.clickable(enabled = items.isNotEmpty()) {
                            if (allSelected) selection.clear() else { selection.clear(); selection.addAll(items.map { it.id }) }
                        },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(if (selection.isEmpty()) "None selected" else "${selection.size} selected", style = IosType.footnote, color = PhrenTheme.secondaryLabel)
                    Spacer(Modifier.weight(1f))
                    val enabled = selection.isNotEmpty()
                    Text(
                        "Reject", style = IosType.body, color = PhrenTheme.systemRed.copy(alpha = if (enabled) 1f else 0.35f),
                        modifier = Modifier.clickable(enabled = enabled) { reject(items.filter { it.id in selection }) }.padding(horizontal = 8.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Box(
                        Modifier.background(PhrenTheme.accent.copy(alpha = if (enabled) 1f else 0.35f), RoundedCornerShape(50))
                            .clickable(enabled = enabled) { approve(items.filter { it.id in selection }) }
                            .padding(horizontal = 14.dp, vertical = 7.dp),
                    ) { Text("Approve", style = IosType.body.copy(fontWeight = FontWeight.SemiBold), color = androidx.compose.ui.graphics.Color.White) }
                }
            }
        }
    }
    editing?.let { e ->
        TextEntrySheet("Edit before approving", initialText = e.entry.item.text, confirmLabel = "Save", onDismiss = { editing = null }) { text, _ ->
            model.perform(PendingOp.EditQueue(e.entry.project, e.entry.item.line, text), e.storeId)
        }
    }
}

@Composable
private fun ReviewRowCell(
    model: AppModel, entry: StoreQueueEntry, pos: RowPosition, editMode: Boolean, selected: Boolean,
    onToggleSelect: () -> Unit, onApprove: () -> Unit, onReject: () -> Unit, onEdit: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val bg = if (entry.entry.item.risky) PhrenTheme.amber.copy(alpha = 0.08f).compositeOver(PhrenTheme.bg) else IosColors.row
    val leading = if (editMode) emptyList() else listOf(SwipeAction("Approve", Icons.Filled.Check, PhrenTheme.systemGreen, onApprove))
    val trailing = if (editMode) emptyList() else listOf(
        SwipeAction("Reject", Icons.Filled.Close, PhrenTheme.systemRed, onReject),
        SwipeAction("Edit", Icons.Filled.Edit, PhrenTheme.systemBlue, onEdit),
    )
    Box {
        SwipeActionsRow(leading, trailing, pos) {
            IosCell(pos, background = bg, onClick = if (editMode) onToggleSelect else null, onLongClick = if (editMode) null else ({ menu = true })) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (editMode) {
                        if (selected) Icon(Icons.Filled.CheckCircle, "Selected", tint = PhrenTheme.accent, modifier = Modifier.size(22.dp))
                        else Icon(Icons.Outlined.Circle, "Not selected", tint = PhrenTheme.tertiaryLabel, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(12.dp))
                    }
                    ReviewRow(entry, model.hasMultipleStores)
                }
            }
        }
        ContextMenu(
            menu, { menu = false },
            listOf(
                Triple("Approve", Icons.Filled.Check, false to onApprove),
                Triple("Edit", Icons.Filled.Edit, false to onEdit),
                Triple("Reject", Icons.Filled.Close, true to onReject),
            ),
        )
    }
}

@Composable
private fun ReviewRow(entry: StoreQueueEntry, showStore: Boolean) {
    val item = entry.entry.item
    Column(Modifier.padding(vertical = 2.dp)) {
        Text(item.text, style = IosType.callout, color = PhrenTheme.text)
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TagChip(entry.entry.project, PhrenTheme.ChipRole.PROJECT)
            if (showStore) TagChip(entry.storeName, PhrenTheme.ChipRole.STORE)
            item.confidence?.let { TagChip("%.0f%%".format(it * 100), if (it < 0.7) PhrenTheme.amber else PhrenTheme.green) }
            item.machine?.let { Text(it, style = IosType.caption2, color = PhrenTheme.secondaryLabel, maxLines = 1) }
            item.model?.let { Text(it, style = IosType.caption2, color = PhrenTheme.secondaryLabel, maxLines = 1) }
            Spacer(Modifier.weight(1f))
            Text(item.date, style = IosType.caption2, color = PhrenTheme.tertiaryLabel)
        }
    }
}
