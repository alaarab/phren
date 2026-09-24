package com.phren.android.design

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PhrenType.semibold
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/*
 * The Phren control kit (PhrenControls.swift, design/controls.md): switch,
 * option rows and groups, single/multi select sheets, text segments, icon
 * buttons, action sheets, dialogs, steppers, the PhrenScreen scaffold, search
 * and text fields, chip rows, step sliders and disclosure. Measurements are
 * the contract's points, taken as dp.
 */

private const val DISABLED_ALPHA = 0.45f

/** testTag stands in for accessibilityIdentifier. */
fun Modifier.phrenIdentifier(id: String) = this.testTag(id)

/** A 44×44 plain tap target with no ripple (SwiftUI's `.buttonStyle(.plain)`). */
@Composable
fun Modifier.plainClickable(enabled: Boolean = true, role: Role = Role.Button, onClick: () -> Unit): Modifier =
    this.clickable(enabled = enabled, role = role, interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)

/** Boolean preference: a 44×26 capsule with a white 22pt knob in a 44×44 target. */
@Composable
fun PhrenSwitch(isOn: Boolean, onChange: (Boolean) -> Unit, label: String = "Enabled", enabled: Boolean = true, modifier: Modifier = Modifier) {
    val offset by animateDpAsState(if (isOn) 9.dp else (-9).dp, tween(180), label = "knob")
    Box(
        modifier.size(44.dp).alpha(if (enabled) 1f else DISABLED_ALPHA)
            .plainClickable(enabled, Role.Switch) { onChange(!isOn) }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(44.dp, 26.dp).background(if (isOn) PhrenTheme.accentSolid else PhrenTheme.surfaceRaised, CircleShape))
        Box(Modifier.offset(x = offset).size(22.dp).background(PhrenTheme.onAccent, CircleShape))
    }
}

/** A labelled switch row: `PhrenSwitch("Title", isOn:)`. */
@Composable
fun PhrenSwitchRow(title: String, isOn: Boolean, onChange: (Boolean) -> Unit, icon: ImageVector? = null, enabled: Boolean = true, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 44.dp).alpha(if (enabled) 1f else DISABLED_ALPHA).plainClickable(enabled, Role.Switch) { onChange(!isOn) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = PhrenTheme.text, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
        }
        Text(title, style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(PhrenTheme.Space.medium))
        PhrenSwitch(isOn, onChange, title, enabled)
    }
}

/** One choice: stable id, typed value, title, optional caption/icon (PhrenOption). */
data class PhrenOption<V>(
    val id: String,
    val value: V,
    val title: String,
    val caption: String? = null,
    val icon: ImageVector? = null,
    val glyph: (@Composable () -> Unit)? = null,
    val trailing: (@Composable () -> Unit)? = null,
    val muted: Boolean = false,
    val accessibilityLabel: String? = null,
    val isEnabled: Boolean = true,
)

object PhrenOptionSelection {
    fun <V> single(value: V, options: List<PhrenOption<V>>, current: V): V =
        if (options.any { it.value == value && it.isEnabled }) value else current

    fun <V> multiple(value: V, options: List<PhrenOption<V>>, current: Set<V>): Set<V> {
        if (options.none { it.value == value && it.isEnabled }) return current
        return if (value in current) current - value else current + value
    }
}

enum class OptionMark { RADIO, CHECK }

/** The radio/check row used for every choice (PhrenOptionRow). */
@Composable
fun PhrenOptionRow(
    title: String,
    caption: String? = null,
    selected: Boolean = false,
    mark: OptionMark = OptionMark.RADIO,
    disabled: Boolean = false,
    icon: ImageVector? = null,
    glyph: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    detail: (@Composable () -> Unit)? = null,
    radius: Dp = PhrenTheme.Radius.questionOption,
    minimumHeight: Dp = 44.dp,
    muted: Boolean = false,
    outlined: Boolean = false,
    captionColor: Color = PhrenTheme.textMuted,
    modifier: Modifier = Modifier,
    action: () -> Unit,
) {
    val shape = RoundedCornerShape(radius)
    val fill = if (selected) PhrenTheme.cyan.copy(alpha = 0.1f) else PhrenTheme.surfaceRaised
    val stroke = if (selected) PhrenTheme.cyan.copy(alpha = 0.5f) else if (outlined) PhrenTheme.borderStrong else Color.Transparent
    val markIcon = when {
        selected && mark == OptionMark.CHECK -> SF("checkmark.square.fill")
        selected -> SF("checkmark.circle.fill")
        mark == OptionMark.CHECK -> SF("square")
        else -> SF("circle")
    }
    Column(
        modifier.fillMaxWidth().alpha(if (disabled) DISABLED_ALPHA else 1f)
            .background(fill, shape).border(1.dp, stroke, shape).clip(shape),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = maxOf(44.dp, minimumHeight))
                .plainClickable(!disabled, Role.RadioButton, action)
                .semantics { this.selected = selected }
                .padding(start = PhrenTheme.Space.medium, end = PhrenTheme.Space.medium, top = PhrenTheme.Space.medium, bottom = if (detail != null) PhrenTheme.Space.small else PhrenTheme.Space.medium),
            verticalAlignment = Alignment.Top,
        ) {
            Box(Modifier.width(22.dp).padding(top = 1.dp), contentAlignment = Alignment.Center) {
                Icon(markIcon, null, tint = if (selected) PhrenTheme.cyan else PhrenTheme.textDim, modifier = Modifier.size(18.dp))
            }
            if (glyph != null || icon != null) {
                Spacer(Modifier.width(10.dp))
                Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) {
                    if (glyph != null) glyph() else Icon(icon!!, null, tint = PhrenTheme.textSecondary, modifier = Modifier.size(18.dp))
                }
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.xs)) {
                Text(title, style = PhrenType.body, color = if (muted) PhrenTheme.textMuted else PhrenTheme.text)
                if (!caption.isNullOrEmpty()) Text(caption, style = PhrenType.caption, color = captionColor)
            }
            if (trailing != null) {
                Spacer(Modifier.width(8.dp))
                trailing()
            }
        }
        if (detail != null) {
            val inset = PhrenTheme.Space.medium + 32.dp + if (glyph != null || icon != null) 32.dp else 0.dp
            Box(Modifier.padding(start = inset, end = PhrenTheme.Space.medium, bottom = PhrenTheme.Space.medium)) { detail() }
        }
    }
}

