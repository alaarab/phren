package com.phren.android.features

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.PhoneIphone
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.phren.android.design.FormDivider
import com.phren.android.design.FormSection
import com.phren.android.design.LocalDismiss
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenColorButton
import com.phren.android.design.PhrenColorSheet
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenDialog
import com.phren.android.design.PhrenEmptyState
import com.phren.android.design.PhrenFieldSurface
import com.phren.android.design.PhrenForm
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenTextField
import com.phren.android.design.PhrenTextSegment
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PhrenType.mono
import com.phren.android.design.PhrenType.semibold
import com.phren.android.design.SF
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.design.tabBarSafeArea
import com.phren.kit.LiveAgentSession
import com.phren.kit.LiveAgentWorkspaceGrouping
import com.phren.kit.LiveHost
import com.phren.kit.LiveSessionPreferences
import com.phren.kit.LiveWorkspaces
import com.phren.kit.live.PhrenConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Duration
import java.time.Instant
import java.util.UUID

private val COLOR_NAMES = listOf("Blue", "Teal", "Green", "Amber", "Orange", "Pink", "Lavender", "Slate")
private const val HOOK_GUIDE = "https://alaarab.github.io/phren/phren-hook.html"

/** Add a computer, or change a saved one's name, color and Herdr server (LiveHostEditor.swift). */
@Composable
fun LiveHostEditor(existing: LiveHost?) {
    val model = LocalModel.current
    val context = LocalContext.current
    val dismiss = LocalDismiss.current ?: {}
    val store = model.livePreferences
    val id = remember { existing?.id ?: UUID.randomUUID() }
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var address by remember { mutableStateOf(existing?.address ?: "") }
    var port by remember { mutableStateOf(existing?.port?.toString() ?: "22") }
    var username by remember { mutableStateOf(existing?.username ?: "") }
    var herdrSession by remember { mutableStateOf(existing?.herdrSession ?: "") }
    var selectedColor by remember { mutableStateOf<String?>(null) }
    var key by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var showingColor by remember { mutableStateOf(false) }
    val displayedColor = selectedColor ?: existing?.color ?: LiveHost.defaultColor(id)
    var colorHex by remember { mutableStateOf(displayedColor.drop(1)) }

    fun createKey() {
        try {
            key = model.deviceKeys.authorizedKey(id)
            // A public key only: lets debug runs enroll the emulator without reading its clipboard.
            if (com.phren.android.BuildConfig.DEBUG) android.util.Log.d("PhrenLive", "authorized_keys line: $key")
        } catch (e: Exception) { error = e.message }
    }
    fun chooseColor(color: String) {
        colorHex = color.drop(1)
        if (existing == null) { selectedColor = color; return }
        try { store.update { LiveSessionPreferences.settingColor(id, color, it) }; selectedColor = color } catch (e: Exception) { error = e.message }
    }
    fun save() {
        try {
            val trimmed = herdrSession.trim()
            val host = LiveHost(id, name, address, port.toIntOrNull() ?: 0, username, existing?.hookComputerID, existing?.fingerprint,
                trimmed.ifEmpty { null }, selectedColor ?: existing?.color)
            host.validate()
            store.update { LiveSessionPreferences.saving(host, it) }
            saved = true
            dismiss()
        } catch (e: Exception) { error = e.message }
    }
    fun forget() {
        try {
            val next = LiveSessionPreferences.removing(id, store.data)
            model.overview.purgeCache()
            model.deviceKeys.delete(id)
            store.write(next)
            dismiss()
        } catch (e: Exception) { error = e.message }
    }
    LaunchedEffect(Unit) { if (existing != null) createKey() }
    // An abandoned new computer takes its key with it.
    DisposableEffect(Unit) { onDispose { if (existing == null && !saved) model.deviceKeys.delete(id) } }
    LaunchedEffect(colorHex) {
        if (!Regex("^[0-9A-Fa-f]{6}$").matches(colorHex)) return@LaunchedEffect
        val normalized = colorHex.uppercase()
        if (colorHex != normalized) { colorHex = normalized; return@LaunchedEffect }
        if (displayedColor != "#$normalized") chooseColor("#$normalized")
    }

    Column(Modifier.fillMaxSize()) {
        PhrenNavBar(if (existing == null) "Add computer" else "Connection settings", inSheet = true,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", onClick = dismiss)),
            trailing = listOf(ToolbarItem(text = "Save", label = "Save", bold = true, enabled = key.isNotEmpty(), identifier = "live-host-save") { save() }))
        PhrenForm {
            FormSection {
                Text(name.ifEmpty { existing?.name ?: "Computer" }, style = PhrenType.title3.medium(), color = PhrenTheme.hostColor(displayedColor),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp))
            }
            FormSection("Color") {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    LiveHost.COLOR_PALETTE.forEachIndexed { index, hex ->
                        Box(Modifier.size(36.dp).plainClickable { chooseColor(hex) }.semantics { contentDescription = COLOR_NAMES[index] }
                            .phrenIdentifier("host-color:$hex"), contentAlignment = Alignment.Center) {
                            if (displayedColor == hex) Box(Modifier.size(34.dp).border(2.dp, PhrenTheme.text, CircleShape))
                            Box(Modifier.size(28.dp).background(PhrenTheme.hostColor(hex), CircleShape))
                        }
                    }
                }
                FormDivider(16.dp)
                Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    PhrenColorButton("Custom", PhrenTheme.hostColor(displayedColor), "host-color-custom") { showingColor = true }
                    Spacer(Modifier.weight(1f))
                    Text("#", style = PhrenType.caption.mono(), color = PhrenTheme.textDim)
                    PhrenTextField("RRGGBB", colorHex, { colorHex = it.take(6) }, identifier = "host-color-hex", monospaced = true,
                        surface = PhrenFieldSurface.BARE, keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                        modifier = Modifier.width(80.dp))
                }
            }
            FormSection("SSH computer", footer = if (existing != null) "To change the SSH destination or user, add another computer." else null) {
                val noAuto = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)
                Field { PhrenTextField("Name", name, { name = it }, identifier = "live-host-name", surface = PhrenFieldSurface.BARE) }
                FormDivider(16.dp)
                Field { PhrenTextField("Tailscale hostname or IP", address, { address = it }, identifier = "live-host-address", surface = PhrenFieldSurface.BARE,
                    enabled = existing == null, keyboardOptions = noAuto.copy(keyboardType = KeyboardType.Uri)) }
                FormDivider(16.dp)
                Field { PhrenTextField("SSH port", port, { port = it.filter(Char::isDigit).take(5) }, identifier = "live-host-port", surface = PhrenFieldSurface.BARE,
                    enabled = existing == null, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)) }
                FormDivider(16.dp)
                Field { PhrenTextField("SSH username", username, { username = it }, identifier = "live-host-username", surface = PhrenFieldSurface.BARE,
                    enabled = existing == null, keyboardOptions = noAuto) }
            }
            FormSection("Authorize this phone") {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Create a device key, then add the copied line to ~/.ssh/authorized_keys for this user on the computer. The line permits Phren Hook, Herdr terminals, and local web previews. Run phren bridge install on this computer first.",
                        style = PhrenType.callout, color = PhrenTheme.textSecondary)
                }
                FormDivider(16.dp)
                ActionRow("Install Phren Hook on this computer", "live-host-install-guide") {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(HOOK_GUIDE)))
                }
                FormDivider(16.dp)
                if (key.isEmpty()) ActionRow("Create device key", "live-host-create-key") { createKey() }
                else {
                    ActionRow(if (copied) "Copied SSH authorization line" else "Copy SSH authorization line", "live-host-copy-key", SF("doc.on.doc")) {
                        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("SSH authorization line", key))
                        copied = true
                    }
                    FormDivider(16.dp)
                    ActionRow("Share SSH authorization line", "live-host-share-key", SF("square.and.arrow.up")) {
                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, key), null))
                    }
                }
                existing?.fingerprint?.let {
                    FormDivider(16.dp)
                    Text("Trusted host: $it", style = PhrenType.caption.mono(), color = PhrenTheme.text, modifier = Modifier.padding(16.dp))
                }
                FormDivider(16.dp)
                Text("The private key stays on this phone. Phren connects to existing Herdr sessions for status and agent chat.",
                    style = PhrenType.caption, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
            }
            FormSection("Herdr server") {
                Field { PhrenTextField("default", herdrSession, { herdrSession = it }, identifier = "live-host-herdr-server", surface = PhrenFieldSurface.BARE,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)) }
                FormDivider(16.dp)
                Text("Leave empty for the default server, or enter a named Herdr server on this computer.",
                    style = PhrenType.caption, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
            }
            error?.let { FormSection { Text(it, style = PhrenType.body, color = PhrenTheme.warning, modifier = Modifier.padding(16.dp)) } }
            if (existing != null) FormSection(footer = "Also remove this phone's public key from authorized_keys on the computer to revoke its access there.") {
                ActionRow("Forget computer", "live-host-forget", color = PhrenTheme.danger) { removing = true }
            }
        }
    }
    if (showingColor) PhrenColorSheet("Computer color", PhrenTheme.hostColor(displayedColor), { color ->
        fun channel(v: Float) = (v.coerceIn(0f, 1f) * 255).toInt()
        chooseColor("#%02X%02X%02X".format(channel(color.red), channel(color.green), channel(color.blue)))
    }, "host-color-editor") { showingColor = false }
    if (removing) PhrenDialog("Forget this computer and delete its SSH key from this phone?",
        "Phren stops connecting to it and removes the saved key. Remove the public key on the computer to revoke access there.",
        listOf(PhrenControlAction("forget", "Forget computer", role = PhrenControlAction.Role.DESTRUCTIVE) { removing = false; forget() },
            PhrenControlAction("cancel", "Cancel", role = PhrenControlAction.Role.CANCEL) { removing = false }),
        identifier = "live-host-forget-dialog") { removing = false }
}

