package com.phren.android.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowCircleUp
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.kit.Finding
import com.phren.kit.FindingType
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant

/**
 * "live · updated 3s ago" freshness indicator shown on every list screen —
 * the visible promise that what you see is what's on GitHub right now.
 */
@Composable
fun LiveStatusBar(model: AppModel) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val status = model.syncStatus
    val indicator = when {
        status.lastError != null -> PhrenTheme.red
        status.isLive -> PhrenTheme.cyan
        else -> PhrenTheme.textDim
    }
    val text = run {
        status.lastError?.let { return@run "sync error — $it" }
        val last = status.lastSyncedAt ?: return@run if (status.isLive) "live · syncing…" else "not synced yet"
        val seconds = maxOf(0L, Duration.between(last, Instant.ofEpochMilli(now)).seconds)
        val ago = if (seconds < 60) "${seconds}s ago" else "${seconds / 60}m ago"
        if (status.isLive) "live · updated $ago" else "updated $ago"
    }
    Row(
        Modifier.fillMaxWidth().background(PhrenTheme.bg).padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(8.dp)
                .then(if (status.isLive) Modifier.shadow(3.dp, CircleShape, ambientColor = indicator, spotColor = indicator) else Modifier)
                .background(indicator, CircleShape),
        )
        Spacer(Modifier.width(6.dp))
        Text(text, style = IosType.caption.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (status.pendingCount > 0) {
            Icon(Icons.Filled.ArrowCircleUp, null, tint = PhrenTheme.amber, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(3.dp))
            Text("${status.pendingCount}", style = IosType.caption.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.amber)
        }
    }
}

@Composable
fun ActionErrorBanner(model: AppModel) {
    val error = model.lastActionError ?: return
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp)
            .background(Color.Red.copy(alpha = 0.15f), RoundedCornerShape(10.dp)).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Warning, null, tint = PhrenTheme.text, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(error, style = IosType.footnote, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        Icon(Icons.Filled.Cancel, "Dismiss", tint = PhrenTheme.accent, modifier = Modifier.size(22.dp).clickable { model.lastActionError = null })
    }
}

/** Monospace, squared-off, bordered chip (the site's .mini-tag). */
@Composable
fun TagChip(text: String, color: Color) {
    Text(
        text,
        style = IosType.caption2.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold),
        color = color,
        maxLines = 1,
        modifier = Modifier
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(4.dp))
            .border(1.dp, color.copy(alpha = 0.45f), RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
fun TagChip(text: String, role: PhrenTheme.ChipRole) = TagChip(text, PhrenTheme.chipColor(role))

/** The text without the leading [tag] — the chip carries it. */
fun Finding.displayText(): String {
    val tag = typeTag ?: return text
    val prefix = "[$tag] "
    return if (text.lowercase().startsWith(prefix.lowercase())) text.drop(prefix.length) else text
}

/** Tag/status/scope chips, actor and date under a finding. */
@Composable
fun FindingMeta(finding: Finding) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        finding.typeTag?.let { TagChip(it, PhrenTheme.ChipRole.TYPE) }
        if (finding.status != com.phren.kit.FindingLifecycleStatus.ACTIVE) TagChip(finding.status.rawValue, PhrenTheme.ChipRole.STATUS)
        finding.scope?.let { TagChip(it, PhrenTheme.ChipRole.SCOPE) }
        finding.actor?.let { Text("@$it", style = IosType.caption2, color = PhrenTheme.secondaryLabel, maxLines = 1) }
        Spacer(Modifier.weight(1f))
        Text(finding.date, style = IosType.caption2, color = PhrenTheme.tertiaryLabel)
    }
}

@Composable
fun FindingRow(finding: Finding) {
    Column(Modifier.padding(vertical = 2.dp)) {
        Text(finding.displayText(), style = IosType.callout, color = PhrenTheme.text)
        Spacer(Modifier.height(4.dp))
        FindingMeta(finding)
    }
}

// Form controls

