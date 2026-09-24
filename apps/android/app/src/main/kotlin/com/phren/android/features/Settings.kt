package com.phren.android.features

import android.content.Intent
import android.net.Uri
import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.phren.android.BuildConfig
import com.phren.android.CaptureLog
import com.phren.android.CaptureLogEntry
import com.phren.android.CaptureQueueState
import com.phren.android.CaptureSyncState
import com.phren.android.FailedOpEntry
import com.phren.android.PhrenCapture
import com.phren.android.PhrenCaptureTarget
import com.phren.android.QuickCaptureDefault
import com.phren.android.StoreContext
import com.phren.android.design.FormDivider
import com.phren.android.design.FormRow
import com.phren.android.design.FormSection
import com.phren.android.design.LocalDismiss
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenActionSheet
import com.phren.android.design.PhrenAppearance
import com.phren.android.design.PhrenAppearanceStyle
import com.phren.android.design.PhrenColorButton
import com.phren.android.design.PhrenColorSheet
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenCustomTheme
import com.phren.android.design.PhrenDialog
import com.phren.android.design.PhrenFieldSurface
import com.phren.android.design.PhrenForm
import com.phren.android.design.PhrenIconButton
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenPalette
import com.phren.android.design.PhrenSearchField
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenSingleSelect
import com.phren.android.design.PhrenSingleSelectSheet
import com.phren.android.design.PhrenSwipeRow
import com.phren.android.design.PhrenTextField
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.mono
import com.phren.android.design.PhrenType.semibold
import com.phren.android.design.SF
import com.phren.android.design.SwipeAction
import com.phren.android.design.ToolbarItem
import com.phren.android.design.hex
import com.phren.android.design.phrenCard
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.kit.AgentInstructions
import com.phren.kit.PendingOp
import com.phren.kit.ReleaseNotes
import com.phren.kit.StorageIssue
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun relativeTime(at: Instant, now: Long = System.currentTimeMillis()): String =
    DateUtils.getRelativeTimeSpanString(at.toEpochMilli(), now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString()

/** SettingsView.swift. */
@Composable
fun SettingsView() {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    var failedOps by remember { mutableStateOf<List<FailedOpEntry>>(emptyList()) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var showAddStore by remember { mutableStateOf(false) }
    var removingStore by remember { mutableStateOf<String?>(null) }
    var captureTargets by remember { mutableStateOf<List<PhrenCaptureTarget>>(emptyList()) }
    var captureDefaultId by remember { mutableStateOf<String?>(null) }
    var showingCaptureDefault by remember { mutableStateOf(false) }
    var captureLog by remember { mutableStateOf<List<CaptureLogEntry>>(emptyList()) }
    var captureQueue by remember { mutableStateOf(CaptureQueueState()) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val scroll = rememberScrollState()
    var needsAttentionY by remember { mutableStateOf(0) }
    val ready = model.phase == com.phren.android.AppModel.Phase.READY

    suspend fun reloadCaptureState() {
        captureTargets = PhrenCapture.targets(model)
        captureDefaultId = QuickCaptureDefault.load(model.prefs)?.let { "${it.storeId}|${it.project}" }
        captureLog = CaptureLog.entries(model.prefs)
        captureQueue = CaptureQueueState.sample(model)
    }
    LaunchedEffect(Unit) { failedOps = model.failedOps(); reloadCaptureState() }
    LaunchedEffect(model.syncStatus.pendingCount) { reloadCaptureState() }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = System.currentTimeMillis() } }

    fun push(key: String, content: @Composable () -> Unit) = navigator.push(key, content)
    fun projectExists(e: CaptureLogEntry) = model.storeContexts.firstOrNull { it.id == e.storeId }?.snapshot?.projects?.any { it.name == e.project } ?: false
    val unavailableDefault = captureDefaultId?.takeIf { id -> captureTargets.none { it.entityId == id } }?.let { id ->
        val (storeId, project) = id.split("|", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        id to "$project · ${model.storeName(storeId)}"
    }
    val captureOptions = buildList {
        add(PhrenOption<String?>(id = "always-ask", value = null, title = "Always ask"))
        unavailableDefault?.let { (id, label) -> add(PhrenOption<String?>(id = id, value = id, title = "$label — unavailable")) }
        captureTargets.forEach { add(PhrenOption<String?>(id = it.entityId, value = it.entityId, title = it.displayName)) }
    }
    fun setCaptureDefault(value: String?) {
        captureDefaultId = value
        val parts = value?.split("|", limit = 2)
        if (parts == null || parts.size != 2) QuickCaptureDefault.clear(model.prefs) else QuickCaptureDefault.save(model.prefs, parts[0], parts[1])
    }

    PhrenNavScreen("Settings") {
        ActionErrorBanner()
        Refreshable {
            PhrenForm(Modifier.phrenIdentifier("settings-form"), scrollState = scroll) {
                FormSection("Terminal") {
                    FormRow("Theme", icon = SF("paintpalette"), value = PhrenAppearance.name, identifier = "settings-theme") { push("theme") { AppearanceSettingsView() } }
                    FormDivider()
                    FormRow("Fonts & Size", icon = SF("textformat"), value = LiveBridge.terminalFontName(), identifier = "settings-fonts") { push("fonts") { LiveBridge.Pending("Fonts & Size") } }
                    FormDivider()
                    FormRow("Chat", icon = SF("bubble.left.and.text.bubble.right"), identifier = "settings-chat") { push("chat") { LiveBridge.Pending("Chat") } }
                    FormDivider()
                    FormRow("Advanced", icon = SF("slider.horizontal.3"), identifier = "settings-terminal-advanced") { push("advanced") { LiveBridge.Pending("Advanced") } }
                }
                FormSection("Input") {
                    FormRow("Toolbar", icon = SF("keyboard"), identifier = "settings-terminal-toolbar") { push("toolbar") { LiveBridge.Pending("Toolbar") } }
                    FormDivider()
                    FormRow("Shortcuts", icon = SF("rectangle.grid.2x2"), identifier = "settings-terminal-shortcuts") { push("shortcuts") { LiveBridge.Pending("Shortcuts") } }
                    FormDivider()
                    FormRow("Keyboard", icon = SF("keyboard.badge.ellipsis"), identifier = "settings-keyboard") { push("keyboard") { LiveBridge.Pending("Keyboard") } }
                    FormDivider()
                    FormRow("Gestures", icon = SF("hand.draw"), identifier = "settings-gestures") { push("gestures") { LiveBridge.Pending("Gestures") } }
                    FormDivider()
                    FormRow("Voice", icon = SF("mic"), identifier = "settings-speech") { push("speech") { LiveBridge.Pending("Voice") } }
                }
                if (ready) {
                    FormSection("Store health", footer = "Amber indicates a failed or delayed sync.") {
                        val rows = buildList<@Composable () -> Unit> {
                            model.storeContexts.forEach { c ->
                                add {
                                    StoreHealthCard(c, model.claimedElsewhere(c.id),
                                        captureLog.count { it.storeId == c.id && captureQueue.state(it) == CaptureSyncState.QUEUED }, now) {
                                        model.scope.launch { scroll.animateScrollTo(needsAttentionY) }
                                    }
                                }
                            }
                            model.duplicateProjectGroups.forEach { group -> add { DuplicateProjectHintRow(group) } }
                            model.storageIssues.forEach { issue -> add { StorageIssueRow(issue) } }
                        }
                        rows.forEachIndexed { i, row -> if (i > 0) FormDivider(16.dp); row() }
                    }
                    FormSection("Quick capture") {
                        Box(Modifier.padding(16.dp)) {
                            PhrenSingleSelect(captureOptions, captureDefaultId, placeholder = "Always ask", identifier = "settings-capture-default",
                                enabled = captureTargets.isNotEmpty() || unavailableDefault != null) { showingCaptureDefault = true }
                        }
                    }
                    Column(Modifier.padding(start = 17.dp, end = 17.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        unavailableDefault?.let { Text("'${it.second}' isn't in an attached, writable store any more — captures ask where to go until you pick a new default.", style = PhrenType.footnote, color = PhrenTheme.warning) }
                        Text("Choose where Assistant, shortcuts, and voice captures are saved. With Always ask, you choose a project each time.", style = PhrenType.footnote, color = PhrenTheme.textSecondary)
                    }
                    if (captureLog.isNotEmpty()) {
                        FormSection("Recent captures", footer = "The last ${CaptureLog.LIMIT} notes and tasks captured on this device, newest first. Tap one to open the project it went to. Clearing the list doesn't remove anything from your store.") {
                            captureLog.forEachIndexed { i, entry ->
                                if (i > 0) FormDivider(16.dp)
                                val exists = projectExists(entry)
                                Box(Modifier.fillMaxWidth().then(if (exists) Modifier.plainClickable {
                                    push("project:${entry.storeId}/${entry.project}") { ProjectDetailView(entry.storeId, entry.project) }
                                } else Modifier).padding(horizontal = 16.dp, vertical = 10.dp)) {
                                    CaptureLogRow(entry, if (model.hasMultipleStores) "${entry.project} · ${model.storeName(entry.storeId)}" else entry.project,
                                        captureQueue.state(entry), !exists, now)
                                }
                            }
                            FormDivider(16.dp)
                            FormRow("Clear list", titleColor = PhrenTheme.navigation, chevron = false) { CaptureLog.clear(model.prefs); captureLog = emptyList() }
                        }
                    }
                    FormSection("Memory") {
                        FormRow("Memory maintenance", icon = SF("wrench.and.screwdriver"), iconTint = PhrenTheme.text) { push("maintenance") { MemoryMaintenanceView() } }
                    }
                }
                FormSection("Agents") {
                    FormRow("Computers", icon = SF("desktopcomputer")) { push("computers") { LiveBridge.Pending("Computers") } }
                    FormDivider()
                    FormRow("Add computer", icon = SF("plus"), identifier = "settings-add-computer", chevron = false) { LiveBridge.connectComputer(navigator) }
                    FormDivider()
                    FormRow("Skills", icon = SF("wand.and.stars"), identifier = "settings-skills") { push("skills") { SkillsView() } }
                    FormDivider()
                    FormRow("Agent instructions", icon = SF("person.text.rectangle"), identifier = "settings-agent-instructions") { push("agents") { AgentsView() } }
                }
                FormSection("Integrations") {
                    FormRow("Phren Hook", icon = SF("point.3.connected.trianglepath.dotted"), identifier = "settings-hook") { push("hook") { LiveBridge.Pending("Phren Hook") } }
                    FormDivider()
                    FormRow("Notifications", icon = SF("bell"), identifier = "settings-notifications") { push("notifications") { LiveBridge.Pending("Notifications") } }
                    FormDivider()
                    FormRow("Show on Agents", icon = SF("square.grid.2x2"), identifier = "settings-show-on-agents") { push("show-on-agents") { LiveBridge.Pending("Show on Agents") } }
                    FormDivider()
                    FormRow("Assistant and shortcuts", icon = SF("wand.and.rays"), identifier = "settings-conductor") { push("conductor") { LiveBridge.Pending("Assistant and shortcuts") } }
                    FormDivider()
                    FormRow("Health", icon = SF("stethoscope"), identifier = "settings-health") { push("health") { LiveBridge.Pending("Health") } }
                    FormDivider()
                    FormRow("Account usage", icon = SF("chart.bar"), identifier = "settings-account-usage") { push("usage") { LiveBridge.Pending("Account usage") } }
                    FormDivider(16.dp)
                    Text("Chat, terminals, and project memory stay together in Phren. Connect the agents already running on your computers.",
                        style = PhrenType.caption, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
                }
                FormSection("GitHub memory") {
                    if (model.phase == com.phren.android.AppModel.Phase.SIGNED_OUT || model.phase == com.phren.android.AppModel.Phase.LOADING) {
                        FormRow("Connect memory", icon = SF("arrow.triangle.2.circlepath"), iconTint = PhrenTheme.navigation, titleColor = PhrenTheme.navigation, chevron = false,
                            identifier = "settings-connect-memory") { model.showingMemoryConnection = true }
                        FormDivider(16.dp)
                        Text("GitHub is used for memory sync. Agent connections use your computers' SSH keys.", style = PhrenType.caption, color = PhrenTheme.textMuted, modifier = Modifier.padding(16.dp))
                    } else {
                        model.user?.let { u ->
                            FormRow("GitHub", value = "@${u.login}", chevron = false)
                            u.name?.let { FormDivider(16.dp); FormRow("Name", value = it, chevron = false) }
                            FormDivider(16.dp)
                        }
                        FormRow("Sign out", titleColor = Color(0xFFFF453A), chevron = false, identifier = "settings-sign-out") { confirmSignOut = true }
                    }
                }
                if (ready) {
                    FormSection("Stores", footer = "Each store is a GitHub repository holding a phren store. Removing one only deletes this device's local copy.") {
                        model.storeContexts.forEachIndexed { i, c ->
                            if (i > 0) FormDivider(16.dp)
                            PhrenSwipeRow(trailing = listOf(SwipeAction("Remove", SF("trash"), Color(0xFFFF453A), destructive = true) { removingStore = c.id })) {
                                Box(Modifier.fillMaxWidth().background(PhrenTheme.surface).padding(horizontal = 16.dp, vertical = 10.dp)) { StoreRow(c) }
                            }
                        }
                        FormDivider(16.dp)
                        FormRow("Add store", icon = SF("plus"), iconTint = PhrenTheme.navigation, titleColor = PhrenTheme.navigation, chevron = false, identifier = "settings-add-store") { showAddStore = true }
                    }
                    FormSection("Sync") {
                        FormRow("Live updates", value = if (model.syncStatus.isLive) "On" else "Paused", chevron = false)
                        model.syncStatus.lastSyncedAt?.let { FormDivider(16.dp); FormRow("Last synced", value = DateTimeFormatter.ofPattern("h:mm:ss a").format(it.atZone(ZoneId.systemDefault())), chevron = false) }
                        FormDivider(16.dp)
                        FormRow("Pending changes", value = "${model.syncStatus.pendingCount}", chevron = false)
                        model.syncStatus.lastError?.let { Text(it, style = PhrenType.footnote, color = Color(0xFFFF453A), modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
                        FormDivider(16.dp)
                        FormRow("Sync now", titleColor = PhrenTheme.navigation, chevron = false, identifier = "settings-sync-now") {
                            model.scope.launch { model.pullToRefresh(); failedOps = model.failedOps() }
                        }
                    }
                }
                if (failedOps.isNotEmpty()) {
                    Box(Modifier.onGloballyPositioned { needsAttentionY = it.positionInParent().y.toInt() })
                    FormSection("Needs attention", footer = "These changes couldn't be applied — usually because the item changed on another machine. Retry or discard them.") {
                        failedOps.forEachIndexed { i, failed ->
                            if (i > 0) FormDivider(16.dp)
                            PhrenSwipeRow(trailing = listOf(SwipeAction("Discard", SF("trash"), Color(0xFFFF453A), destructive = true) {
                                model.scope.launch { model.discardFailedOp(failed.storeId, failed.op.id); failedOps = model.failedOps() }
                            })) {
                                Column(Modifier.fillMaxWidth().background(PhrenTheme.surface).padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    Text(failed.op.op.label, style = PhrenType.callout, color = PhrenTheme.text)
                                    (failed.op.op as? PendingOp.SaveAuthoredFile)?.let { op ->
                                        Text("Review saved draft", style = PhrenType.callout, color = PhrenTheme.navigation, modifier = Modifier.plainClickable {
                                            push("draft:${failed.op.id}") { SavedDraftView(op.content) }
                                        })
                                    }
                                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        if (model.hasMultipleStores) TagChip(failed.storeName, PhrenTheme.ChipRole.STORE)
                                        failed.op.lastError?.let { Text(it, style = PhrenType.caption, color = Color(0xFFFF453A)) }
                                    }
                                }
                            }
                        }
                        FormDivider(16.dp)
                        FormRow("Retry all", titleColor = PhrenTheme.navigation, chevron = false) { model.scope.launch { model.retryFailedOps(); failedOps = model.failedOps() } }
                    }
                }
                FormSection("About") {
                    FormRow("App", value = "phren for Android", chevron = false)
                    FormDivider(16.dp)
                    FormRow("Version", value = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", chevron = false)
                    FormDivider(16.dp)
                    FormRow("What's new", identifier = "settings-whats-new") { push("changelog") { ChangelogView() } }
                    FormDivider(16.dp)
                    FormRow("phren on GitHub", titleColor = PhrenTheme.navigation, chevron = false) {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/alaarab/phren")))
                    }
                    FormDivider(16.dp)
                    FormRow("Open-source notices") { push("notices") { NoticesView() } }
                }
            }
        }
    }

    if (showAddStore) PhrenSheet({ showAddStore = false }) {
        Column(Modifier.fillMaxSize()) {
            PhrenNavBar("Add store", inSheet = true, leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel") { showAddStore = false }))
            RepoPickerList(model, model.storeDescriptors.map { it.id }.toSet()) { repo ->
                showAddStore = false
                model.scope.launch { model.addStore(repo) }
            }
        }
    }
    removingStore?.let { id ->
        PhrenDialog("Remove $id from this device?", "The GitHub repository is not affected.", listOf(
            PhrenControlAction("remove", "Remove store", role = PhrenControlAction.Role.DESTRUCTIVE) { model.scope.launch { model.removeStore(id) } },
            PhrenControlAction("cancel", "Cancel", role = PhrenControlAction.Role.CANCEL) {},
        ), identifier = "settings-remove-store-dialog") { removingStore = null }
    }
    if (confirmSignOut) PhrenDialog("Sign out of GitHub?", "Local memory stores are removed from this device. Your agent connections and chat drafts stay.", listOf(
        PhrenControlAction("sign-out", "Sign out", role = PhrenControlAction.Role.DESTRUCTIVE) { model.scope.launch { model.signOut() } },
        PhrenControlAction("cancel", "Cancel", role = PhrenControlAction.Role.CANCEL) {},
    ), identifier = "settings-sign-out-dialog") { confirmSignOut = false }
    if (showingCaptureDefault) PhrenSingleSelectSheet("Default project", captureOptions, captureDefaultId, ::setCaptureDefault, rowPrefix = "settings-capture-default") { showingCaptureDefault = false }
}


@Composable
private fun SavedDraftView(content: String) {
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    PhrenNavScreen("Saved draft", onBack = navigator::pop) {
        PhrenForm {
            FormSection("Your draft") { SelectionContainer { Text(content, style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.padding(16.dp)) } }
            FormSection {
                FormRow("Share draft", icon = SF("square.and.arrow.up"), titleColor = PhrenTheme.navigation, chevron = false) {
                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, content), null))
                }
                FormDivider(16.dp)
                Text("Copy the text you want to keep, then open the latest instructions or skill to apply it.", style = PhrenType.caption, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
            }
        }
    }
}

@Composable
private fun CaptureLogRow(entry: CaptureLogEntry, destination: String, state: CaptureSyncState, missing: Boolean, now: Long) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(entry.snippet, style = PhrenType.callout, color = PhrenTheme.text, maxLines = 2)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(SF(if (entry.kind == CaptureLogEntry.Kind.NOTE) "note.text" else "checklist"), null, tint = PhrenTheme.textMuted, modifier = Modifier.size(12.dp))
            Text(destination, style = PhrenType.caption.copy(fontWeight = FontWeight.Medium), color = PhrenTheme.textMuted, maxLines = 1)
            if (missing) Text("(not in an attached store)", style = PhrenType.caption, color = PhrenTheme.warning)
            Spacer(Modifier.weight(1f))
            Text(relativeTime(entry.at, now), style = PhrenType.caption, color = PhrenTheme.textMuted)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val (icon, color) = when (state) {
                CaptureSyncState.SYNCED -> "checkmark.circle" to PhrenTheme.textDim
                CaptureSyncState.QUEUED -> "arrow.up.circle" to PhrenTheme.amber
                CaptureSyncState.FAILED -> "exclamationmark.triangle" to PhrenTheme.danger
            }
            Icon(SF(icon), null, tint = color, modifier = Modifier.size(11.dp))
            Text(state.label, style = PhrenType.caption2, color = color)
            Text("·", style = PhrenType.caption2, color = PhrenTheme.textDim)
            Text(entry.source.label, style = PhrenType.caption2, color = PhrenTheme.textDim)
        }
    }
}

@Composable
private fun StoreRow(context: StoreContext) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(context.descriptor.id, style = PhrenType.callout, color = PhrenTheme.text)
            if (!context.descriptor.canPush) TagChip("read-only", PhrenTheme.ChipRole.WARN)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val status = context.status
            Text(status.lastSyncedAt?.let { "synced " + DateTimeFormatter.ofPattern("h:mm a").format(it.atZone(ZoneId.systemDefault())) } ?: "not synced yet", style = PhrenType.caption, color = PhrenTheme.textSecondary)
            if (status.pendingCount > 0) Text("${status.pendingCount} pending", style = PhrenType.caption, color = Color(0xFFFF9F0A))
            status.lastError?.let { Text(it, style = PhrenType.caption, color = Color(0xFFFF453A), maxLines = 1) }
        }
    }
}

