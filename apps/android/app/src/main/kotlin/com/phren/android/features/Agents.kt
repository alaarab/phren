package com.phren.android.features

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.PhoneIphone
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.phren.android.R
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenMenuRow
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.SF
import com.phren.android.design.ToolbarItem
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PhrenType.mono
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.design.PhrenType.semibold
import com.phren.android.design.tabBarSafeArea
import com.phren.android.live.SessionOverviewMonitor
import com.phren.kit.LiveAgentSession
import com.phren.kit.LiveHost
import com.phren.kit.LiveSessionPreferences
import com.phren.kit.LiveWorkspaces
import com.phren.kit.SessionRelativeTime
import kotlinx.coroutines.delay
import java.time.Instant

/** The Agents tab (LiveSessionsView.swift): every computer's sessions, grouped by what they need. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveSessionsView() {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val overview = model.overview
    val preferences = model.livePreferences.preferences
    val hosts = preferences?.hosts ?: emptyList()
    val screen = overview.screen
    var refreshing by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    if (adding) com.phren.android.design.PhrenSheet({ adding = false }) { LiveHostEditor(existing = null) }

    // The store metadata the monitor needs; the monitor ignores an unchanged value.
    val projects = model.sessionProjects
    LaunchedEffect(preferences, projects, model.phase) {
        overview.configure(SessionOverviewMonitor.Configuration(preferences, projects,
            metadataReady = model.phase != com.phren.android.AppModel.Phase.LOADING && model.phase != com.phren.android.AppModel.Phase.INITIAL_SYNC,
            memoryConnected = model.phase == com.phren.android.AppModel.Phase.READY))
    }
    // Poll while the app is in the foreground; the job belongs to the monitor, so a pushed chat never freezes it.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, hosts) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> { overview.ensureRunning(hosts); overview.returnToForeground() }
                Lifecycle.Event.ON_STOP -> overview.stopRunning()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) overview.ensureRunning(hosts)
        onDispose { lifecycle.removeObserver(observer) }
    }
    // The Hook's own computer identity binds to the saved connection.
    LaunchedEffect(overview.computers.map { it.monitor.snapshot?.computer?.id }) {
        for (computer in overview.computers) {
            val id = computer.monitor.snapshot?.computer?.id ?: continue
            if (preferences?.hosts?.firstOrNull { it.id == computer.host.id }?.hookComputerID == id) continue
            runCatching { model.livePreferences.update { LiveSessionPreferences.associating(computer.host.id, id, it) } }
        }
    }

    val trailing = listOf(
        ToolbarItem(androidx.compose.material.icons.Icons.Outlined.Schedule, label = "Schedules", tint = PhrenTheme.navigation, identifier = "sessions-schedules") {
            navigator.push("schedules") { LiveBridge.Pending("Schedules") }
        },
        ToolbarItem(SF("circle"), label = "Account usage", tint = PhrenTheme.textDim, identifier = "account-usage") {
            navigator.push("usage") { LiveBridge.Pending("Usage") }
        },
        ToolbarItem(SF("globe"), label = "Web servers", tint = PhrenTheme.navigation, identifier = "all-web-servers") {
            navigator.push("web-servers") { LiveBridge.Pending("Web servers") }
        },
        ToolbarItem(androidx.compose.material.icons.Icons.Outlined.PhoneIphone, label = "Simulators", tint = PhrenTheme.navigation, identifier = "all-simulators") {
            navigator.push("simulators") { LiveBridge.Pending("Simulators") }
        },
        ToolbarItem(androidx.compose.material.icons.Icons.Outlined.Folder, label = "Files", tint = PhrenTheme.navigation, identifier = "all-files") {
            navigator.push("files") { FilesView() }
        },
    )

    PhrenNavScreen("Live sessions", trailing = trailing) {
        if (hosts.isNotEmpty() && !overview.ready) {
            Box(Modifier.fillMaxSize().phrenIdentifier("agents-loading"), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = PhrenTheme.cyan)
            }
            return@PhrenNavScreen
        }
        PullToRefreshBox(refreshing, onRefresh = {
            refreshing = true
            overview.stopRunning(); overview.ensureRunning(hosts)
        }, modifier = Modifier.fillMaxSize()) {
            LaunchedEffect(refreshing) { if (refreshing) { delay(600); refreshing = false } }
            LazyColumn(
                Modifier.fillMaxSize().phrenIdentifier("sessions-scroll"),
                contentPadding = PaddingValues(start = PhrenTheme.Space.large, end = PhrenTheme.Space.large, top = PhrenTheme.Space.large),
                verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.medium),
            ) {
                val store = model.storeDescriptors.firstOrNull { it.id == model.storeFilter } ?: model.storeDescriptors.firstOrNull()
                if (store != null) item(key = "conductor") {
                    ConductorSlot(overview, preferences, projects, store.id, store.id == model.storeDescriptors.firstOrNull()?.id,
                        showStoreName = model.storeDescriptors.size > 1, screen = screen)
                }
                if (screen.computers.isEmpty()) item(key = "intro") {
                    Text("Connect a computer to see its sessions here.", style = PhrenType.caption, color = PhrenTheme.textMuted,
                        modifier = Modifier.phrenIdentifier("agents-introduction"))
                }
                if (screen.groups.isEmpty() && screen.computers.isNotEmpty()) item(key = "empty") {
                    if (screen.computers.any { it.connecting }) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CircularProgressIndicator(Modifier.size(16.dp), color = PhrenTheme.textMuted, strokeWidth = 2.dp)
                            Text("Finding sessions…", style = PhrenType.subheadline, color = PhrenTheme.text)
                        }
                    } else {
                        Text(if (screen.connectedCount == 0 && screen.computers.any { it.message != null }) "No computers connected"
                            else "No sessions running on the connected computers",
                            style = PhrenType.subheadline, color = PhrenTheme.textMuted, modifier = Modifier.phrenIdentifier("sessions-empty"))
                    }
                }
                for (group in screen.groups) {
                    val remaining = group.sessions.filter { !it.tab.isConductor }
                    if (remaining.isEmpty()) continue
                    item(key = "group:${group.id}") { GroupLabel("${group.title} · ${remaining.size}") }
                    items(remaining, key = { "session:${it.accessibilityKey}" }) { session ->
                        SessionCard(overview, session, screen, preferences, groupFresh = group.fresh || group.id == "previous")
                    }
                    if (group.id == "previous") item(key = "previous-note") {
                        Text("phren can't reach these computers right now. Their terminal still opens from their row under Computers.",
                            style = PhrenType.footnote, color = PhrenTheme.textMuted)
                    }
                }
                item(key = "computers") { GroupLabel("Computers", "sessions-computers") }
                if (screen.preferencesReadable) {
                    items(screen.computers, key = { "computer:${it.host.id}" }) { computer -> ComputerRow(computer) }
                    item(key = "add-computer") {
                        Box(Modifier.fillMaxWidth().background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.questionOption))
                            .plainClickable { adding = true }
                            .padding(horizontal = 12.dp).phrenIdentifier("sessions-add-computer")) {
                            PhrenMenuRow("Add computer", SF("plus"))
                        }
                    }
                } else item(key = "unreadable") {
                    Text("Saved connections couldn't be read. They have been preserved; update phren before editing them.",
                        style = PhrenType.subheadline, color = PhrenTheme.warning)
                }
                item(key = "bottom") { Spacer(Modifier.tabBarSafeArea().height(PhrenTheme.Space.large)) }
            }
        }
    }
}

/** A small upper-case section label (plainListSectionLabel). */
@Composable
private fun GroupLabel(text: String, identifier: String? = null) {
    Text(text.uppercase(), style = PhrenType.caption.semibold().copy(letterSpacing = 0.6.sp), color = PhrenTheme.textMuted,
        modifier = Modifier.padding(start = 14.dp, top = 8.dp).then(if (identifier != null) Modifier.phrenIdentifier(identifier) else Modifier))
}

