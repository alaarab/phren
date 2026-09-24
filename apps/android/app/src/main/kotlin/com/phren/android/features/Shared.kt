package com.phren.android.features

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.android.design.FormSection
import com.phren.android.design.LocalDismiss
import com.phren.android.design.PhrenForm
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenSingleSelect
import com.phren.android.design.PhrenSingleSelectSheet
import com.phren.android.design.PhrenTextField
import com.phren.android.design.PhrenFieldSurface
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.SF
import com.phren.android.design.ToolbarItem
import com.phren.android.design.plainClickable
import com.phren.kit.Finding
import com.phren.kit.FindingType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The app model, provided once at the root (`@Environment(AppModel.self)`). */
val LocalModel = staticCompositionLocalOf<AppModel> { error("No AppModel") }

/** The shared one-second clock: only elapsed-time labels read it (AppClock). */
@Composable
fun rememberNow(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1_000); now = System.currentTimeMillis() } }
    return now
}

/**
 * A project's name color: the theme's own (`default`) or a `#RRGGBB` from the
 * computer palette, per store+project, on this phone only (ProjectNameColor).
 */
sealed interface ProjectNameColor {
    data object Default : ProjectNameColor
    data class Hex(val value: String) : ProjectNameColor

    val title: String get() = when (this) {
        Default -> "Default"
        is Hex -> PALETTE.indexOf(value).takeIf { it >= 0 }?.let { PALETTE_NAMES[it] } ?: value
    }
    val hexValue: String? get() = (this as? Hex)?.value
    val color: Color get() = when (this) {
        Default -> PhrenTheme.sessionProject
        is Hex -> PhrenTheme.hostColor(value)
    }

    companion object {
        val PALETTE = listOf("#6E9BFF", "#35C9C0", "#4CD37A", "#F2B441", "#FF8A5B", "#FF6FA5", "#A78BFA", "#9AA5B8")
        val PALETTE_NAMES = listOf("Blue", "Teal", "Green", "Amber", "Orange", "Pink", "Lavender", "Slate")
        const val STORAGE_PREFIX = "project.colour."
        private val legacy = mapOf("accent" to "#A78BFA", "purple" to "#A78BFA", "cyan" to "#35C9C0", "success" to "#4CD37A", "warning" to "#F2B441")
        /** Bumped on every change so names recolor at once. */
        var revision by mutableStateOf(0)

        fun key(storeId: String, project: String) = "$STORAGE_PREFIX$storeId/$project"

        fun normalized(hex: String): String? {
            val t = hex.trim().uppercase()
            val body = t.removePrefix("#")
            return if (body.length == 6 && body.all { it.isDigit() || it in 'A'..'F' }) "#$body" else null
        }

        fun stored(model: AppModel, storeId: String, project: String): ProjectNameColor {
            revision
            val raw = model.prefs.getString(key(storeId, project)) ?: return Default
            normalized(raw)?.let { return Hex(it) }
            legacy[raw]?.let { return Hex(it) }
            return Default
        }

        fun set(model: AppModel, value: ProjectNameColor, storeId: String, project: String) {
            when (value) {
                Default -> model.prefs.remove(key(storeId, project))
                is Hex -> model.prefs.putString(key(storeId, project), value.value)
            }
            revision += 1
        }
    }
}

@Composable
fun projectColor(storeId: String, project: String): Color = ProjectNameColor.stored(LocalModel.current, storeId, project).color

/** "live · updated 3s ago" (LiveStatusBar). */
@Composable
fun LiveStatusBar(compact: Boolean = false) {
    val model = LocalModel.current
    val status = model.syncStatus
    val now = rememberNow()
    val dot = when {
        status.lastError != null -> PhrenTheme.red
        status.isLive -> PhrenTheme.cyan
        else -> PhrenTheme.textDim
    }
    val text = run {
        status.lastError?.let { return@run "sync error — $it" }
        val last = status.lastSyncedAt ?: return@run if (status.isLive) "live · syncing…" else "not synced yet"
        val seconds = maxOf(0L, (now - last.toEpochMilli()) / 1000)
        val ago = if (seconds < 60) "${seconds}s ago" else "${seconds / 60}m ago"
        if (status.isLive) "live · updated $ago" else "updated $ago"
    }
    Row(
        Modifier.then(if (compact) Modifier else Modifier.fillMaxWidth().background(PhrenTheme.bg).padding(horizontal = 24.dp, vertical = 8.dp)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(5.dp).background(dot, CircleShape))
        Text(text, style = if (compact) PhrenType.caption2 else PhrenType.caption, color = PhrenTheme.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = if (compact) Modifier else Modifier.weight(1f))
        if (!compact && status.pendingCount > 0) {
            Icon(SF("arrow.up.circle"), null, tint = PhrenTheme.amber, modifier = Modifier.size(13.dp))
            Text("${status.pendingCount}", style = PhrenType.caption, color = PhrenTheme.amber)
        }
    }
}