@Composable private fun Field(content: @Composable () -> Unit) = Box(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) { content() }

@Composable
private fun ActionRow(title: String, identifier: String, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, color: Color = PhrenTheme.text, action: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).plainClickable(onClick = action).padding(horizontal = 16.dp).phrenIdentifier(identifier),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (icon != null) Icon(icon, null, tint = PhrenTheme.navigation, modifier = Modifier.size(18.dp))
        Text(title, style = PhrenType.body, color = if (icon != null) PhrenTheme.navigation else color)
    }
}

/** One computer's page (LiveHostView.swift): its connection, its sessions by workspace or activity, and its tools. */
@Composable
fun LiveHostView(hostID: UUID) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val preferences = model.livePreferences.preferences
    val host = preferences?.hosts?.firstOrNull { it.id == hostID }
    val computer = model.overview.computers.firstOrNull { it.host.id == hostID }
    val monitor = computer?.monitor
    var editing by remember { mutableStateOf(false) }
    var mode by remember { mutableStateOf("workspaces") }
    var localError by remember { mutableStateOf<String?>(null) }
    val sessions = if (host != null) monitor?.snapshot?.sessions(host) ?: emptyList() else emptyList()
    // Reached from outside Agents, the overview may not be running yet.
    LaunchedEffect(preferences?.hosts) { preferences?.hosts?.let { if (host != null) model.overview.ensureRunning(it) } }

    fun trust(fingerprint: String) {
        val current = host ?: return
        if (current.fingerprint != null) return
        try {
            val verified = current.copy(fingerprint = fingerprint)
            model.livePreferences.update { LiveSessionPreferences.saving(verified, it) }
            monitor?.fingerprint = null
            model.scope.launch {
                try {
                    val key = withContext(Dispatchers.IO) { model.deviceKeys.load(verified.id) }
                    val identity = PhrenConnection.computerIdentity(verified, key) ?: return@launch
                    val saved = model.livePreferences.preferences?.hosts?.firstOrNull { it.id == verified.id }
                    if (saved != null && saved.hasSameConnection(verified))
                        model.livePreferences.update { LiveSessionPreferences.associating(verified.id, identity.id, it) }
                } catch (e: Exception) { localError = e.message }
            }
            monitor?.refreshNow()
        } catch (e: Exception) { localError = e.message }
    }

    val trailing = if (host == null) emptyList() else listOf(
        ToolbarItem(SF("globe"), label = "Web servers", tint = PhrenTheme.navigation, identifier = "host-web-servers") { navigator.push("host-web:$hostID") { LiveBridge.Pending("Web servers") } },
        ToolbarItem(Icons.Outlined.PhoneIphone, label = "Simulators", tint = PhrenTheme.navigation, identifier = "host-simulators") { navigator.push("host-sims:$hostID") { LiveBridge.Pending("Simulators") } },
        ToolbarItem(Icons.Outlined.Folder, label = "Files", tint = PhrenTheme.navigation, identifier = "host-files") { navigator.push("host-files:$hostID") { LiveBridge.Pending("Files") } },
        ToolbarItem(SF("terminal"), label = "Herdr workspaces & terminal", tint = PhrenTheme.navigation, identifier = "host-terminal") { navigator.push("host-herdr:$hostID") { LiveBridge.Pending("Terminal") } },
        ToolbarItem(SF("gearshape"), label = "Connection settings", tint = PhrenTheme.navigation, identifier = "host-settings") { editing = true },
    )
    PhrenNavScreen(host?.name ?: "Computer removed", onBack = navigator::pop, trailing = trailing) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item(key = "connection") { ConnectionCard(host, monitor, sessions, localError, ::trust) }
            if (monitor?.snapshot != null && host != null) {
                item(key = "mode") {
                    PhrenTextSegment(listOf(PhrenOption("workspaces", "workspaces", "Workspaces"), PhrenOption("activity", "activity", "Activity")),
                        mode, { mode = it }, identifier = "host-session-view", modifier = Modifier.padding(vertical = 4.dp))
                }
                val pinned = sessions.filter { preferences?.isPinned(it.id) == true }
                val unpinned = sessions.filter { preferences?.isPinned(it.id) != true }
                if (pinned.isNotEmpty()) {
                    item(key = "pinned") { SectionHeading("Pinned", pinned.size) }
                    items(pinned, key = { "pinned:${it.accessibilityKey}" }) { HostSessionCard(it, monitor, preferences) }
                }
                if (sessions.isEmpty()) item(key = "empty") {
                    PhrenEmptyState("No sessions running", "Open a workspace on this computer to see it here.", Modifier.fillMaxWidth())
                } else if (mode == "workspaces") {
                    for (section in LiveAgentWorkspaceGrouping.sections(unpinned, preferences, model.sessionProjects)) {
                        item(key = "section:${section.id}") { SectionHeading(section.title, section.sessions.size) }
                        items(section.sessions, key = { "s:${section.id}:${it.accessibilityKey}" }) { HostSessionCard(it, monitor, preferences) }
                    }
                } else {
                    for (activity in LiveWorkspaces.Tab.Activity.entries) {
                        val entries = unpinned.filter { it.tab.activity == activity }
                        if (entries.isEmpty()) continue
                        item(key = "activity:${activity.rawValue}") { SectionHeading(activity.rawValue, entries.size) }
                        items(entries, key = { "a:${it.accessibilityKey}" }) { HostSessionCard(it, monitor, preferences) }
                    }
                }
                // Health lives in the page, not the toolbar.
                item(key = "health") {
                    Row(Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(min = 52.dp).background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.questionOption))
                        .plainClickable { navigator.push("health:$hostID") { LiveBridge.Pending("Health") } }.padding(horizontal = 16.dp).phrenIdentifier("host-health"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(SF("stethoscope"), null, tint = PhrenTheme.text, modifier = Modifier.size(18.dp))
                        Text("Health", style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
                        Icon(SF("chevron.right"), null, tint = PhrenTheme.textDim, modifier = Modifier.size(14.dp))
                    }
                }
            }
            item(key = "bottom") { Spacer(Modifier.tabBarSafeArea().height(16.dp)) }
        }
    }
    if (editing && host != null) com.phren.android.design.PhrenSheet({ editing = false }) { LiveHostEditor(host) }
}