/** Select exactly one typed value (PhrenOptionGroup). */
@Composable
fun <V> PhrenOptionGroup(options: List<PhrenOption<V>>, selection: V, onSelect: (V) -> Unit, identifier: String) {
    Column(verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
        options.forEach { option ->
            PhrenOptionRow(
                option.title, option.caption, selection == option.value, disabled = !option.isEnabled, icon = option.icon,
                modifier = Modifier.phrenIdentifier("$identifier:${option.id}"),
            ) { onSelect(PhrenOptionSelection.single(option.value, options, selection)) }
        }
    }
}

/** Independent choices bound to a set (PhrenMultiOptionGroup). */
@Composable
fun <V> PhrenMultiOptionGroup(options: List<PhrenOption<V>>, selection: Set<V>, onChange: (Set<V>) -> Unit, identifier: String) {
    Column(verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
        options.forEach { option ->
            PhrenOptionRow(
                option.title, option.caption, option.value in selection, OptionMark.CHECK, !option.isEnabled, option.icon,
                modifier = Modifier.phrenIdentifier("$identifier:${option.id}"),
            ) { onChange(PhrenOptionSelection.multiple(option.value, options, selection)) }
        }
    }
}

/** The capsule trigger for a select sheet: summary + a 9pt chevron. */
@Composable
fun PhrenSelectTrigger(summary: String, placeholder: Boolean = false, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 44.dp).alpha(if (enabled) 1f else DISABLED_ALPHA)
            .background(PhrenTheme.surfaceRaised, CircleShape).clip(CircleShape)
            .plainClickable(enabled, onClick = onClick).padding(horizontal = PhrenTheme.Space.medium),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            summary, style = PhrenType.subheadline.medium(), maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (placeholder || !enabled) PhrenTheme.textMuted else PhrenTheme.text, modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(PhrenTheme.Space.xs))
        Icon(SF("chevron.down"), null, tint = if (enabled) PhrenTheme.text else PhrenTheme.textMuted, modifier = Modifier.size(13.dp))
    }
}

/** Compact multi-select trigger summarizing chosen values (PhrenMultiSelect). */
@Composable
fun <V> PhrenMultiSelect(options: List<PhrenOption<V>>, selection: Set<V>, allLabel: String, identifier: String, enabled: Boolean = true, onOpen: () -> Unit) {
    val chosen = options.filter { it.value in selection }
    val summary = if (chosen.isEmpty() || chosen.size == options.size) allLabel else chosen.joinToString(", ") { it.title }
    PhrenSelectTrigger(summary, enabled = enabled, modifier = Modifier.phrenIdentifier(identifier), onClick = onOpen)
}

/** Single-select trigger (PhrenSingleSelect). */
@Composable
fun <V> PhrenSingleSelect(options: List<PhrenOption<V>>, selection: V, placeholder: String, identifier: String, enabled: Boolean = true, onOpen: () -> Unit) {
    val chosen = options.firstOrNull { it.value == selection }
    PhrenSelectTrigger(chosen?.title ?: placeholder, chosen == null, enabled, Modifier.phrenIdentifier(identifier), onOpen)
}

/**
 * A full-window overlay above navigation and tabs (the kit presents every
 * modal at the full-screen root): 0.5 black scrim, content placed by caller.
 */
@Composable
fun PhrenOverlay(onDismiss: () -> Unit, dismissOnScrimTap: Boolean = true, alignment: Alignment = Alignment.Center, content: @Composable () -> Unit) {
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, dismissOnClickOutside = false)) {
        var shown by remember { mutableStateOf(false) }
        androidx.compose.runtime.LaunchedEffect(Unit) { shown = true }
        Box(
            Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }.background(Color.Black.copy(alpha = 0.5f))
                .pointerInput(dismissOnScrimTap) { detectTapGestures { if (dismissOnScrimTap) onDismiss() } }
                .windowInsetsPadding(WindowInsets.safeDrawing),
            contentAlignment = alignment,
        ) {
            AnimatedVisibility(shown, enter = if (alignment == Alignment.BottomCenter) slideInVertically(tween(180)) { it } + fadeIn(tween(180)) else fadeIn(tween(180)), exit = fadeOut()) {
                Box(Modifier.pointerInput(Unit) { detectTapGestures { } }) { content() }
            }
        }
    }
}