/** The conductor's pinned place: the store's own conductor, or the row that starts one. */
@Composable
private fun ConductorSlot(overview: SessionOverviewMonitor, preferences: LiveSessionPreferences?, projects: List<com.phren.kit.SessionProject>,
                          storeID: String, isDefaultStore: Boolean, showStoreName: Boolean, screen: SessionOverviewMonitor.Screen) {
    val navigator = LocalNavigator.current
    val conductors = overview.computers.flatMap { c -> (c.monitor.snapshot?.sessions(c.host) ?: emptyList()).filter { it.tab.isConductor } }.distinctBy { it.id }
    var unmapped: LiveAgentSession? = null
    var own: LiveAgentSession? = null
    for (session in conductors) {
        val match = preferences?.projectMatch(session.host.id, session.tab.cwd, projects)
        if (match?.project?.storeID == storeID) { own = session; break }
        if (match == null && unmapped == null) unmapped = session
    }
    if (own == null && isDefaultStore) own = unmapped
    Column(Modifier.phrenIdentifier("sessions-conductor-slot"), verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.medium)) {
        if (own != null) SessionCard(overview, own, screen, preferences)
        else Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.medium))
                .plainClickable { navigator.push("start-conductor") { LiveBridge.Pending("Start a conductor") } }
                .padding(horizontal = PhrenTheme.Space.medium, vertical = PhrenTheme.Space.xs).phrenIdentifier("sessions-start-conductor"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small),
        ) {
            Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) { Icon(SF("wand.and.rays"), null, tint = PhrenTheme.accent, modifier = Modifier.size(22.dp)) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Start a conductor", style = PhrenType.subheadline.semibold(), color = PhrenTheme.text)
                if (showStoreName) Text(storeID, style = PhrenType.caption, color = PhrenTheme.textMuted)
            }
            Icon(SF("chevron.right"), null, tint = PhrenTheme.textDim, modifier = Modifier.size(14.dp))
        }
        for (other in conductors.filter { it.id != own?.id }) SessionCard(overview, other, screen, preferences)
    }
}