/** A multi-line `TextField(axis: .vertical)` inside a Form row. */
@Composable
fun FormTextField(value: String, onValueChange: (String) -> Unit, placeholder: String, minLines: Int = 1, autofocus: Boolean = false) {
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    if (autofocus) LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Box(Modifier.fillMaxWidth().heightIn(min = (22 * minLines).dp)) {
        if (value.isEmpty()) Text(placeholder, style = IosType.body, color = PhrenTheme.tertiaryLabel)
        BasicTextField(
            value, onValueChange,
            textStyle = IosType.body.copy(color = PhrenTheme.text),
            cursorBrush = SolidColor(PhrenTheme.accent),
            modifier = Modifier.fillMaxWidth().focusRequester(focus),
        )
    }
}

/** UISwitch-styled `Toggle`. */
@Composable
fun FormToggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = IosType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        Switch(
            checked, onChange,
            colors = SwitchDefaults.colors(
                checkedTrackColor = PhrenTheme.systemGreen, checkedThumbColor = Color.White, checkedBorderColor = Color.Transparent,
                uncheckedTrackColor = Color(0xFF39393D), uncheckedThumbColor = Color.White, uncheckedBorderColor = Color.Transparent,
            ),
            thumbContent = null,
        )
    }
}

/** A menu-style `Picker`: label on the left, value + ⌃⌄ on the right. */
@Composable
fun <T> FormPicker(label: String, options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().clickable { open = true }, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = IosType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        Box {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(options.firstOrNull { it.first == selected }?.second ?: "", style = IosType.body, color = PhrenTheme.secondaryLabel, maxLines = 1)
                Icon(Icons.Filled.UnfoldMore, null, tint = PhrenTheme.secondaryLabel, modifier = Modifier.size(16.dp))
            }
            DropdownMenu(open, { open = false }, containerColor = IosColors.menuBg, shape = RoundedCornerShape(13.dp)) {
                options.forEach { (value, text) ->
                    DropdownMenuItem(
                        text = { Text(text, style = IosType.body, color = PhrenTheme.text) },
                        leadingIcon = { if (value == selected) Icon(Icons.Filled.Check, null, tint = PhrenTheme.text, modifier = Modifier.size(18.dp)) else Spacer(Modifier.size(18.dp)) },
                        onClick = { open = false; onSelect(value) },
                    )
                }
            }
        }
    }
}

/** `DisclosureGroup` header row with the rotating accent chevron. */
@Composable
fun DisclosureHeader(label: String, expanded: Boolean, onToggle: () -> Unit) {
    val rotation by animateFloatAsState(if (expanded) 90f else 0f, label = "chevron")
    Row(Modifier.fillMaxWidth().clickable(onClick = onToggle), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = IosType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        Icon(Icons.Filled.ChevronRight, null, tint = PhrenTheme.accent, modifier = Modifier.size(20.dp).rotate(rotation))
    }
}

/** Navigation-link chevron at the trailing edge of a row. */
@Composable
fun DisclosureChevron() {
    Icon(Icons.Filled.ChevronRight, null, tint = PhrenTheme.tertiaryLabel, modifier = Modifier.size(20.dp))
}

/**
 * Sheet for entering or editing a piece of text, with an optional finding
 * type picker (add finding, edit finding, promote note).
 */
@Composable
fun TextEntrySheet(
    title: String,
    initialText: String = "",
    initialType: FindingType? = null,
    showsTypePicker: Boolean = false,
    confirmLabel: String = "Save",
    onDismiss: () -> Unit,
    onConfirm: (String, FindingType?) -> Unit,
) {
    var text by remember { mutableStateOf(initialText) }
    var type by remember { mutableStateOf(initialType) }
    IosSheet(
        onDismiss = onDismiss, title = title, confirmLabel = confirmLabel,
        confirmEnabled = text.isNotBlank(),
        onConfirm = { onConfirm(text, type); onDismiss() },
    ) {
        LazyColumn {
            item { Spacer(Modifier.height(20.dp)) }
            item {
                FormCell { FormTextField(text, { text = it }, "Text", minLines = 3, autofocus = true) }
            }
            if (showsTypePicker) {
                item { Spacer(Modifier.height(20.dp)) }
                item {
                    FormCell {
                        FormPicker(
                            "Type",
                            listOf<Pair<FindingType?, String>>(null to "none") + FindingType.entries.map { it to it.rawValue },
                            type,
                        ) { type = it }
                    }
                }
            }
        }
    }
}

val MonoCaption = TextStyle(fontFamily = FontFamily.Monospace)