/** The centered multi-select card (PhrenMultiSelectSheet). */
@Composable
fun <V> PhrenMultiSelectSheet(
    title: String,
    options: List<PhrenOption<V>>,
    selection: Set<V>,
    onChange: (Set<V>) -> Unit,
    rowPrefix: String,
    requiresSelection: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    onDismiss: () -> Unit,
) {
    PhrenOverlay(onDismiss) {
        BoxWithConstraints {
            var query by remember { mutableStateOf("") }
            val chosen = options.filter { it.value in selection }
            val words = query.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            val matches = options.filter { o -> words.all { w -> (o.title + " " + (o.caption ?: "")).contains(w, true) } }
            val enabledValues = options.filter { it.isEnabled }.map { it.value }.toSet()
            val all = selection + enabledValues
            val none = (selection - enabledValues).let { next -> if (requiresSelection && options.none { it.value in next }) selection else next }
            fun toggle(o: PhrenOption<V>) {
                val next = PhrenOptionSelection.multiple(o.value, options, selection)
                onChange(if (requiresSelection && options.none { it.value in next }) selection else next)
            }
            Column(
                Modifier.padding(PhrenTheme.Space.large).widthIn(max = 360.dp).heightIn(max = minOf(600.dp, maxHeight * 0.85f))
                    .clip(RoundedCornerShape(PhrenTheme.Radius.large)).background(PhrenTheme.surface).padding(PhrenTheme.Space.large)
                    .phrenIdentifier("$rowPrefix-sheet"),
                verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.medium),
            ) {
                Text(title, style = PhrenType.subheadline.semibold(), color = PhrenTheme.text)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.xs)) {
                    if (options.size > 8) PhrenSearchField(query, { query = it }, identifier = "$rowPrefix-search", modifier = Modifier.weight(1f))
                    else Spacer(Modifier.weight(1f))
                    BulkButton("All", all == selection, "$rowPrefix-all") { onChange(all) }
                    BulkButton("None", none == selection, "$rowPrefix-none") { onChange(none) }
                }
                if (chosen.isNotEmpty()) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
                        chosen.forEach { o ->
                            val locked = !o.isEnabled || (requiresSelection && chosen.size == 1)
                            Row(
                                Modifier.heightIn(min = 44.dp).alpha(if (locked) DISABLED_ALPHA else 1f).plainClickable(!locked) { toggle(o) }
                                    .phrenIdentifier("$rowPrefix-chip:${o.id}"),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Row(
                                    Modifier.background(PhrenTheme.cyan.copy(alpha = 0.1f), CircleShape).border(1.dp, PhrenTheme.cyan.copy(alpha = 0.5f), CircleShape)
                                        .padding(horizontal = 10.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(o.title, style = PhrenType.caption.medium(), color = PhrenTheme.cyan)
                                    Spacer(Modifier.width(6.dp))
                                    Icon(SF("xmark"), "Remove ${o.title}", tint = PhrenTheme.cyan, modifier = Modifier.size(12.dp))
                                }
                            }
                        }
                    }
                }
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.xs)) {
                    leading?.invoke()
                    if (matches.isEmpty()) Text("No matches", style = PhrenType.subheadline, color = PhrenTheme.textMuted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(top = 10.dp))
                    matches.forEach { o ->
                        val sel = o.value in selection
                        val shape = RoundedCornerShape(PhrenTheme.Radius.questionOption)
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 40.dp).alpha(if (o.isEnabled) 1f else DISABLED_ALPHA)
                                .background(if (sel) PhrenTheme.cyan.copy(alpha = 0.1f) else PhrenTheme.surfaceRaised, shape)
                                .border(1.dp, if (sel) PhrenTheme.cyan.copy(alpha = 0.5f) else Color.Transparent, shape).clip(shape)
                                .plainClickable(o.isEnabled) { toggle(o) }.semantics { selected = sel }
                                .phrenIdentifier("$rowPrefix:${o.id}").padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            o.icon?.let { Icon(it, null, tint = PhrenTheme.textMuted, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(PhrenTheme.Space.small)) }
                            Column(Modifier.weight(1f)) {
                                Text(o.title, style = PhrenType.subheadline, color = PhrenTheme.text)
                                o.caption?.let { Text(it, style = PhrenType.caption, color = PhrenTheme.textMuted) }
                            }
                            Icon(SF("checkmark"), null, tint = PhrenTheme.cyan, modifier = Modifier.size(14.dp).alpha(if (sel) 1f else 0f))
                        }
                    }
                }
                SheetBottomButton("Done (${chosen.size})", "$rowPrefix-done", onDismiss)
            }
        }
    }
}