val LiveAgentSession.accessibilityKey: String get() = "${host.id.toString().uppercase()}:${host.muxID}:$workspaceID:${tab.id}"

val LiveWorkspaces.Tab.Activity.color: Color
    get() = when (this) {
        LiveWorkspaces.Tab.Activity.WORKING -> PhrenTheme.stateWorking
        LiveWorkspaces.Tab.Activity.WAITING -> PhrenTheme.stateWaiting
        LiveWorkspaces.Tab.Activity.ERROR -> PhrenTheme.danger
        LiveWorkspaces.Tab.Activity.DONE -> PhrenTheme.stateDone
        LiveWorkspaces.Tab.Activity.IDLE, LiveWorkspaces.Tab.Activity.UNKNOWN -> PhrenTheme.textMuted
    }
val LiveWorkspaces.Tab.Activity.icon: String
    get() = when (this) {
        LiveWorkspaces.Tab.Activity.WORKING -> "bolt.fill"
        LiveWorkspaces.Tab.Activity.WAITING -> "pause.fill"
        LiveWorkspaces.Tab.Activity.ERROR -> "exclamationmark"
        LiveWorkspaces.Tab.Activity.DONE -> "checkmark"
        LiveWorkspaces.Tab.Activity.IDLE -> "moon"
        LiveWorkspaces.Tab.Activity.UNKNOWN -> "questionmark"
    }

fun hostColor(host: LiveHost): Color = PhrenTheme.hostColor(host.color ?: LiveHost.defaultColor(host.id))