/** Per-store diagnostics that turn amber the moment a signal needs a look (StoreHealthCard). */
@Composable
private fun StoreHealthCard(context: StoreContext, claims: List<Pair<String, Int>>, queuedCaptures: Int, now: Long, onTapFailedOps: () -> Unit) {
    val status = context.status
    val stale = status.isLive && status.lastSyncedAt?.let { now - it.toEpochMilli() > 600_000 } == true
    val warning = status.failedCount > 0 || stale || status.lastError != null
    val indicator = if (warning) PhrenTheme.warning else if (status.isLive) PhrenTheme.success else PhrenTheme.textDim
    Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp).phrenIdentifier("store-health:${context.id}"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).background(indicator, CircleShape))
            Text(context.descriptor.displayName, style = PhrenType.callout.semibold(), color = PhrenTheme.text, modifier = Modifier.weight(1f))
            Text(if (status.isLive) "live" else "paused", style = PhrenType.caption2.mono(), color = if (status.isLive) PhrenTheme.cyan else PhrenTheme.textDim)
        }
        Text(status.lastSyncedAt?.let { "synced " + relativeTime(it, now) } ?: "not synced yet", style = PhrenType.caption, color = PhrenTheme.textSecondary)
        if (status.pendingCount > 0 || status.failedCount > 0) Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            if (status.pendingCount > 0) IconLabel(SF("arrow.up.circle"), "${status.pendingCount} pending", PhrenTheme.amber)
            if (status.failedCount > 0) Box(Modifier.plainClickable(onClick = onTapFailedOps)) { IconLabel(SF("exclamationmark.triangle.fill"), "${status.failedCount} failed", PhrenTheme.danger) }
        }
        if (queuedCaptures > 0) IconLabel(SF("mic"), if (queuedCaptures == 1) "1 of those is a capture waiting to sync — see Recent captures" else "$queuedCaptures of those are captures waiting to sync — see Recent captures", PhrenTheme.amber)
        status.lastError?.let { Text(it, style = PhrenType.caption, color = PhrenTheme.danger, maxLines = 2) }
        if (!context.descriptor.canPush) IconLabel(SF("lock"), "Read-only — your token can't push to this repo", PhrenTheme.amber)
        claims.forEach { (name, count) ->
            IconLabel(SF("person.2"), "$count ${if (count == 1) "project" else "projects"} in this store ${if (count == 1) "is" else "are"} claimed by '$name' — ${if (count == 1) "it" else "they"} may belong in that store.", PhrenTheme.amber)
        }
    }
}

