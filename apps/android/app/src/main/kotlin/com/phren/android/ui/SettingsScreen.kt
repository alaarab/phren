package com.phren.android.ui

import android.content.Intent
import android.net.Uri
import android.text.format.DateUtils
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowCircleUp
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.android.CaptureLog
import com.phren.android.CaptureLogEntry
import com.phren.android.CaptureQueueState
import com.phren.android.CaptureSyncState
import com.phren.android.FailedOpEntry
import com.phren.android.PhrenCapture
import com.phren.android.PhrenCaptureTarget
import com.phren.android.QuickCaptureDefault
import com.phren.android.StoreContext
import com.phren.kit.StorageIssue
import com.phren.kit.StoreDescriptor
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
fun SettingsScreen(model: AppModel, stack: NavStack) {
    NavHostStack(stack, root = { SettingsRoot(model, stack) }) { route ->
        when (route) {
            is Route.ProjectDetail -> ProjectDetailScreen(model, stack, route.storeId, route.project)
            is Route.Archive -> ArchiveBrowserScreen(model, stack, route.storeId, route.project)
            is Route.ArchiveTopic -> ArchiveTopicScreen(model, stack, route.storeId, route.topic)
            else -> {}
        }
    }
}

@Composable
private fun SettingsRoot(model: AppModel, stack: NavStack) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var failedOps by remember { mutableStateOf<List<FailedOpEntry>>(emptyList()) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var showAddStore by remember { mutableStateOf(false) }
    var removingStore by remember { mutableStateOf<StoreDescriptor?>(null) }
    var captureTargets by remember { mutableStateOf<List<PhrenCaptureTarget>>(emptyList()) }
    var captureDefaultId by remember { mutableStateOf<String?>(null) }
    var captureLog by remember { mutableStateOf<List<CaptureLogEntry>>(emptyList()) }
    var captureQueue by remember { mutableStateOf(CaptureQueueState()) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val listState = rememberLazyListState()

    suspend fun reloadCaptureState() {
        captureTargets = PhrenCapture.targets(model)
        captureDefaultId = QuickCaptureDefault.load(model.prefs)?.let { "${it.storeId}|${it.project}" }
        captureLog = CaptureLog.entries(model.prefs)
        captureQueue = CaptureQueueState.sample(model)
    }

    LaunchedEffect(Unit) {
        failedOps = model.failedOps()
        reloadCaptureState()
    }
    // A capture landing or a flush finishing moves the pending count.
    LaunchedEffect(model.syncStatus.pendingCount) { reloadCaptureState() }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = System.currentTimeMillis() } }

    fun projectExists(e: CaptureLogEntry) = model.storeContexts.firstOrNull { it.id == e.storeId }?.snapshot?.projects?.any { it.name == e.project } ?: false
    fun destination(e: CaptureLogEntry) = if (model.hasMultipleStores) "${e.project} · ${model.storeName(e.storeId)}" else e.project
    fun queuedCaptures(storeId: String) = captureLog.count { it.storeId == storeId && captureQueue.state(it) == CaptureSyncState.QUEUED }
    val unavailableDefault = captureDefaultId?.takeIf { id -> captureTargets.none { it.entityId == id } }?.let { id ->
        val (storeId, project) = id.split("|", limit = 2)
        id to "$project · ${model.storeName(storeId)}"
    }

    // Where the "Needs attention" header lands, counted the way the list below
    // is built (header + rows + footer per section).
    val healthCount = model.storeContexts.size + model.duplicateProjectGroups.size + model.storageIssues.size
    val accountCount = (if (model.user != null) 1 + (if (model.user?.name != null) 1 else 0) else 0) + 1
    val syncCount = 3 + (if (model.syncStatus.lastSyncedAt != null) 1 else 0) + (if (model.syncStatus.lastError != null) 1 else 0)
    val attentionIndex = (1 + healthCount + 1) + 3 +
        (if (captureLog.isNotEmpty()) 1 + captureLog.size + 1 + 1 else 0) +
        (1 + accountCount) + (1 + model.storeContexts.size + 1 + 1) + (1 + syncCount)

    IosScreen("Settings", large = true) {
        ActionErrorBanner(model)
        IosRefreshable({ model.pullToRefresh(); failedOps = model.failedOps(); reloadCaptureState() }, Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), state = listState) {
                // Store health
                val healthRows: List<Any> = model.storeContexts.toList() + model.duplicateProjectGroups + model.storageIssues
                iosSection(
                    "health", healthRows, { (it as? StoreContext)?.id ?: (it as? StorageIssue)?.id ?: it.toString() }, header = "Store health",
                    footer = "A store card turns amber when a sync has failed or gone quiet for more than 10 minutes while the app is open.",
                ) { row, pos ->
                    IosCell(pos) {
                        when (row) {
                            is StoreContext -> StoreHealthCard(row, model.claimedElsewhere(row.id), queuedCaptures(row.id), now) {
                                scope.launch { listState.animateScrollToItem(attentionIndex) }
                            }
                            is StorageIssue -> StorageIssueRow(row)
                            is List<*> -> DuplicateHint(row.filterIsInstance<String>())
                        }
                    }
                }

                // Quick capture
                item { IosSectionHeader("Quick capture") }
                item {
                    IosCell(RowPosition.ONLY) {
                        val options = listOf<Pair<String?, String>>(null to "Always ask") +
                            (unavailableDefault?.let { listOf(it.first to "${it.second} — unavailable") } ?: emptyList()) +
                            captureTargets.map { it.entityId to it.displayName }
                        FormPicker("Default project", options, captureDefaultId) { value ->
                            captureDefaultId = value
                            val parts = value?.split("|", limit = 2)
                            if (parts == null || parts.size != 2 || parts.any { it.isEmpty() }) QuickCaptureDefault.clear(model.prefs)
                            else QuickCaptureDefault.save(model.prefs, parts[0], parts[1])
                        }
                    }
                }
                item {
                    Column(Modifier.padding(start = 32.dp, end = 32.dp, top = 7.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        unavailableDefault?.let {
                            Text("'${it.second}' isn't in an attached, writable store any more — captures ask where to go until you pick a new default.", style = IosType.footnote, color = PhrenTheme.warning)
                        }
                        Text(
                            "Where a capture goes when you don't name a project: the Add Task / Add Note shortcuts, \"Hey Google\", the quick-settings tile, or the mic button. With 'Always ask', captures ask every time — nothing is ever filed somewhere you didn't choose.",
                            style = IosType.footnote, color = PhrenTheme.secondaryLabel,
                        )
                    }
                }

                // Recent captures
                if (captureLog.isNotEmpty()) {
                    val rows: List<CaptureLogEntry?> = captureLog + null
                    iosSection(
                        "captures", rows, { it?.id ?: "clear" }, header = "Recent captures",
                        footer = "The last ${CaptureLog.LIMIT} notes and tasks captured on this device, newest first. Tap one to open the project it went to. Clearing the list doesn't remove anything from your store.",
                    ) { entry, pos ->
                        if (entry == null) {
                            IosCell(pos, onClick = { CaptureLog.clear(model.prefs); captureLog = emptyList() }) {
                                Text("Clear list", style = IosType.body, color = PhrenTheme.accent)
                            }
                        } else {
                            val exists = projectExists(entry)
                            IosCell(pos, onClick = if (exists) ({
                                val title = if (model.hasMultipleStores) "${entry.project} · ${model.storeName(entry.storeId)}" else entry.project
                                stack.push(Route.ProjectDetail(entry.storeId, entry.project, title))
                            }) else null) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    CaptureLogRow(entry, destination(entry), captureQueue.state(entry), !exists, now, Modifier.weight(1f))
                                    if (exists) DisclosureChevron()
                                }
                            }
                        }
                    }
                }

                // Account
                val user = model.user
                val accountRows = buildList<Pair<String, String?>> {
                    if (user != null) {
                        add("GitHub" to "@${user.login}")
                        user.name?.let { add("Name" to it) }
                    }
                    add("__signout" to null)
                }
                iosSection("account", accountRows, { it.first }, header = "Account") { (label, value), pos ->
                    if (label == "__signout") IosCell(pos, onClick = { confirmSignOut = true }) { Text("Sign out", style = IosType.body, color = PhrenTheme.systemRed) }
                    else IosCell(pos) { LabeledContent(label, value ?: "") }
                }

                // Stores
                val storeRows: List<StoreContext?> = model.storeContexts.toList() + null
                iosSection(
                    "stores", storeRows, { it?.id ?: "add" }, header = "Stores",
                    footer = "Each store is a GitHub repository holding a phren store. Removing one only deletes this device's local copy.",
                ) { c, pos ->
                    if (c == null) {
                        IosCell(pos, onClick = { showAddStore = true }) { RowLabel("Add store", Icons.Filled.Add) }
                    } else {
                        SwipeActionsRow(trailing = listOf(SwipeAction("Remove", Icons.Filled.Delete, PhrenTheme.systemRed) { removingStore = c.descriptor }), position = pos) {
                            IosCell(pos) { StoreRow(c) }
                        }
                    }
                }

                // Sync
                val status = model.syncStatus
                val syncRows = buildList {
                    add("live"); if (status.lastSyncedAt != null) add("last"); add("pending"); if (status.lastError != null) add("error"); add("now")
                }
                iosSection("sync", syncRows, { it }, header = "Sync") { row, pos ->
                    when (row) {
                        "live" -> IosCell(pos) { LabeledContent("Live updates", if (status.isLive) "On" else "Paused") }
                        "last" -> IosCell(pos) { LabeledContent("Last synced", status.lastSyncedAt!!.atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.MEDIUM))) }
                        "pending" -> IosCell(pos) { LabeledContent("Pending changes", "${status.pendingCount}") }
                        "error" -> IosCell(pos) { Text(status.lastError ?: "", style = IosType.footnote, color = PhrenTheme.systemRed) }
                        else -> IosCell(pos, onClick = { scope.launch { model.pullToRefresh(); failedOps = model.failedOps() } }) {
                            Text("Sync now", style = IosType.body, color = PhrenTheme.accent)
                        }
                    }
                }

                // Needs attention
                if (failedOps.isNotEmpty()) {
                    val rows: List<FailedOpEntry?> = failedOps + null
                    iosSection(
                        "attention", rows, { it?.id ?: "retry" }, header = "Needs attention",
                        footer = "These changes couldn't be applied — usually because the item changed on another machine. Retry or discard them.",
                    ) { failed, pos ->
                        if (failed == null) {
                            IosCell(pos, onClick = { scope.launch { model.retryFailedOps(); failedOps = model.failedOps() } }) {
                                Text("Retry all", style = IosType.body, color = PhrenTheme.accent)
                            }
                        } else {
                            SwipeActionsRow(
                                trailing = listOf(SwipeAction("Discard", Icons.Filled.Delete, PhrenTheme.systemRed) {
                                    scope.launch { model.discardFailedOp(failed.storeId, failed.op.id); failedOps = model.failedOps() }
                                }),
                                position = pos,
                            ) {
                                IosCell(pos) {
                                    Column {
                                        Text(failed.op.op.label, style = IosType.callout, color = PhrenTheme.text)
                                        Spacer(Modifier.height(3.dp))
                                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                            if (model.hasMultipleStores) TagChip(failed.storeName, PhrenTheme.ChipRole.STORE)
                                            failed.op.lastError?.let { Text(it, style = IosType.caption, color = PhrenTheme.systemRed) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // About
                iosSection("about", listOf("app", "link"), { it }, header = "About") { row, pos ->
                    if (row == "app") IosCell(pos) { LabeledContent("App", "phren for Android") }
                    else IosCell(pos, onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/alaarab/phren"))) }) {
                        Text("phren on GitHub", style = IosType.body, color = PhrenTheme.accent)
                    }
                }
                item { Spacer(Modifier.height(32.dp)) }
            }
        }
    }

    if (showAddStore) {
        IosSheet({ showAddStore = false }, "Add store", background = PhrenTheme.bg) {
            RepoPickerList(model, model.storeDescriptors.map { it.id }.toSet()) { repo ->
                showAddStore = false
                model.scope.launch { model.addStore(repo) }
            }
        }
    }
    removingStore?.let { store ->
        IosAlert(
            "Remove ${store.id} from this device? The GitHub repository is not affected.", null,
            onDismiss = { removingStore = null },
            buttons = listOf(
                Triple("Remove store", true) { removingStore = null; model.scope.launch { model.removeStore(store.id) } },
                Triple("Cancel", false) { removingStore = null },
            ),
        )
    }
    if (confirmSignOut) {
        IosAlert(
            "Sign out and remove the local copies of all stores from this device?", null,
            onDismiss = { confirmSignOut = false },
            buttons = listOf(
                Triple("Sign out", true) { confirmSignOut = false; model.scope.launch { model.signOut() } },
                Triple("Cancel", false) { confirmSignOut = false },
            ),
        )
    }
}

/** `LabeledContent`: label left, secondary value right. */
@Composable
fun LabeledContent(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = IosType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        Text(value, style = IosType.body, color = PhrenTheme.secondaryLabel)
    }
}

private fun relative(millis: Long, now: Long): String =
    DateUtils.getRelativeTimeSpanString(millis, now, DateUtils.SECOND_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString()

@Composable
private fun IconLabel(icon: ImageVector, text: String, color: Color, style: androidx.compose.ui.text.TextStyle = IosType.caption, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = color, modifier = Modifier.size(13.dp))
        Spacer(Modifier.width(4.dp))
        Text(text, style = style, color = color)
    }
}

@Composable
private fun CaptureLogRow(entry: CaptureLogEntry, destination: String, state: CaptureSyncState, missing: Boolean, now: Long, modifier: Modifier) {
    val stateColor = when (state) {
        CaptureSyncState.SYNCED -> PhrenTheme.textDim
        CaptureSyncState.QUEUED -> PhrenTheme.amber
        CaptureSyncState.FAILED -> PhrenTheme.danger
    }
    val stateIcon = when (state) {
        CaptureSyncState.SYNCED -> Icons.Filled.CheckCircle
        CaptureSyncState.QUEUED -> Icons.Filled.ArrowCircleUp
        CaptureSyncState.FAILED -> Icons.Filled.Warning
    }
    Column(modifier.padding(vertical = 2.dp)) {
        Text(entry.snippet, style = IosType.callout, color = PhrenTheme.text, maxLines = 2)
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(if (entry.kind == CaptureLogEntry.Kind.NOTE) Icons.AutoMirrored.Outlined.Notes else Icons.Outlined.Checklist, null, tint = PhrenTheme.textMuted, modifier = Modifier.size(13.dp))
            Spacer(Modifier.width(6.dp))
            Text(destination, style = IosType.caption.copy(fontWeight = FontWeight.Medium), color = PhrenTheme.textMuted, maxLines = 1)
            if (missing) { Spacer(Modifier.width(6.dp)); Text("(not in an attached store)", style = IosType.caption, color = PhrenTheme.warning) }
            Spacer(Modifier.weight(1f))
            Text(relative(entry.at.toEpochMilli(), now), style = IosType.caption, color = PhrenTheme.textMuted)
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconLabel(stateIcon, state.label, stateColor, IosType.caption2)
            Text("  ·  ${entry.source.label}", style = IosType.caption2, color = PhrenTheme.textDim)
        }
    }
}