/** One session: tap to chat, the ring for details, and a pin (LiveSessionCard). */
@Composable
fun SessionCard(overview: SessionOverviewMonitor, session: LiveAgentSession, screen: SessionOverviewMonitor.Screen?, preferences: LiveSessionPreferences?,
                showHost: Boolean = true, monitorOverride: com.phren.android.live.LiveHostMonitor? = null, groupFresh: Boolean = true) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val monitor = monitorOverride ?: overview.monitor(session.host)
    // A cold launch's restored list stays greyed until its computer answers.
    val fresh = monitor?.isLive() == true && groupFresh
    val stale = monitor?.isStale() == true
    val match = preferences?.projectMatch(session.host.id, session.tab.cwd, model.sessionProjects)
    val project = (if (showHost) screen?.projects?.get(session.id) else null) ?: match?.project?.name
    val prefix = if (showHost) "overview" else "live"
    val pinned = preferences?.isPinned(session.id) == true
    Row(Modifier.fillMaxWidth().background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.medium)), verticalAlignment = Alignment.CenterVertically) {
        // A computer that isn't live leaves its cards disabled and dimmed.
        Box(Modifier.weight(1f).alpha(if (fresh) 1f else 0.5f).plainClickable(enabled = fresh) {
            navigator.push("chat:${session.accessibilityKey}") { LiveBridge.Pending("Chat") }
        }.phrenIdentifier(if (showHost) "overview-chat:${session.accessibilityKey}" else "live-chat:${session.workspaceID}:${session.tab.id}")) {
            SessionCardContent(session, fresh, stale, project, computer = if (showHost) session.host else null, identifierPrefix = prefix,
                projectStoreId = if (showHost) null else match?.project?.storeID,
                onDetails = { navigator.push("details:${session.accessibilityKey}") { LiveBridge.Pending("Details") } })
        }
        // The conductor has its own place at the top; pinning cannot move it.
        if (!session.tab.isConductor) {
            Box(Modifier.size(44.dp).plainClickable {
                runCatching { model.livePreferences.update { LiveSessionPreferences.setPinned(!pinned, session.id, it) } }
            }.semantics { contentDescription = if (pinned) "Unpin session" else "Pin session" }.phrenIdentifier("$prefix-pin:${session.accessibilityKey}"),
                contentAlignment = Alignment.Center) {
                Icon(SF(if (pinned) "pin.fill" else "pin"), null, tint = if (pinned) PhrenTheme.cyan else PhrenTheme.textDim, modifier = Modifier.size(17.dp))
            }
        }
    }
}

/**
 * Which project (bold, with its branch), which conversation (the tab's title),
 * and what's happening, beside the harness's mark in a ring carrying the state
 * (SessionCardContent.swift).
 */
@Composable
fun SessionCardContent(session: LiveAgentSession, fresh: Boolean, stale: Boolean, project: String?, computer: LiveHost?,
                       identifierPrefix: String, projectStoreId: String? = null, onDetails: (() -> Unit)? = null) {
    val tab = session.tab
    val stateColor = if (fresh) tab.activity.color else PhrenTheme.textMuted
    val headline = session.projectDisplayName(project)
    val headlineColor = if (project != null && projectStoreId != null) projectColor(projectStoreId, project) else PhrenTheme.sessionProject
    val state = listOfNotNull("Permission needed".takeIf { tab.approvalPending == true }, "Stale".takeIf { stale }).joinToString(" · ")
    Box {
        Row(Modifier.heightIn(min = 56.dp).padding(start = PhrenTheme.Space.medium, end = PhrenTheme.Space.xs, top = PhrenTheme.Space.xs, bottom = PhrenTheme.Space.xs),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
            Box(Modifier.size(44.dp).plainClickable(enabled = onDetails != null) { onDetails?.invoke() }
                .semantics { contentDescription = "${if (tab.isConductor) "Conductor" else tab.agent?.replaceFirstChar { it.uppercase() } ?: "Agent"}, ${tab.status}" }
                .phrenIdentifier("$identifierPrefix-detail:${session.accessibilityKey}"), contentAlignment = Alignment.Center) {
                SessionActivityIndicator(tab, fresh)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (tab.isConductor) {
                        Text("Conductor", style = PhrenType.subheadline.semibold(), color = PhrenTheme.accent, maxLines = 1)
                        StateDot(stateColor)
                        Text(if (!fresh) (if (stale) "Stale" else "Connecting") else when (tab.activity) {
                            LiveWorkspaces.Tab.Activity.WORKING -> "Working"; LiveWorkspaces.Tab.Activity.WAITING -> "Needs you"
                            LiveWorkspaces.Tab.Activity.ERROR -> "Error"; else -> "Idle"
                        }, style = PhrenType.caption2.medium(), color = if (tab.activity == LiveWorkspaces.Tab.Activity.WAITING || stale) stateColor else PhrenTheme.sessionMeta)
                    } else {
                        if (session.usesFolderFallback(project)) Icon(SF("folder"), "Folder", tint = PhrenTheme.textMuted, modifier = Modifier.size(12.dp))
                        Text(headline, style = PhrenType.subheadline.semibold(), color = headlineColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        tab.branch?.takeIf { it.isNotEmpty() }?.let { branch ->
                            Row(Modifier.weight(1f, fill = false), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                                Icon(SF("arrow.triangle.branch"), null, tint = PhrenTheme.chatNeutral, modifier = Modifier.size(10.dp))
                                Text(branch, style = PhrenType.caption2.mono(), color = PhrenTheme.chatNeutral, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                            }
                        }
                    }
                    if (computer != null) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            Icon(SF("desktopcomputer"), null, tint = PhrenTheme.sessionMeta, modifier = Modifier.size(10.dp))
                            Text(computer.name, style = PhrenType.caption2.mono().medium(), color = hostColor(computer), maxLines = 1,
                                modifier = Modifier.phrenIdentifier("session-computer-name"))
                        }
                    }
                    tab.lastChangedAt?.let { RelativeTimeLabel(it, Modifier.phrenIdentifier("$identifierPrefix-changed:${session.accessibilityKey}")) }
                }
                if (tab.isConductor || tab.displayTitle != headline) {
                    Text(tab.displayTitle, style = PhrenType.footnote, color = PhrenTheme.sessionTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (!tab.isConductor && state.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        StateDot(stateColor)
                        Text(state, style = PhrenType.caption2.medium(), color = if (tab.approvalPending == true || stale) stateColor else PhrenTheme.sessionMeta)
                    }
                }
            }
        }
        // A bar on the edge for the states that want a glance: working, and needs you.
        if (fresh && (tab.activity == LiveWorkspaces.Tab.Activity.WORKING || tab.activity == LiveWorkspaces.Tab.Activity.WAITING)) {
            Box(Modifier.align(Alignment.CenterStart).width(3.dp).height(26.dp).background(stateColor, CircleShape)
                .phrenIdentifier("$identifierPrefix-running:${session.accessibilityKey}"))
        }
    }
}