@Composable
private fun IconLabel(icon: ImageVector, text: String, color: Color) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, tint = color, modifier = Modifier.padding(top = 2.dp).size(12.dp))
        Text(text, style = PhrenType.caption, color = color)
    }
}

@Composable
private fun StorageIssueRow(issue: StorageIssue) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        IconLabel(SF("exclamationmark.triangle"), issue.userMessage, PhrenTheme.warning)
        issue.quarantineLocation?.let { SelectionContainer { Text(it, style = PhrenType.caption2.mono(), color = PhrenTheme.textSecondary) } }
    }
}

@Composable
private fun DuplicateProjectHintRow(names: List<String>) {
    val joined = when (names.size) {
        0 -> ""
        1 -> names[0]
        2 -> "${names[0]} and ${names[1]}"
        else -> names.dropLast(1).joinToString(", ") + ", and ${names.last()}"
    }
    Box(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) { IconLabel(SF("doc.on.doc"), "$joined look like the same project.", PhrenTheme.textSecondary) }
}

// MARK: Agent setup (AgentsView.swift)

@Composable
fun AgentsView() {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var query by remember { mutableStateOf("") }
    val stores = model.storeDescriptors.filter { model.storeFilter == null || it.id == model.storeFilter }
    val projects = model.mergedProjects.filter {
        it.project.name != "global" && (query.isEmpty() || it.project.name.contains(query, true) || it.storeName.contains(query, true))
    }
    PhrenNavScreen("Agent setup", onBack = navigator::pop) {
        LiveStatusBar()
        PhrenSearchField(query, { query = it }, placeholder = "Search projects and stores", identifier = "agents-search",
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp).fillMaxWidth())
        Box(Modifier.weight(1f)) {
            Refreshable {
                PhrenForm {
                    FormSection {
                        Text("Shape how your agents work with shared instructions and reusable skills.", style = PhrenType.body, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
                        FormDivider(16.dp)
                        FormRow("Live sessions", icon = SF("waveform.path"), iconTint = PhrenTheme.text) { navigator.push("live") { LiveBridge.Pending("Live sessions") } }
                    }
                    val globalStores = stores.filter { query.isEmpty() || it.displayName.contains(query, true) || "global".contains(query, true) }
                    FormSection("Global instructions") {
                        globalStores.forEachIndexed { i, s ->
                            if (i > 0) FormDivider()
                            FormRow(s.displayName, icon = SF("globe"), iconTint = PhrenTheme.text, subtitle = "Shared across projects") {
                                navigator.push("context:${s.id}/global") { AgentContextView(s.id, "global") }
                            }
                        }
                    }
                    FormSection("Project instructions") {
                        projects.forEachIndexed { i, item ->
                            if (i > 0) FormDivider(16.dp)
                            Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).plainClickable {
                                navigator.push("context:${item.storeId}/${item.project.name}") { AgentContextView(item.storeId, item.project.name) }
                            }.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                    Text(item.project.name, style = PhrenType.headline, color = PhrenTheme.text)
                                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                        if (model.hasMultipleStores) TagChip(item.storeName, PhrenTheme.ChipRole.STORE)
                                        if (!model.canPush(item.storeId)) TagChip("Read-only", PhrenTheme.ChipRole.STATUS)
                                        Text(if (model.instructions(item.project.name, item.storeId) == null) "No project instructions" else "Instructions ready",
                                            style = PhrenType.caption, color = PhrenTheme.textSecondary)
                                    }
                                }
                                Icon(SF("chevron.right"), null, tint = PhrenTheme.textDim, modifier = Modifier.size(15.dp))
                            }
                        }
                        if (projects.isEmpty()) Text(if (query.isEmpty()) "Your projects will appear here." else "No matching projects.",
                            style = PhrenType.body, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
                    }
                }
            }
        }
    }
}