@Composable
private fun BulkButton(title: String, disabled: Boolean, id: String, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).alpha(if (disabled) DISABLED_ALPHA else 1f).plainClickable(!disabled, onClick = onClick).phrenIdentifier(id), contentAlignment = Alignment.Center) {
        Text(title, style = PhrenType.caption.semibold(), color = PhrenTheme.accent)
    }
}

@Composable
private fun SheetBottomButton(title: String, id: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(PhrenTheme.Radius.questionOption)
    Box(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).background(PhrenTheme.surfaceRaised, shape).clip(shape).plainClickable(onClick = onClick).phrenIdentifier(id),
        contentAlignment = Alignment.Center,
    ) { Text(title, style = PhrenType.body.medium(), color = PhrenTheme.accent) }
}

/** The centered single-select card (PhrenSingleSelectSheet). */
@Composable
fun <V> PhrenSingleSelectSheet(
    title: String,
    options: List<PhrenOption<V>>,
    selection: V,
    onSelect: (V) -> Unit,
    rowPrefix: String,
    loading: Boolean = false,
    loadingLabel: String = "Loading…",
    message: String? = null,
    footer: (@Composable () -> Unit)? = null,
    below: ((V) -> (@Composable () -> Unit)?)? = null,
    dismissOnSelect: Boolean = true,
    onDismiss: () -> Unit,
) {
    PhrenOverlay(onDismiss) {
        BoxWithConstraints {
            Column(
                Modifier.padding(PhrenTheme.Space.large).widthIn(max = 360.dp).heightIn(max = maxHeight - 32.dp)
                    .clip(RoundedCornerShape(PhrenTheme.Radius.large)).background(PhrenTheme.surface).padding(PhrenTheme.Space.large)
                    .phrenIdentifier("$rowPrefix-sheet"),
                verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.medium),
            ) {
                Text(title, style = PhrenType.subheadline.semibold(), color = PhrenTheme.text)
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
                    if (loading) {
                        PhrenOptionRow(loadingLabel, disabled = true, muted = true, modifier = Modifier.phrenIdentifier("$rowPrefix-loading")) {}
                    } else {
                        message?.let { PhrenOptionRow(it, disabled = true, muted = true, modifier = Modifier.phrenIdentifier("$rowPrefix-message")) {} }
                        options.forEach { o ->
                            PhrenOptionRow(
                                o.title, o.caption, selection == o.value, OptionMark.RADIO, !o.isEnabled, o.icon, o.glyph, o.trailing, muted = o.muted,
                                modifier = Modifier.phrenIdentifier("$rowPrefix:${o.id}"),
                            ) {
                                if (o.isEnabled) {
                                    onSelect(PhrenOptionSelection.single(o.value, options, selection))
                                    if (dismissOnSelect) onDismiss()
                                }
                            }
                            below?.invoke(o.value)?.invoke()
                        }
                    }
                    footer?.invoke()
                    SheetBottomButton(if (selection == null) "Cancel" else "Close", "$rowPrefix-done", onDismiss)
                }
            }
        }
    }
}

/** Short mutually exclusive modes (PhrenTextSegment). */
@Composable
fun <V> PhrenTextSegment(items: List<PhrenOption<V>>, selection: V, onSelect: (V) -> Unit, identifier: String, bare: Boolean = false, enabled: Boolean = true, modifier: Modifier = Modifier) {
    Row(
        modifier.then(if (bare) Modifier else Modifier.background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.large)).padding(2.dp)),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items.forEach { item ->
            val sel = item.value == selection
            val on = enabled && item.isEnabled
            Row(
                Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp).alpha(if (on) 1f else DISABLED_ALPHA)
                    .background(if (sel) PhrenTheme.accent.copy(alpha = 0.16f) else Color.Transparent, CircleShape).clip(CircleShape)
                    .plainClickable(on) { onSelect(PhrenOptionSelection.single(item.value, items, selection)) }
                    .semantics { selected = sel; contentDescription = item.accessibilityLabel ?: item.title }
                    .phrenIdentifier("$identifier:${item.id}")
                    .padding(horizontal = PhrenTheme.Space.medium, vertical = PhrenTheme.Space.xs),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
            ) {
                val color = if (sel) PhrenTheme.accent else PhrenTheme.textMuted
                item.icon?.let { Icon(it, null, tint = color, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)) }
                Text(item.title, style = PhrenType.subheadline.medium(), color = color)
            }
        }
    }
}

/** A 32pt surfaceRaised circle inside a 44×44 target (PhrenIconButton). */
@Composable
fun PhrenIconButton(icon: ImageVector, label: String, destructive: Boolean = false, enabled: Boolean = true, modifier: Modifier = Modifier, action: () -> Unit) {
    Box(
        modifier.size(44.dp).alpha(if (enabled) 1f else DISABLED_ALPHA).plainClickable(enabled, onClick = action).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(32.dp).background(PhrenTheme.surfaceRaised, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = if (destructive) PhrenTheme.danger else PhrenTheme.accent, modifier = Modifier.size(18.dp))
        }
    }
}