@Composable private fun StateDot(color: Color) = Box(Modifier.size(6.dp).background(color, CircleShape))

/** "· 2m ago", ticking once a second (SessionRelativeTimeLabel). */
@Composable
fun RelativeTimeLabel(changedAt: Instant, modifier: Modifier = Modifier, prefix: String = "· ") {
    val now = rememberNow()
    Text(prefix + SessionRelativeTime.text(changedAt, Instant.ofEpochMilli(now)), style = PhrenType.caption2, color = PhrenTheme.sessionMeta, maxLines = 1, modifier = modifier)
}

/** The harness's mark inside a ring that carries the state: context used as the ring's fill, a spinning arc while it works. */
@Composable
private fun SessionActivityIndicator(tab: LiveWorkspaces.Tab, fresh: Boolean) {
    val color = if (fresh) tab.activity.color else PhrenTheme.textMuted
    val percent = tab.contextUsedPercent
    Box(Modifier.size(42.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(36.dp)) {
            drawCircle(color.copy(alpha = 0.22f), style = Stroke(2.dp.toPx()))
            if (percent != null) drawArc(color.copy(alpha = if (fresh) 0.85f else 0.4f), -90f, (percent / 100 * 360).toFloat(), false,
                style = Stroke(2.dp.toPx(), cap = StrokeCap.Round))
        }
        if (fresh && tab.activity == LiveWorkspaces.Tab.Activity.WORKING) {
            val rotation by rememberInfiniteTransition(label = "arc").animateFloat(0f, 360f,
                infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "arc")
            Canvas(Modifier.size(42.dp).rotate(rotation)) {
                val inset = 0.75.dp.toPx()
                drawArc(color, -90f, 0.22f * 360, false, topLeft = Offset(inset, inset), size = Size(size.width - 2 * inset, size.height - 2 * inset),
                    style = Stroke(1.5.dp.toPx(), cap = StrokeCap.Round))
            }
        }
        Box(Modifier.alpha(if (fresh) 1f else 0.55f)) {
            if (tab.isConductor) Icon(SF("wand.and.rays"), null, tint = PhrenTheme.accent, modifier = Modifier.size(18.dp))
            else AgentProviderGlyph(tab.agent, 20)
        }
        // What it is doing, on the ring's foot.
        val quiet = tab.activity == LiveWorkspaces.Tab.Activity.IDLE || tab.activity == LiveWorkspaces.Tab.Activity.UNKNOWN
        Box(Modifier.align(Alignment.BottomEnd).offset(2.dp, 2.dp).size(15.dp)
            .background(if (quiet) PhrenTheme.surface else color, CircleShape).border(1.5.dp, PhrenTheme.bg, CircleShape),
            contentAlignment = Alignment.Center) {
            Icon(SF(tab.activity.icon), null, tint = if (quiet) PhrenTheme.textMuted else Color.Black.copy(alpha = 0.85f), modifier = Modifier.size(8.dp))
        }
    }
}