@Composable
fun AgentContextView(storeId: String, scope: String) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var draft by remember { mutableStateOf<DocumentDraft?>(null) }
    val content = model.instructions(scope, storeId)
    val path = model.instructionsPath(scope, storeId)
    val canPush = model.canPush(storeId)
    PhrenNavScreen(if (scope == "global") "Global instructions" else scope, onBack = navigator::pop,
        trailing = if (content != null && canPush) listOf(ToolbarItem(text = "Edit", label = "Edit", identifier = "instructions-edit") { draft = DocumentDraft(path, content) }) else emptyList()) {
        LiveStatusBar()
        PhrenForm {
            FormSection {
                FormRow("Store", value = model.storeName(storeId), chevron = false)
                if (!canPush) { FormDivider(16.dp); FormRow("Read-only store", icon = SF("lock"), chevron = false) }
                if (scope != "global") {
                    FormDivider()
                    FormRow("Global instructions", icon = SF("globe"), iconTint = PhrenTheme.text) { navigator.push("context:$storeId/global") { AgentContextView(storeId, "global") } }
                }
                FormDivider()
                FormRow(if (scope == "global") "Global skills" else "Project and global skills", icon = SF("wand.and.stars"), iconTint = PhrenTheme.text) {
                    navigator.push("skills:$storeId:$scope") { SkillsView(scope, storeId) }
                }
            }
            FormSection("Instructions") {
                if (content != null) Box(Modifier.padding(vertical = 12.dp)) { DocumentContentView(path, content, embedded = true, modifier = Modifier.padding(horizontal = 4.dp)) }
                else {
                    Text("Add the conventions, tools, and working rules your agents should follow.", style = PhrenType.body, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
                    if (canPush) {
                        FormDivider(16.dp)
                        FormRow("Add instructions", titleColor = PhrenTheme.navigation, chevron = false, identifier = "instructions-add") {
                            draft = DocumentDraft("$scope/${AgentInstructions.FILE_NAME}", null)
                        }
                    }
                }
            }
            Text("Changes sync to your store. Linked agents receive them when the computer syncs; generated instruction files refresh when phren links the project.",
                style = PhrenType.caption, color = PhrenTheme.textSecondary, modifier = Modifier.padding(horizontal = 17.dp, vertical = 8.dp))
        }
    }
    draft?.let { d -> PhrenSheet({ draft = null }) { DocumentEditorSheet("Agent instructions", storeId, d, AgentInstructions.template(scope)) } }
}