/** An action or a picker value in an action sheet or dialog (PhrenControlAction). */
data class PhrenControlAction(
    val id: String,
    val title: String,
    val icon: ImageVector? = null,
    val iconColor: Color? = null,
    val caption: String? = null,
    val role: Role = Role.NORMAL,
    val isEnabled: Boolean = true,
    val isSelected: Boolean? = null,
    val dismisses: Boolean = true,
    val accessibilityIdentifier: String? = null,
    val handler: () -> Unit,
) {
    enum class Role { NORMAL, DESTRUCTIVE, CANCEL }

    /** Dismisses before running, so a handler can open a dialog or route. */
    fun perform(dismiss: () -> Unit) {
        if (!isEnabled) return
        if (dismisses) dismiss()
        handler()
    }
}

/** The bottom action surface with a handle, header and rows (PhrenActionSheet). */
@Composable
fun PhrenActionSheet(title: String, actions: List<PhrenControlAction>, identifier: String = "phren-action-sheet", searchPlaceholder: String? = null, onDismiss: () -> Unit) {
    PhrenOverlay(onDismiss, alignment = Alignment.BottomCenter) {
        BoxWithConstraints {
            val drag = remember { Animatable(0f) }
            val scope = rememberCoroutineScope()
            val density = LocalDensity.current
            var query by remember { mutableStateOf("") }
            val words = query.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            val filtered = actions.filter { a -> words.all { w -> (a.title + " " + (a.caption ?: "")).contains(w, true) } }
            Column(
                Modifier.padding(8.dp).widthIn(max = 560.dp).fillMaxWidth().heightIn(max = maxHeight * 0.85f)
                    .offset { IntOffset(0, drag.value.roundToInt()) }
                    .clip(RoundedCornerShape(PhrenTheme.Radius.large)).background(PhrenTheme.surface)
                    .phrenIdentifier(identifier),
            ) {
                Column(
                    Modifier.fillMaxWidth().pointerInput(Unit) {
                        var total = 0f
                        detectVerticalDragGestures(
                            onDragStart = { total = 0f },
                            onDragEnd = {
                                if (total > with(density) { 80.dp.toPx() }) onDismiss()
                                scope.launch { drag.animateTo(0f, tween(180)) }
                            },
                        ) { _, amount ->
                            total += amount
                            scope.launch { drag.snapTo(maxOf(0f, total)) }
                        }
                    },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Spacer(Modifier.height(8.dp))
                    Box(Modifier.size(32.dp, 4.dp).background(PhrenTheme.textDim, CircleShape))
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 16.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(title, style = PhrenType.subheadline.semibold(), color = PhrenTheme.text, modifier = Modifier.weight(1f))
                        PhrenIconButton(SF("xmark"), "Close $title", modifier = Modifier.phrenIdentifier("$identifier:close"), action = onDismiss)
                    }
                }
                if (searchPlaceholder != null) {
                    PhrenSearchField(query, { query = it }, searchPlaceholder, "$identifier:search", Modifier.padding(start = 8.dp, end = 8.dp, bottom = 8.dp))
                }
                Column(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(start = 8.dp, end = 8.dp, bottom = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (filtered.isEmpty()) Text("No matches", style = PhrenType.subheadline, color = PhrenTheme.textMuted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(top = 14.dp))
                    filtered.forEach { a ->
                        val id = a.accessibilityIdentifier ?: "$identifier:${a.id}"
                        if (a.isSelected != null) {
                            PhrenOptionRow(a.title, a.caption, a.isSelected, disabled = !a.isEnabled, icon = a.icon, minimumHeight = 48.dp, modifier = Modifier.phrenIdentifier(id)) { a.perform(onDismiss) }
                        } else {
                            val color = if (a.role == PhrenControlAction.Role.DESTRUCTIVE) PhrenTheme.danger else PhrenTheme.text
                            val shape = RoundedCornerShape(PhrenTheme.Radius.questionOption)
                            Row(
                                Modifier.fillMaxWidth().heightIn(min = 48.dp).alpha(if (a.isEnabled) 1f else DISABLED_ALPHA)
                                    .background(PhrenTheme.surfaceRaised, shape).clip(shape).plainClickable(a.isEnabled) { a.perform(onDismiss) }
                                    .phrenIdentifier(id).padding(12.dp),
                                verticalAlignment = Alignment.Top,
                            ) {
                                Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) {
                                    if (a.icon != null) Icon(a.icon, null, tint = a.iconColor ?: color, modifier = Modifier.size(18.dp))
                                }
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(a.title, style = PhrenType.body, color = color)
                                    a.caption?.let { Text(it, style = PhrenType.caption, color = PhrenTheme.textMuted) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A centered decision card with 1–3 actions (PhrenDialog). Backdrop taps do nothing. */
@Composable
fun PhrenDialog(title: String, message: String, actions: List<PhrenControlAction>, identifier: String = "phren-dialog", onDismiss: () -> Unit) {
    require(actions.size in 1..3) { "A dialog needs one to three actions" }
    PhrenOverlay(onDismiss, dismissOnScrimTap = false) {
        Column(
            Modifier.padding(16.dp).widthIn(max = 360.dp).clip(RoundedCornerShape(PhrenTheme.Radius.large)).background(PhrenTheme.surface)
                .verticalScroll(rememberScrollState()).padding(16.dp).phrenIdentifier(identifier),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, style = PhrenType.subheadline.semibold(), color = PhrenTheme.text)
            Text(message, style = PhrenType.body, color = PhrenTheme.textSecondary)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                actions.forEach { a ->
                    val shape = RoundedCornerShape(PhrenTheme.Radius.questionOption)
                    Box(
                        Modifier.fillMaxWidth().heightIn(min = 44.dp).alpha(if (a.isEnabled) 1f else DISABLED_ALPHA)
                            .background(PhrenTheme.surfaceRaised, shape).clip(shape).plainClickable(a.isEnabled) { a.perform(onDismiss) }
                            .phrenIdentifier(a.accessibilityIdentifier ?: "$identifier:${a.id}").padding(horizontal = 12.dp, vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(a.title, style = PhrenType.body.medium(), color = if (a.role == PhrenControlAction.Role.DESTRUCTIVE) PhrenTheme.danger else PhrenTheme.accent, textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}

/** Bounded integer with − / + (PhrenStepperField). */
@Composable
fun PhrenStepperField(title: String, value: Int, onChange: (Int) -> Unit, range: IntRange, identifier: String, step: Int = 1, enabled: Boolean = true) {
    fun next(up: Boolean): Int {
        val amount = maxOf(1, step).toLong()
        val result = if (up) value + amount else value - amount
        return result.coerceIn(range.first.toLong(), range.last.toLong()).toInt()
    }
    Row(Modifier.fillMaxWidth().alpha(if (enabled) 1f else DISABLED_ALPHA).phrenIdentifier(identifier), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        PhrenIconButton(SF("minus"), "Decrease $title", enabled = enabled && value > range.first, modifier = Modifier.phrenIdentifier("$identifier:minus")) { onChange(next(false)) }
        Spacer(Modifier.width(8.dp))
        Box(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp).phrenIdentifier("$identifier:value"), contentAlignment = Alignment.Center) {
            Text("$value", style = PhrenType.monoSubheadline, color = PhrenTheme.text)
        }
        Spacer(Modifier.width(8.dp))
        PhrenIconButton(SF("plus"), "Increase $title", enabled = enabled && value < range.last, modifier = Modifier.phrenIdentifier("$identifier:plus")) { onChange(next(true)) }
    }
}

/** The scrolling editor/settings scaffold: 16 margins, 24 between groups, on bg. */
@Composable
fun PhrenScreen(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxSize().background(PhrenTheme.bg).verticalScroll(rememberScrollState()).padding(PhrenTheme.Space.large),
        verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.section),
        content = content,
    )
}

/** A captioned group of controls (PhrenGroup). */
@Composable
fun PhrenGroup(caption: String, identifier: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
        SectionLabel(caption, Modifier.phrenIdentifier(identifier ?: "phren-group:$caption"))
        content()
    }
}

/** plainListSectionLabel: caption semibold uppercase, textMuted, 14 leading. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, leading: Dp = 14.dp) {
    Text(text.uppercase(), style = PhrenType.sectionLabel, color = PhrenTheme.textMuted, modifier = modifier.padding(start = leading, top = 8.dp))
}

/** A navigation row: icon, title, optional trailing detail and chevron (PhrenRow). */
@Composable
fun PhrenRow(icon: ImageVector, title: String, chevron: Boolean = true, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, trailing: (@Composable RowScope.() -> Unit)? = null) {
    val shape = RoundedCornerShape(PhrenTheme.Radius.questionOption)
    Row(
        modifier.fillMaxWidth().heightIn(min = 44.dp).alpha(if (enabled) 1f else DISABLED_ALPHA)
            .background(PhrenTheme.surface, shape).clip(shape)
            .then(if (onClick != null) Modifier.plainClickable(enabled, onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) { Icon(icon, null, tint = PhrenTheme.textSecondary, modifier = Modifier.size(18.dp)) }
        Spacer(Modifier.width(12.dp))
        Text(title, style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides PhrenTheme.textMuted) { trailing() }
        }
        if (chevron) {
            Spacer(Modifier.width(12.dp))
            Icon(SF("chevron.right"), null, tint = PhrenTheme.textDim, modifier = Modifier.size(16.dp))
        }
    }
}

/** Search field: magnifier, text, clear button (PhrenSearchField). */
@Composable
fun PhrenSearchField(
    text: String,
    onChange: (String) -> Unit,
    placeholder: String = "Search",
    identifier: String,
    modifier: Modifier = Modifier,
    focusRequester: FocusRequester? = null,
    enabled: Boolean = true,
    onSubmit: () -> Unit = {},
) {
    Row(
        modifier.heightIn(min = 44.dp).alpha(if (enabled) 1f else DISABLED_ALPHA)
            .background(PhrenTheme.surfaceRaised, RoundedCornerShape(PhrenTheme.Radius.questionOption))
            .padding(start = PhrenTheme.Space.medium, end = if (text.isEmpty()) PhrenTheme.Space.medium else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(SF("magnifyingglass"), null, tint = PhrenTheme.textMuted, modifier = Modifier.size(17.dp))
        Spacer(Modifier.width(PhrenTheme.Space.small))
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (text.isEmpty()) Text(placeholder, style = PhrenType.body, color = PhrenTheme.textMuted, maxLines = 1)
            BasicTextField(
                text, onChange, singleLine = true, enabled = enabled,
                textStyle = PhrenType.body.copy(color = PhrenTheme.text), cursorBrush = SolidColor(PhrenTheme.cyan),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onSubmit() }),
                modifier = Modifier.fillMaxWidth().phrenIdentifier(identifier).then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
            )
        }
        if (text.isNotEmpty()) {
            Box(Modifier.size(44.dp).plainClickable { onChange("") }.phrenIdentifier("$identifier:clear").semantics { contentDescription = "Clear search" }, contentAlignment = Alignment.Center) {
                Icon(SF("xmark.circle.fill"), null, tint = PhrenTheme.textMuted, modifier = Modifier.size(18.dp))
            }
        }
    }
}

enum class PhrenFieldSurface { RAISED, BARE }

/** Raised text field (PhrenTextField): 12 padding, 44 minimum, cyan cursor. */
@Composable
fun PhrenTextField(
    placeholder: String,
    text: String,
    onChange: (String) -> Unit,
    identifier: String? = null,
    multiline: Boolean = false,
    minLines: Int = 1,
    monospaced: Boolean = false,
    surface: PhrenFieldSurface = PhrenFieldSurface.RAISED,
    secure: Boolean = false,
    focusRequester: FocusRequester? = null,
    enabled: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    modifier: Modifier = Modifier,
) {
    val raised = surface == PhrenFieldSurface.RAISED
    val style = (if (monospaced) PhrenType.monoBody else PhrenType.body).copy(color = PhrenTheme.text)
    Box(
        modifier.fillMaxWidth().heightIn(min = 44.dp).alpha(if (enabled) 1f else DISABLED_ALPHA)
            .then(if (raised) Modifier.background(PhrenTheme.surfaceRaised, RoundedCornerShape(PhrenTheme.Radius.questionOption)).padding(horizontal = PhrenTheme.Space.medium, vertical = PhrenTheme.Space.small + 2.dp) else Modifier),
        contentAlignment = if (multiline) Alignment.TopStart else Alignment.CenterStart,
    ) {
        if (text.isEmpty()) Text(placeholder, style = style.copy(color = PhrenTheme.textDim))
        BasicTextField(
            text, onChange, enabled = enabled, singleLine = !multiline, minLines = minLines,
            textStyle = style, cursorBrush = SolidColor(PhrenTheme.cyan),
            visualTransformation = if (secure) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            keyboardOptions = if (secure) KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password) else keyboardOptions,
            modifier = Modifier.fillMaxWidth().then(if (identifier != null) Modifier.phrenIdentifier(identifier) else Modifier)
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
        )
    }
}

/** Horizontally scrolling single-choice chips (PhrenChipRow). */
@Composable
fun <V> PhrenChipRow(items: List<PhrenOption<V>>, selection: V, onSelect: (V) -> Unit, identifier: String, tint: (V) -> Color = { PhrenTheme.accent }, raised: Boolean = false, wraps: Boolean = false, enabled: Boolean = true) {
    val chip: @Composable (PhrenOption<V>) -> Unit = { item ->
        val sel = item.value == selection
        val color = tint(item.value)
        val on = enabled && item.isEnabled
        Box(Modifier.heightIn(min = 44.dp).alpha(if (on) 1f else DISABLED_ALPHA).plainClickable(on) { onSelect(PhrenOptionSelection.single(item.value, items, selection)) }.semantics { selected = sel }.phrenIdentifier("$identifier:${item.id}"), contentAlignment = Alignment.Center) {
            Row(
                Modifier.heightIn(min = 32.dp).background(if (sel) color.copy(alpha = 0.16f) else if (raised) PhrenTheme.surfaceRaised else PhrenTheme.surface, CircleShape).padding(horizontal = PhrenTheme.Space.medium),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                item.icon?.let { Icon(it, null, tint = if (sel) color else PhrenTheme.textSecondary, modifier = Modifier.size(13.dp)); Spacer(Modifier.width(PhrenTheme.Space.xs)) }
                Text(item.title, style = PhrenType.subheadline.medium(), color = if (sel) color else PhrenTheme.textSecondary, maxLines = 1)
            }
        }
    }
    if (wraps) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) { items.forEach { chip(it) } }
    } else {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) { items.forEach { chip(it) } }
    }
}

/** Ordered 3–5 value scale with detents (PhrenStepSlider). */
@Composable
fun <V> PhrenStepSlider(options: List<PhrenOption<V>>, selection: V, onSelect: (V) -> Unit, identifier: String, enabled: Boolean = true) {
    val haptics = LocalHapticFeedback.current
    val selectedIndex = options.indexOfFirst { it.value == selection }.coerceAtLeast(0)
    var dragIndex by remember { mutableStateOf<Int?>(null) }
    val shown = dragIndex ?: selectedIndex
    val steps = maxOf(options.size - 1, 1)
    var width by remember { mutableStateOf(1f) }
    fun detent(x: Float) = if (options.size <= 1 || width <= 0f) 0 else ((x / width).coerceIn(0f, 1f) * (options.size - 1)).roundToInt()
    fun choose(i: Int) {
        if (i !in options.indices || options[i].value == selection) return
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        onSelect(options[i].value)
    }
    Column(Modifier.fillMaxWidth().alpha(if (enabled) 1f else DISABLED_ALPHA).phrenIdentifier(identifier), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Box(
            Modifier.fillMaxWidth().height(28.dp).onSizeChanged { width = it.width.toFloat() }
                .pointerInput(enabled, options) {
                    if (!enabled) return@pointerInput
                    detectTapGestures { choose(detent(it.x)) }
                }
                .pointerInput(enabled, options, selection) {
                    if (!enabled) return@pointerInput
                    detectHorizontalDragGestures(
                        onDragEnd = { dragIndex?.let { choose(it) }; dragIndex = null },
                        onDragCancel = { dragIndex = null },
                    ) { change, _ ->
                        val next = detent(change.position.x)
                        if (next != dragIndex) { if (dragIndex != null) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); dragIndex = next }
                    }
                },
        ) {
            val density = LocalDensity.current
            val x = with(density) { (width * shown / steps).toDp() }
            Box(Modifier.align(Alignment.CenterStart).fillMaxWidth().height(3.dp).background(PhrenTheme.surfaceRaised, CircleShape))
            Box(Modifier.align(Alignment.CenterStart).width(maxOf(x, 3.dp)).height(3.dp).background(PhrenTheme.accent, CircleShape))
            options.indices.forEach { i ->
                val dx = with(density) { (width * i / steps).toDp() }
                Box(Modifier.align(Alignment.CenterStart).offset(x = dx - 2.5.dp).size(5.dp).background(if (i <= shown) PhrenTheme.accent else PhrenTheme.textDim, CircleShape))
            }
            val knob = if (dragIndex == null) 18.dp else 22.dp
            Box(Modifier.align(Alignment.CenterStart).offset(x = x - knob / 2).size(knob).background(PhrenTheme.bg, CircleShape).padding(2.dp).background(PhrenTheme.accent, CircleShape))
        }
        Row(Modifier.fillMaxWidth()) {
            options.forEachIndexed { i, o ->
                val title = if (options.size > 4) o.title.substringBefore(' ') else o.title
                Text(
                    title, style = PhrenType.caption2, color = if (i == shown) PhrenTheme.text else PhrenTheme.textMuted, maxLines = 1,
                    textAlign = when (i) { 0 -> TextAlign.Start; options.lastIndex -> TextAlign.End; else -> TextAlign.Center },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** A caption-styled expander (PhrenDisclosure). */
@Composable
fun PhrenDisclosure(title: String, initiallyExpanded: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    var expanded by remember { mutableStateOf(initiallyExpanded) }
    val rotation by animateFloatAsState(if (expanded) 90f else 0f, label = "chev")
    Column(verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).plainClickable { expanded = !expanded }, verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = PhrenType.caption, color = PhrenTheme.textMuted, modifier = Modifier.weight(1f))
            Icon(SF("chevron.right"), null, tint = PhrenTheme.textMuted, modifier = Modifier.size(14.dp).rotate(rotation))
        }
        if (expanded) content()
    }
}

/** A handled system back closes an open overlay first. */
@Composable
fun BackCloses(enabled: Boolean, onBack: () -> Unit) = BackHandler(enabled, onBack)

/** A color swatch that opens the shared color editor (PhrenColorButton). */
@Composable
fun PhrenColorButton(title: String, color: Color, identifier: String, action: () -> Unit) {
    Row(
        Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp).plainClickable(onClick = action).phrenIdentifier(identifier),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small),
    ) {
        Box(Modifier.size(28.dp).background(color, CircleShape).border(1.dp, PhrenTheme.border, CircleShape))
        Text(title, style = PhrenType.body, color = PhrenTheme.text)
    }
}

/**
 * RGB channels that apply immediately, like the adjacent hex field
 * (phrenColorSheet): the single-select card with only its footer.
 */
@Composable
fun PhrenColorSheet(title: String, selection: Color, onChange: (Color) -> Unit, identifier: String, onDismiss: () -> Unit) {
    val channels = listOf(selection.red, selection.green, selection.blue).map { (it.coerceIn(0f, 1f) * 255).roundToInt() }
    fun set(index: Int, value: Int) {
        val next = channels.toMutableList().also { it[index] = value.coerceIn(0, 255) }
        onChange(Color(next[0], next[1], next[2]))
    }
    PhrenSingleSelectSheet(title, emptyList<PhrenOption<Int>>(), 0, {}, rowPrefix = identifier, footer = {
        Column(verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.medium)) {
            Box(Modifier.fillMaxWidth().height(44.dp).background(selection, RoundedCornerShape(PhrenTheme.Radius.small)))
            PhrenStepperField("Red", channels[0], { set(0, it) }, 0..255, "$identifier:red")
            PhrenStepperField("Green", channels[1], { set(1, it) }, 0..255, "$identifier:green")
            PhrenStepperField("Blue", channels[2], { set(2, it) }, 0..255, "$identifier:blue")
        }
    }, onDismiss = onDismiss)
}