@Composable
fun ActionErrorBanner() {
    val model = LocalModel.current
    val error = model.lastActionError ?: return
    Row(
        Modifier.padding(horizontal = 16.dp).fillMaxWidth().background(PhrenTheme.red.copy(alpha = 0.15f), RoundedCornerShape(10.dp)).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(SF("exclamationmark.triangle.fill"), null, tint = PhrenTheme.text, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(error, style = PhrenType.footnote, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        Icon(SF("xmark.circle.fill"), "Dismiss", tint = PhrenTheme.navigation, modifier = Modifier.size(20.dp).plainClickable { model.lastActionError = null })
    }
}

/** A tinted capsule label (TagChip). */
@Composable
fun TagChip(text: String, role: PhrenTheme.ChipRole? = null, color: Color? = null) {
    val c = color ?: PhrenTheme.chipColor(role ?: PhrenTheme.ChipRole.TYPE)
    Text(text, style = PhrenType.caption2.medium(), color = c, maxLines = 1,
        modifier = Modifier.background(c.copy(alpha = 0.10f), CircleShape).padding(horizontal = 8.dp, vertical = 3.dp))
}

/** Counts as metadata: a small glyph and the number (PhrenMetadataLabelStyle). */
@Composable
fun MetadataLabel(icon: ImageVector, text: String, color: Color = PhrenTheme.textMuted) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(icon, null, tint = color, modifier = Modifier.size(13.dp))
        Text(text, style = PhrenType.caption, color = color)
    }
}

/** The finding text without its leading `[tag] `, which the chip carries. */
val Finding.displayText: String
    get() {
        val tag = typeTag ?: return text
        val prefix = "[$tag] "
        return if (text.lowercase().startsWith(prefix.lowercase())) text.drop(prefix.length) else text
    }

/** One finding's chips, actor and date (FindingRow metadata line). */
@Composable
fun FindingMeta(finding: Finding, archived: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (archived) TagChip("archived", PhrenTheme.ChipRole.STATUS)
        finding.typeTag?.let { TagChip(it, PhrenTheme.ChipRole.TYPE) }
        if (!archived && finding.status != com.phren.kit.FindingLifecycleStatus.ACTIVE) TagChip(finding.status.rawValue, PhrenTheme.ChipRole.STATUS)
        finding.scope?.let { TagChip(it, PhrenTheme.ChipRole.SCOPE) }
        if (!archived) finding.actor?.let { Text("@$it", style = PhrenType.caption2, color = PhrenTheme.textSecondary) }
        Spacer(Modifier.weight(1f))
        Text(finding.date, style = PhrenType.caption2, color = PhrenTheme.textDim)
    }
}

/**
 * Enter or edit a piece of text, with an optional finding type (add
 * finding, edit finding, promote note). Shown inside a PhrenSheet.
 */
@Composable
fun TextEntrySheet(
    title: String,
    initialText: String = "",
    initialType: FindingType? = null,
    showsTypePicker: Boolean = false,
    confirmLabel: String = "Save",
    onConfirm: suspend (String, FindingType?) -> Unit,
) {
    val model = LocalModel.current
    val dismiss = LocalDismiss.current ?: {}
    var text by remember { mutableStateOf(initialText) }
    var type by remember { mutableStateOf(initialType) }
    Column {
        PhrenNavBar(
            title,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", onClick = dismiss)),
            trailing = listOf(ToolbarItem(text = confirmLabel, label = confirmLabel, bold = true, enabled = text.isNotBlank(), identifier = "text-entry-confirm") {
                val value = text; val t = type
                model.scope.launchSafely { onConfirm(value, t) }
                dismiss()
            }),
            inSheet = true,
        )
        PhrenForm {
            FormSection {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    PhrenTextField("Text", text, { text = it }, identifier = "text-entry", multiline = true, minLines = 3, surface = PhrenFieldSurface.BARE)
                }
            }
            if (showsTypePicker) {
                val options = listOf(PhrenOption<FindingType?>(id = "none", value = null, title = "none")) +
                    FindingType.entries.map { PhrenOption<FindingType?>(id = it.rawValue, value = it, title = it.rawValue) }
                var picking by remember { mutableStateOf(false) }
                FormSection {
                    Box(Modifier.padding(16.dp)) { PhrenSingleSelect(options, type, placeholder = "Type", identifier = "finding-type") { picking = true } }
                }
                if (picking) PhrenSingleSelectSheet("Type", options, type, { type = it }, rowPrefix = "finding-type") { picking = false }
            }
        }
    }
}

fun kotlinx.coroutines.CoroutineScope.launchSafely(block: suspend () -> Unit) = launch {
    try { block() } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) { android.util.Log.e("Phren", "action failed", e) }
}