// MARK: Theme (AppearanceSettingsView.swift, CustomThemeEditor.swift)

@Composable
fun AppearanceSettingsView() {
    val navigator = LocalNavigator.current
    var editing by remember { mutableStateOf<PhrenCustomTheme?>(null) }
    var actionTheme by remember { mutableStateOf<PhrenCustomTheme?>(null) }
    PhrenNavScreen("Theme", onBack = navigator::pop) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp).padding(bottom = 90.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            PhrenAppearance.storageIssue?.let { Text(it, style = PhrenType.footnote, color = PhrenTheme.warning) }
            Text("Make it yours.", style = PhrenType.title2.semibold(), color = PhrenTheme.text)
            Row(Modifier.fillMaxWidth().phrenCard().plainClickable { editing = PhrenCustomTheme(name = "${PhrenAppearance.name} custom", palette = PhrenAppearance.palette) }
                .phrenIdentifier("theme-create").padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(SF("slider.horizontal.3"), null, tint = PhrenTheme.navigation, modifier = Modifier.size(17.dp))
                Text("Create custom theme", style = PhrenType.subheadline.copy(fontWeight = FontWeight.Medium), color = PhrenTheme.text)
            }
            if (PhrenAppearance.customThemes.isNotEmpty()) {
                Text("YOUR THEMES", style = PhrenType.caption, color = PhrenTheme.textMuted)
                PhrenAppearance.customThemes.toList().forEach { theme ->
                    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        ThemeChoice(theme.id, theme.name, "Custom palette", theme.palette) { actionTheme = theme }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(Modifier.heightIn(min = 36.dp).plainClickable { editing = theme }.phrenIdentifier("theme-edit-${theme.id}"), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Icon(SF("pencil"), null, tint = PhrenTheme.navigation, modifier = Modifier.size(13.dp))
                                Text("Edit", style = PhrenType.caption, color = PhrenTheme.navigation)
                            }
                            PhrenIconButton(SF("ellipsis"), "Theme actions", modifier = Modifier.phrenIdentifier("theme-actions-${theme.id}")) { actionTheme = theme }
                        }
                    }
                }
                Text("PRESETS", style = PhrenType.caption, color = PhrenTheme.textMuted)
            }
            PhrenAppearanceStyle.entries.forEach { style -> ThemeChoice(style.id, style.title, style.detail, style.palette) }
        }
    }
    editing?.let { theme -> PhrenSheet({ editing = null }) { CustomThemeEditor(theme) } }
    actionTheme?.let { theme ->
        PhrenActionSheet("Theme actions", listOf(
            PhrenControlAction("duplicate", "Duplicate", SF("plus.square.on.square")) { editing = PhrenCustomTheme(name = "${theme.name} copy", palette = theme.palette) },
            PhrenControlAction("delete", "Delete theme", role = PhrenControlAction.Role.DESTRUCTIVE) { PhrenAppearance.remove(theme) },
        ), identifier = "theme-actions-sheet") { actionTheme = null }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ThemeChoice(id: String, name: String, detail: String, palette: PhrenPalette, onLongPress: (() -> Unit)? = null) {
    Box(Modifier.combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = onLongPress, onClick = { PhrenAppearance.select(id) }).phrenIdentifier("theme-$id")) {
        ThemePreview(name, detail, palette, PhrenAppearance.selectedID == id)
    }
}