@Composable
private fun StoreRow(c: StoreContext) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(c.descriptor.id, style = IosType.callout, color = PhrenTheme.text)
            if (!c.descriptor.canPush) TagChip("read-only", PhrenTheme.ChipRole.WARN)
        }
        Spacer(Modifier.height(3.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val last = c.status.lastSyncedAt
            Text(
                if (last != null) "synced " + last.atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)) else "not synced yet",
                style = IosType.caption, color = PhrenTheme.secondaryLabel,
            )
            if (c.status.pendingCount > 0) Text("${c.status.pendingCount} pending", style = IosType.caption, color = PhrenTheme.systemOrange)
            c.status.lastError?.let { Text(it, style = IosType.caption, color = PhrenTheme.systemRed, maxLines = 1) }
        }
    }
}

@Composable
private fun StoreHealthCard(c: StoreContext, claims: List<Pair<String, Int>>, queuedCaptures: Int, now: Long, onTapFailedOps: () -> Unit) {
    val status = c.status
    val last = status.lastSyncedAt
    val isStale = status.isLive && last != null && (now - last.toEpochMilli()) > 600_000
    val isWarning = status.failedCount > 0 || isStale || status.lastError != null
    val indicator = if (isWarning) PhrenTheme.warning else if (status.isLive) PhrenTheme.success else PhrenTheme.textDim
    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(indicator, CircleShape))
            Spacer(Modifier.width(6.dp))
            Text(c.descriptor.displayName, style = IosType.callout.copy(fontWeight = FontWeight.SemiBold), color = PhrenTheme.text, modifier = Modifier.weight(1f))
            Text(if (status.isLive) "live" else "paused", style = IosType.caption2.copy(fontFamily = FontFamily.Monospace), color = if (status.isLive) PhrenTheme.cyan else PhrenTheme.textDim)
        }
        Text(if (last == null) "not synced yet" else "synced ${relative(last.toEpochMilli(), now)}", style = IosType.caption, color = PhrenTheme.secondaryLabel)
        if (status.pendingCount > 0 || status.failedCount > 0) {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                if (status.pendingCount > 0) IconLabel(Icons.Filled.ArrowCircleUp, "${status.pendingCount} pending", PhrenTheme.amber)
                if (status.failedCount > 0) IconLabel(Icons.Filled.Warning, "${status.failedCount} failed", PhrenTheme.danger, modifier = Modifier.clickable(onClick = onTapFailedOps))
            }
        }
        if (queuedCaptures > 0) {
            IconLabel(
                Icons.Outlined.Mic,
                if (queuedCaptures == 1) "1 of those is a capture waiting to sync — see Recent captures" else "$queuedCaptures of those are captures waiting to sync — see Recent captures",
                PhrenTheme.amber,
            )
        }
        status.lastError?.let { Text(it, style = IosType.caption, color = PhrenTheme.danger, maxLines = 2) }
        if (!c.descriptor.canPush) IconLabel(Icons.Outlined.Lock, "Read-only — your token can't push to this repo", PhrenTheme.amber)
        claims.forEach { (name, count) ->
            val plural = if (count == 1) "project" else "projects"
            val verb = if (count == 1) "is" else "are"
            val pronoun = if (count == 1) "it" else "they"
            IconLabel(Icons.Outlined.Groups, "$count $plural in this store $verb claimed by '$name' — $pronoun may belong in that store.", PhrenTheme.amber)
        }
    }
}

@Composable
private fun StorageIssueRow(issue: StorageIssue) {
    Column {
        IconLabel(Icons.Outlined.WarningAmber, issue.userMessage, PhrenTheme.warning)
        issue.quarantineLocation?.let {
            Spacer(Modifier.height(4.dp))
            SelectionContainer { Text(it, style = IosType.caption2.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.secondaryLabel) }
        }
    }
}

@Composable
private fun DuplicateHint(names: List<String>) {
    val joined = when (names.size) {
        0 -> ""
        1 -> names[0]
        2 -> "${names[0]} and ${names[1]}"
        else -> names.dropLast(1).joinToString(", ") + ", and ${names.last()}"
    }
    IconLabel(Icons.Outlined.ContentCopy, "$joined look like the same project.", PhrenTheme.secondaryLabel)
}
