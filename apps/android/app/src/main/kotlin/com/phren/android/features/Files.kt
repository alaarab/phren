package com.phren.android.features

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenChip
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenEmptyState
import com.phren.android.design.PhrenFileTypeIcon
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenScrollScreen
import com.phren.android.design.PhrenSearchField
import com.phren.android.design.PhrenSectionHeader
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PhrenType.mono
import com.phren.android.design.SF
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.kit.LocalStore
import java.io.File

/** The store's files, grouped by top-level folder (FilesView.swift). */
@Composable
fun FilesView() {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var storeId by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    val contexts = model.storeContexts
    val active = storeId ?: contexts.firstOrNull()?.id
    val paths = remember(active, query, contexts.firstOrNull { it.id == active }?.snapshot?.revision) {
        val c = contexts.firstOrNull { it.id == active } ?: return@remember emptyList()
        val q = query.trim().lowercase()
        c.store.allPaths().filter { !it.endsWith(".phren-team.yaml") && (q.isEmpty() || it.lowercase().contains(q)) }.sorted()
    }
    val groups = paths.groupBy { if (it.contains("/")) it.substringBefore("/") else "" }.toSortedMap(compareBy { it.ifEmpty { "~" } })

    PhrenNavScreen("Files", onBack = navigator::pop) {
        PhrenScrollScreen(spacing = 4.dp) {
            if (contexts.isEmpty()) {
                item { PhrenEmptyState("No store", "Connect a store to browse its files.") }
                return@PhrenScrollScreen
            }
            if (contexts.size > 1) item {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    contexts.forEach { c ->
                        Box(Modifier.plainClickable { storeId = c.id }) {
                            PhrenChip(c.descriptor.displayName, if (c.id == active) PhrenTheme.ChipRole.PROJECT else PhrenTheme.ChipRole.SCOPE)
                        }
                    }
                }
            }
            item { PhrenSearchField(query, { query = it }, placeholder = "Filter files", identifier = "files-filter", modifier = Modifier.fillMaxWidth()) }
            if (active != null) {
                if (groups.isEmpty()) item { Text("No files match “$query”.", style = PhrenType.footnote, color = PhrenTheme.textMuted) }
                groups.forEach { (folder, files) ->
                    item(key = "h:$folder") { PhrenSectionHeader(folder.ifEmpty { "Store root" }, count = files.size) }
                    items(files, key = { it }) { path ->
                        Row(Modifier.fillMaxWidth().background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.small))
                            .plainClickable { navigator.push("file:$active/$path") { StoreFileViewer(active, path) } }
                            .phrenIdentifier("file:$path").padding(horizontal = 12.dp, vertical = 9.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PhrenFileTypeIcon(path)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                Text(path.substringAfterLast('/'), style = PhrenType.subheadline.mono().medium(), color = PhrenTheme.text, maxLines = 1)
                                Text(path, style = PhrenType.caption2, color = PhrenTheme.textMuted, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                            }
                            Icon(SF("chevron.right"), null, tint = PhrenTheme.textDim, modifier = Modifier.size(12.dp))
                        }
                    }
                }
            }
        }
    }
}

/** A store file in the shared viewer, with Copy and (where the path allows it) Edit (FileViewerView). */
@Composable
fun StoreFileViewer(storeId: String, path: String) {
    val model = LocalModel.current
    val context = LocalContext.current
    var editing by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    val store = model.storeContexts.firstOrNull { it.id == storeId }?.store
    val content = store?.read(path) ?: ""
    // phren.project.yaml is writable but belongs to the Knobs screen: a raw edit could drop sibling keys.
    val writable = model.canPush(storeId) && LocalStore.isWritablePath(path) && !LocalStore.isProjectConfigPath(path)
    val local = remember(content) {
        File(context.cacheDir, "file-viewer/store/${storeId.replace('/', '_')}/$path").apply { parentFile?.mkdirs(); writeText(content) }
    }
    androidx.compose.runtime.key(content) {
        FileViewer(FileViewerItem(path.substringAfterLast('/'), local = local), actions = buildList {
            add(PhrenControlAction("copy", if (copied) "Copied" else "Copy file", SF(if (copied) "checkmark" else "doc.on.doc")) { copyToClipboard(context, content); copied = true })
            if (writable) add(PhrenControlAction("edit", "Edit", SF("pencil")) { editing = true })
        })
    }
    if (editing) PhrenSheet({ editing = false }) { DocumentEditorSheet(path.substringAfterLast('/'), storeId, DocumentDraft(path, content)) }
}