@Composable
fun ThemePreview(name: String, detail: String, palette: PhrenPalette, selected: Boolean = false) {
    val shape = RoundedCornerShape(22.dp)
    val text = hex(palette.text)
    val muted = hex(palette.muted)
    Column(Modifier.fillMaxWidth().background(hex(palette.background), shape)
        .border(if (selected) 1.5.dp else 0.5.dp, hex(if (selected) palette.action else palette.muted).copy(alpha = if (selected) 0.65f else 0.22f), shape)
        .padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(name, style = PhrenType.headline, color = text)
                Text(detail, style = PhrenType.caption, color = muted)
            }
            Icon(SF(if (selected) "checkmark.circle.fill" else "circle"), null, tint = hex(if (selected) palette.action else palette.dim), modifier = Modifier.size(22.dp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("A little memory. A clearer thought.", style = PhrenType.subheadline.mono(), color = text)
            Row(Modifier.fillMaxWidth().background(hex(palette.toolPanel ?: palette.chatPanel), CircleShape).padding(8.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(SF("terminal"), null, tint = text, modifier = Modifier.size(12.dp))
                Text("Shell", style = PhrenType.caption2.mono().semibold(), color = text)
                Text("git status", style = PhrenType.caption2.mono(), color = muted, modifier = Modifier.weight(1f))
                Icon(SF("chevron.down"), null, tint = text, modifier = Modifier.size(11.dp))
            }
            Text("View changes", style = PhrenType.caption, color = hex(palette.link ?: palette.action))
            Row(Modifier.fillMaxWidth().background(hex(palette.chatPanel), RoundedCornerShape(14.dp)).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Message your agent…", style = PhrenType.caption.mono(), color = muted, modifier = Modifier.weight(1f))
                Box(Modifier.size(26.dp).background(hex(palette.action), CircleShape), contentAlignment = Alignment.Center) {
                    Icon(SF("arrow.up"), null, tint = hex(palette.chatPanel), modifier = Modifier.size(13.dp))
                }
            }
        }
    }
}

private enum class ThemeColorField(val title: String) {
    BACKGROUND("Background"), TEXT("Text"), PANELS("Panels"), ACCENT("Accent"), LINKS("Links"),
    SESSION_PROJECT("Session project"), SESSION_TITLE("Session title"), SESSION_META("Session metadata"),
    STATE_WORKING("Working state"), STATE_WAITING("Waiting state"), STATE_DONE("Done state"),
    CARD_SURFACE("Phren card surface"), CARD_BORDER("Phren card border"), CARD_ACCENT("Phren card accent"), INLINE_CODE("Inline code");

    val id: String get() = title.lowercase()

    fun value(p: PhrenPalette): Long = when (this) {
        BACKGROUND -> p.background; TEXT -> p.text; PANELS -> p.chatPanel; ACCENT -> p.action; LINKS -> p.link ?: p.action
        SESSION_PROJECT -> p.sessionProject ?: p.link ?: p.action; SESSION_TITLE -> p.sessionTitle ?: p.secondary; SESSION_META -> p.sessionMeta ?: p.muted
        STATE_WORKING -> p.stateWorking ?: p.action; STATE_WAITING -> p.stateWaiting ?: 0xE0BC7F; STATE_DONE -> p.stateDone ?: 0x8AC8AC
        CARD_SURFACE -> p.resolvedPhrenCardSurface; CARD_BORDER -> p.resolvedPhrenCardBorder; CARD_ACCENT -> p.resolvedPhrenCardAccent
        INLINE_CODE -> p.chatInlineCode ?: PhrenTheme.chatPathHex(p)
    }

    fun apply(c: Long, p: PhrenPalette): PhrenPalette = when (this) {
        // The background is only the page behind everything; cards and bars follow Panels.
        BACKGROUND -> derivePanels(p.chatPanel, p.copy(background = c, chatCanvas = c, sunken = mix(c, 0, 0.2)))
        TEXT -> p.copy(text = c, navigation = c, secondary = mix(c, p.background, 0.1), muted = mix(c, p.background, 0.32), dim = mix(c, p.background, 0.38))
        PANELS -> derivePanels(c, p.copy(chatPanel = c, toolPanel = c))
        ACCENT -> p.copy(action = c, accent = c, hover = mix(c, 0xFFFFFF, 0.25), solid = mix(c, 0, 0.4))
        LINKS -> p.copy(link = c)
        SESSION_PROJECT -> p.copy(sessionProject = c); SESSION_TITLE -> p.copy(sessionTitle = c); SESSION_META -> p.copy(sessionMeta = c)
        STATE_WORKING -> p.copy(stateWorking = c); STATE_WAITING -> p.copy(stateWaiting = c); STATE_DONE -> p.copy(stateDone = c)
        CARD_SURFACE -> p.copy(phrenCardSurface = c); CARD_BORDER -> p.copy(phrenCardBorder = c); CARD_ACCENT -> p.copy(phrenCardAccent = c)
        INLINE_CODE -> p.copy(chatInlineCode = c)
    }

    companion object {
        /** Cards sit a step above the page toward Panels; raised bars and fields are Panels itself. */
        fun derivePanels(panels: Long, p: PhrenPalette) = p.copy(surface = mix(p.background, panels, 0.6), raised = panels)
        fun mix(a: Long, b: Long, f: Double): Long = PhrenPalette.blend(a, b, f)
    }
}

@Composable
private fun CustomThemeEditor(initial: PhrenCustomTheme) {
    val dismiss = LocalDismiss.current ?: {}
    var theme by remember { mutableStateOf(initial) }
    var invalid by remember { mutableStateOf(setOf<ThemeColorField>()) }
    var revision by remember { mutableStateOf(0) }
    var showingPresets by remember { mutableStateOf(false) }
    var editingColor by remember { mutableStateOf<ThemeColorField?>(null) }
    Column(Modifier.fillMaxSize()) {
        PhrenNavBar("Custom theme", inSheet = true,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", onClick = dismiss)),
            trailing = listOf(ToolbarItem(text = "Save", label = "Save", bold = true, identifier = "theme-save", enabled = theme.name.isNotBlank() && invalid.isEmpty()) {
                PhrenAppearance.save(theme.copy(name = theme.name.trim().take(60))); dismiss()
            }))
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            ThemePreview(theme.name.ifBlank { "Your theme" }, "Live preview", theme.palette)
            Column(Modifier.fillMaxWidth().phrenCard().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                PhrenTextField("Theme name", theme.name, { theme = theme.copy(name = it) }, identifier = "theme-name")
                Row(Modifier.heightIn(min = 44.dp).plainClickable { showingPresets = true }.phrenIdentifier("theme-preset"), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(SF("square.on.square"), null, tint = PhrenTheme.navigation, modifier = Modifier.size(16.dp))
                    Text("Start from a preset", style = PhrenType.subheadline, color = PhrenTheme.navigation)
                }
            }
            androidx.compose.runtime.key(revision) {
                Column(Modifier.fillMaxWidth().phrenCard()) {
                    ThemeColorField.entries.forEachIndexed { i, field ->
                        if (i > 0) Box(Modifier.fillMaxWidth().heightIn(max = 0.5.dp).background(PhrenTheme.border))
                        ThemeColorRow(field, field.value(theme.palette), { theme = theme.copy(palette = field.apply(it, theme.palette)) }, { editingColor = field }) { valid ->
                            invalid = if (valid) invalid - field else invalid + field
                        }
                    }
                }
            }
            Text("Choose a swatch or enter a hex color. Save applies your theme throughout Phren.", style = PhrenType.caption, color = PhrenTheme.textMuted)
        }
    }
    if (showingPresets) PhrenSingleSelectSheet("Start from a preset", PhrenAppearanceStyle.entries.map { PhrenOption(id = it.id, value = it, title = it.title) },
        PhrenAppearanceStyle.CHARCOAL, { preset -> theme = theme.copy(palette = preset.palette); invalid = emptySet(); revision++ }, rowPrefix = "theme-preset") { showingPresets = false }
    editingColor?.let { field ->
        PhrenColorSheet(field.title, hex(field.value(theme.palette)), { c ->
            fun ch(v: Float) = (v.coerceIn(0f, 1f) * 255).toLong()
            theme = theme.copy(palette = field.apply((ch(c.red) shl 16) or (ch(c.green) shl 8) or ch(c.blue), theme.palette))
            invalid = invalid - field; revision++
        }, "theme-color-editor") { editingColor = null }
    }
}