/** Each harness's own mark (AgentProviderGlyph.swift). */
@Composable
fun AgentProviderGlyph(source: String?, size: Int = 22) {
    when (source) {
        "claude" -> Icon(painterResource(R.drawable.mark_claude), null, tint = Color(0.85f, 0.47f, 0.34f), modifier = Modifier.size((size * 0.92f).dp))
        "codex" -> Icon(painterResource(R.drawable.mark_codex), null, tint = PhrenTheme.text, modifier = Modifier.size((size * 0.9f).dp))
        "copilot" -> Icon(painterResource(R.drawable.mark_copilot), null, tint = PhrenTheme.text, modifier = Modifier.size((size * 0.92f).dp))
        "opencode" -> Icon(painterResource(R.drawable.mark_opencode), null, tint = PhrenTheme.text, modifier = Modifier.size((size * 0.9f).dp))
        // The mascot's ink fills about two thirds of its square; scaling lands its height on the vector marks'.
        "phren" -> Image(painterResource(R.drawable.phren_mascot), null, modifier = Modifier.size(size.dp).scale(1.32f))
        else -> Icon(SF("person.crop.circle"), null, tint = PhrenTheme.textDim, modifier = Modifier.size((size * 0.82f).dp))
    }
}

/** A computer's row under Computers: its page, and its trouble when there is some. */
@Composable
private fun ComputerRow(computer: SessionOverviewMonitor.ComputerRow) {
    val navigator = LocalNavigator.current
    Row(Modifier.fillMaxWidth().background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.questionOption)).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).plainClickable { navigator.push("host:${computer.host.id}") { LiveHostView(computer.host.id) } }
            .phrenIdentifier("live-host:${computer.host.id.toString().uppercase()}")) {
            PhrenMenuRow(computer.host.name, SF("desktopcomputer"), subtitle = if (computer.connecting) "Connecting…" else computer.host.address,
                titleColor = hostColor(computer.host))
        }
        if (computer.message != null || computer.slow || computer.busy) {
            // Busy: the Hook answers but its overview lags. Its sessions stay usable.
            val label = if (computer.needsVerification) "Verify" else if (computer.message != null) "Offline" else if (computer.busy) "Busy" else "Slow"
            Row(Modifier.padding(start = 6.dp).phrenIdentifier("computer-status:${computer.host.id}"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Box(Modifier.size(7.dp).background(if (computer.message != null) PhrenTheme.warning else PhrenTheme.textMuted, CircleShape))
                Text(label, style = PhrenType.caption, color = PhrenTheme.warning)
            }
        }
        // The terminal needs only SSH, not the Hook: when the Hook is down this is still the way onto the machine.
        if (computer.message != null && !computer.needsVerification) {
            Box(Modifier.size(44.dp).plainClickable { navigator.push("terminal:${computer.host.id}") { LiveBridge.Pending("Terminal") } }
                .semantics { contentDescription = "Open ${computer.host.name}'s terminal" }.phrenIdentifier("overview-terminal:${computer.host.id}"),
                contentAlignment = Alignment.Center) {
                Icon(SF("terminal"), null, tint = PhrenTheme.cyan, modifier = Modifier.size(18.dp))
            }
        }
    }
}