@Composable
private fun HostSessionCard(session: LiveAgentSession, monitor: com.phren.android.live.LiveHostMonitor, preferences: LiveSessionPreferences?) {
    SessionCard(LocalModel.current.overview, session, null, preferences, showHost = false, monitorOverride = monitor)
}

@Composable
private fun SectionHeading(title: String, count: Int) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = PhrenType.subheadline.semibold(), color = PhrenTheme.textMuted, modifier = Modifier.weight(1f))
        Text("$count", style = PhrenType.caption, color = PhrenTheme.textMuted)
    }
}

@Composable
private fun ConnectionCard(host: LiveHost?, monitor: com.phren.android.live.LiveHostMonitor?, sessions: List<LiveAgentSession>, localError: String?, trust: (String) -> Unit) {
    val navigator = LocalNavigator.current
    val now = rememberNow()
    Column(Modifier.padding(horizontal = 4.dp).phrenIdentifier("live-connection-status"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val fresh = monitor?.isFresh(Instant.ofEpochMilli(now)) == true
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(5.dp).background(if (fresh) PhrenTheme.cyan else PhrenTheme.textDim, CircleShape))
                    Text(when {
                        fresh -> "Live"; monitor?.isConnecting != false -> "Connecting…"; monitor.slowToAnswer -> "Slow to answer"; else -> "Disconnected"
                    }, style = PhrenType.caption, color = PhrenTheme.textMuted)
                    monitor?.lastUpdated?.let { updated ->
                        Text("· updated ${relativeAgo(updated, Instant.ofEpochMilli(now))} ago", style = PhrenType.caption, color = PhrenTheme.textMuted, maxLines = 1)
                    }
                }
                if (monitor?.snapshot != null) {
                    Text(if (fresh) "${sessions.size} tabs · ${sessions.count { it.tab.activity == LiveWorkspaces.Tab.Activity.WORKING }} working · ${sessions.count { it.tab.activity == LiveWorkspaces.Tab.Activity.WAITING }} waiting"
                        else if (monitor.isConnecting) "Refreshing…" else "Showing previous status", style = PhrenType.caption, color = PhrenTheme.textMuted)
                }
            }
            Box(Modifier.size(44.dp).plainClickable(enabled = monitor?.refreshing != true) { monitor?.refreshNow() }.semantics { contentDescription = "Refresh now" },
                contentAlignment = Alignment.Center) {
                Icon(SF("arrow.clockwise"), null, tint = PhrenTheme.textMuted, modifier = Modifier.size(20.dp))
            }
        }
        monitor?.message?.let { Text(it, style = PhrenType.footnote, color = PhrenTheme.warning) }
        localError?.let { Text(it, style = PhrenType.footnote, color = PhrenTheme.warning) }
        // Reachable over SSH even when the Hook is not answering: the terminal attaches Herdr directly.
        if (host != null && monitor?.message != null && monitor.fingerprint == null) {
            Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.medium))
                .plainClickable { navigator.push("terminal:${host.id}") { LiveBridge.Pending("Terminal") } }.phrenIdentifier("host-open-terminal"),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                Icon(SF("terminal"), null, tint = PhrenTheme.cyan, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Open terminal", style = PhrenType.subheadline.semibold(), color = PhrenTheme.cyan)
            }
        }
        val fingerprint = monitor?.fingerprint
        if (fingerprint != null && host?.fingerprint == null) {
            Text(fingerprint, style = PhrenType.caption.mono(), color = PhrenTheme.text, modifier = Modifier.phrenIdentifier("host-fingerprint"))
            Text("Compare this fingerprint with the computer's SSH host key before trusting it. On the computer, run ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub (or the matching ECDSA host key).",
                style = PhrenType.caption, color = PhrenTheme.textMuted)
            Text("Trust verified fingerprint", style = PhrenType.body, color = PhrenTheme.navigation,
                modifier = Modifier.heightIn(min = 44.dp).plainClickable { trust(fingerprint) }.padding(vertical = 10.dp).phrenIdentifier("host-trust-fingerprint"))
        }
    }
}

/** "3 sec", "2 min", "1 hr": SwiftUI's relative text style. */
private fun relativeAgo(since: Instant, now: Instant): String {
    val seconds = maxOf(0L, Duration.between(since, now).seconds)
    return when {
        seconds < 60 -> "$seconds sec"
        seconds < 3_600 -> "${seconds / 60} min"
        seconds < 86_400 -> "${seconds / 3_600} hr"
        else -> "${seconds / 86_400} days"
    }
}