@Composable
private fun ThemeColorRow(field: ThemeColorField, value: Long, onChange: (Long) -> Unit, editColor: () -> Unit, validated: (Boolean) -> Unit) {
    var hexText by remember(value) { mutableStateOf("%06X".format(value)) }
    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        PhrenColorButton(field.title, hex(value), "theme-color-swatch-${field.id}", editColor)
        Spacer(Modifier.weight(1f))
        Text("#", style = PhrenType.monoCaption, color = PhrenTheme.textDim)
        Box(Modifier.width(80.dp)) {
            PhrenTextField("RRGGBB", hexText, { raw ->
                hexText = raw
                val digits = raw.removePrefix("#")
                val parsed = if (digits.length == 6) digits.toLongOrNull(16) else null
                validated(parsed != null)
                if (parsed != null) onChange(parsed)
            }, identifier = "theme-color-${field.id}", monospaced = true, surface = PhrenFieldSurface.BARE)
        }
    }
}

// MARK: About

private fun releaseNotes(context: android.content.Context): ReleaseNotes =
    ReleaseNotes(runCatching { context.assets.open("CHANGELOG.md").bufferedReader().readText() }.getOrDefault(""))

@Composable
fun ChangelogView() {
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    val notes = remember { releaseNotes(context) }
    PhrenNavScreen("What's new", onBack = navigator::pop) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp).padding(bottom = 90.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
            notes.releases.forEach { ReleaseSection(it, showsVersion = true) }
        }
    }
}

