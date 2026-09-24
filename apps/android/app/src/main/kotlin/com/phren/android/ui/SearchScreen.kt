package com.phren.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.FilterAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.kit.SearchIndex

@Composable
fun SearchScreen(model: AppModel, stack: NavStack) {
    NavHostStack(stack, root = { SearchRoot(model, stack) }) { route ->
        when (route) {
            is Route.ProjectDetail -> ProjectDetailScreen(model, stack, route.storeId, route.project)
            is Route.Archive -> ArchiveBrowserScreen(model, stack, route.storeId, route.project)
            is Route.ArchiveTopic -> ArchiveTopicScreen(model, stack, route.storeId, route.topic)
            else -> {}
        }
    }
}

private fun kindColor(kind: SearchIndex.DocKind): Color = when (kind) {
    SearchIndex.DocKind.FINDING -> PhrenTheme.amber
    SearchIndex.DocKind.NOTE -> PhrenTheme.cyan
    SearchIndex.DocKind.TASK -> PhrenTheme.green
    SearchIndex.DocKind.SUMMARY -> PhrenTheme.textMuted
    SearchIndex.DocKind.TRUTH -> PhrenTheme.accent
}

@Composable
private fun SearchRoot(model: AppModel, stack: NavStack) {
    var query by rememberSaveable { mutableStateOf("") }
    var storeFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var projectFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var kindFilter by rememberSaveable { mutableStateOf<SearchIndex.DocKind?>(null) }
    val results = model.searchIndex.search(query, storeFilter, projectFilter, kindFilter)
    val projectNames = model.mergedProjects.map { it.project.name }.toSortedSet().toList()

    IosScreen(
        "Search", large = true,
        leading = {
            IosFilterMenu(
                Icons.Outlined.FilterAlt,
                listOf(
                    listOf(MenuItemSpec("All projects", projectFilter == null) { projectFilter = null }) +
                        projectNames.map { n -> MenuItemSpec(n, projectFilter == n) { projectFilter = n } },
                    if (model.hasMultipleStores) listOf(MenuItemSpec("All stores", storeFilter == null) { storeFilter = null }) +
                        model.storeDescriptors.map { d -> MenuItemSpec(d.displayName, storeFilter == d.id) { storeFilter = d.id } } else emptyList(),
                    listOf(MenuItemSpec("Everything", kindFilter == null) { kindFilter = null }) +
                        SearchIndex.DocKind.entries.map { k -> MenuItemSpec(k.rawValue, kindFilter == k) { kindFilter = k } },
                ),
            )
        },
    ) {
        LiveStatusBar(model)
        ActionErrorBanner(model)
        IosSearchField(query, { query = it }, "Search findings, notes, tasks…")
        Box(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize()) {
                if (query.isNotEmpty()) {
                    iosSection("results", results, { it.id }) { result, pos ->
                        IosCell(pos, onClick = {
                            val title = if (model.hasMultipleStores) "${result.project} · ${model.storeName(result.store)}" else result.project
                            stack.push(Route.ProjectDetail(result.store, result.project, title))
                        }) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f).padding(vertical = 2.dp)) {
                                    Text(result.text, style = IosType.callout, color = PhrenTheme.text, maxLines = 4)
                                    Spacer(Modifier.height(4.dp))
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        TagChip(result.project, PhrenTheme.ChipRole.PROJECT)
                                        if (model.hasMultipleStores && result.store.isNotEmpty()) TagChip(model.storeName(result.store), PhrenTheme.ChipRole.STORE)
                                        TagChip(result.kind.rawValue, kindColor(result.kind))
                                        result.typeTag?.let { TagChip(it, PhrenTheme.ChipRole.TYPE) }
                                        Spacer(Modifier.weight(1f))
                                        result.date?.let { Text(it, style = IosType.caption2, color = PhrenTheme.tertiaryLabel) }
                                    }
                                }
                                DisclosureChevron()
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
            if (query.isEmpty()) {
                PhrenEmptyState(
                    "Search your memory",
                    "Findings, truths, notes, tasks, and summaries — all searched on-device. Archived findings are excluded, the same way the CLI leaves them out of its own index.",
                    Modifier.align(Alignment.Center),
                )
            } else if (results.isEmpty()) {
                // ContentUnavailableView.search(text:)
                Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Search, null, tint = PhrenTheme.secondaryLabel, modifier = Modifier.size(48.dp))
                    Spacer(Modifier.height(12.dp))
                    Text("No Results for “$query”", style = IosType.title2, color = PhrenTheme.text, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(6.dp))
                    Text("Check the spelling or try a new search.", style = IosType.subheadline, color = PhrenTheme.secondaryLabel, textAlign = TextAlign.Center)
                }
            }
        }
    }
}