/** This version's notes, once after an update (WhatsNewSheet). */
@Composable
fun WhatsNewSheet() {
    val dismiss = LocalDismiss.current ?: {}
    val context = LocalContext.current
    val release = remember { releaseNotes(context).release(BuildConfig.VERSION_NAME) }
    Column(Modifier.fillMaxSize().phrenIdentifier("whats-new")) {
        PhrenNavBar("What's new in ${BuildConfig.VERSION_NAME}", inSheet = true,
            trailing = listOf(ToolbarItem(text = "Done", label = "Done", bold = true, identifier = "whats-new-done", onClick = dismiss)))
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (release != null) ReleaseSection(release, showsVersion = false) else Text("No notes for this version.", style = PhrenType.body, color = PhrenTheme.textMuted)
        }
    }
}

object ReleaseNotesStore {
    private const val SEEN_KEY = "whatsNew.seenVersion.v1"
    private val stamp get() = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
    fun shouldPresent(context: android.content.Context, prefs: com.phren.kit.KeyValueStore): Boolean {
        val current = releaseNotes(context).release(BuildConfig.VERSION_NAME) ?: return false
        return !current.isEmpty && prefs.getString(SEEN_KEY) != stamp
    }
    fun markSeen(prefs: com.phren.kit.KeyValueStore) = prefs.putString(SEEN_KEY, stamp)
}

@Composable
private fun ReleaseSection(release: ReleaseNotes.Release, showsVersion: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (showsVersion) Text(release.version, style = PhrenType.title3, color = if (release.version == BuildConfig.VERSION_NAME) PhrenTheme.accent else PhrenTheme.text)
        release.notes.forEach { Text(it, style = PhrenType.subheadline, color = PhrenTheme.textSecondary) }
        release.groups.forEach { group ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (group.title.isNotEmpty()) Text(group.title.uppercase(), style = PhrenType.sectionLabel, color = PhrenTheme.textMuted)
                group.items.forEach { item ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.padding(top = 7.dp).size(5.dp).background(PhrenTheme.accent, CircleShape))
                        Text(inlineMarkdown(item), style = PhrenType.subheadline, color = PhrenTheme.text)
                    }
                }
            }
        }
    }
}

@Composable
private fun NoticesView() {
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    val text = remember { runCatching { context.assets.open("ThirdPartyNotices.txt").bufferedReader().readText() }.getOrDefault("Notices unavailable.") }
    PhrenNavScreen("Open-source notices", onBack = navigator::pop) {
        SelectionContainer {
            Text(text, style = PhrenType.caption, color = PhrenTheme.text, modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).padding(bottom = 90.dp))
        }
    }
}
