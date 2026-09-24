package com.phren.android.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBackIos
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/*
 * A small UIKit-look kit so the Compose screens read like their SwiftUI
 * originals: navigation bars with large/inline titles and text/icon toolbar
 * items, inset-grouped lists, swipe actions, segmented pickers, search
 * fields, form sheets and a tab bar.
 */

/** iOS system fills used by controls (dark appearance). */
object IosColors {
    /** secondarySystemGroupedBackground (dark): the default List row. */
    val row = Color(0xFF1C1C1E)
    val fill = Color(0xFF767680).copy(alpha = 0.24f)
    val fillSelected = Color(0xFF636366)
    val groupedSheetBg = Color(0xFF1C1C1E)
    val groupedSheetRow = Color(0xFF2C2C2E)
    val menuBg = Color(0xFF2A2A2E)
}

data class ToolbarAction(
    val icon: ImageVector? = null,
    val text: String? = null,
    val contentDescription: String? = null,
    val enabled: Boolean = true,
    val bold: Boolean = false,
    val tint: Color? = null,
    val onClick: () -> Unit,
)

/** A navigation bar item: an SF-Symbol-style icon or a text button in the accent tint. */
@Composable
fun ToolbarButton(action: ToolbarAction) {
    val color = (action.tint ?: PhrenTheme.accent).let { if (action.enabled) it else it.copy(alpha = 0.35f) }
    Box(
        Modifier.heightIn(min = 44.dp).widthIn(min = 36.dp)
            .clickable(enabled = action.enabled, interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = action.onClick)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (action.icon != null && action.text != null) {
            // `Label(...).labelStyle(.titleAndIcon)`
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(action.icon, null, tint = color, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(4.dp))
                Text(action.text, style = IosType.body.copy(fontWeight = if (action.bold) FontWeight.SemiBold else FontWeight.Normal), color = color)
            }
        } else if (action.icon != null) Icon(action.icon, action.contentDescription ?: action.text, tint = color, modifier = Modifier.size(22.dp))
        else Text(action.text ?: "", style = IosType.body.copy(fontWeight = if (action.bold) FontWeight.SemiBold else FontWeight.Normal), color = color)
    }
}

/**
 * UINavigationBar: opaque navy, an optional back chevron, leading/trailing
 * items, and either an inline title or a large title below the bar.
 */
@Composable
fun IosNavBar(
    title: String,
    large: Boolean = false,
    backLabel: String? = null,
    onBack: (() -> Unit)? = null,
    leading: @Composable RowScope.() -> Unit = {},
    trailing: @Composable RowScope.() -> Unit = {},
    background: Color = PhrenTheme.bg,
) {
    Column(Modifier.fillMaxWidth().background(background).windowInsetsPadding(WindowInsets.statusBars)) {
        Box(Modifier.fillMaxWidth().height(44.dp)) {
            Row(Modifier.align(Alignment.CenterStart).padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (onBack != null) {
                    Row(
                        Modifier.heightIn(min = 44.dp)
                            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onBack),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBackIos, "Back", tint = PhrenTheme.accent, modifier = Modifier.size(22.dp))
                        if (backLabel != null) {
                            Text(backLabel, style = IosType.body, color = PhrenTheme.accent, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 110.dp))
                        }
                    }
                }
                leading()
            }
            if (!large) {
                Text(
                    title, style = IosType.headline, color = PhrenTheme.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.align(Alignment.Center).padding(horizontal = 96.dp),
                )
            }
            Row(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically, content = trailing)
        }
        if (large) {
            Text(title, style = IosType.largeTitle, color = PhrenTheme.text, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp))
        }
    }
}

/** A pushed or root screen: nav bar + content filling the rest. */
@Composable
fun IosScreen(
    title: String,
    large: Boolean = false,
    backLabel: String? = null,
    onBack: (() -> Unit)? = null,
    leading: @Composable RowScope.() -> Unit = {},
    trailing: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().background(PhrenTheme.bg)) {
        IosNavBar(title, large, backLabel, onBack, leading, trailing)
        content()
    }
}

// Inset-grouped lists

/** Where a row sits in its section, which decides its rounded corners and separator. */
enum class RowPosition { ONLY, FIRST, MIDDLE, LAST;
    companion object {
        fun of(index: Int, count: Int) = when {
            count == 1 -> ONLY
            index == 0 -> FIRST
            index == count - 1 -> LAST
            else -> MIDDLE
        }
    }
}

private fun RowPosition.shape(radius: Int = 10) = when (this) {
    RowPosition.ONLY -> RoundedCornerShape(radius.dp)
    RowPosition.FIRST -> RoundedCornerShape(topStart = radius.dp, topEnd = radius.dp)
    RowPosition.LAST -> RoundedCornerShape(bottomStart = radius.dp, bottomEnd = radius.dp)
    RowPosition.MIDDLE -> RoundedCornerShape(0.dp)
}

/** One cell of an inset-grouped section: the rounded background plus the inset separator. */
@Composable
fun IosCell(
    position: RowPosition,
    modifier: Modifier = Modifier,
    background: Color = IosColors.row,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    separatorInset: Int = 16,
    contentPadding: Boolean = true,
    content: @Composable BoxScope.() -> Unit,
) {
    val inset = LocalCellInset.current
    Box(modifier.padding(horizontal = inset.dp).fillMaxWidth().clip(position.shape()).background(background)) {
        Box(
            Modifier.fillMaxWidth()
                .then(if (onClick != null || onLongClick != null) Modifier.iosPressable(onClick, onLongClick) else Modifier)
                .heightIn(min = 44.dp)
                .then(if (contentPadding) Modifier.padding(horizontal = 16.dp, vertical = 11.dp) else Modifier),
            contentAlignment = Alignment.CenterStart,
            content = content,
        )
        if (position == RowPosition.FIRST || position == RowPosition.MIDDLE) {
            HorizontalDivider(Modifier.align(Alignment.BottomStart).padding(start = separatorInset.dp), thickness = 0.5.dp, color = PhrenTheme.separator)
        }
    }
}

fun Modifier.iosPressable(onClick: (() -> Unit)?, onLongClick: (() -> Unit)? = null): Modifier =
    this.combinedClickable(onClick = onClick ?: {}, onLongClick = onLongClick)

/** Section header: uppercase footnote in the secondary label color. */
@Composable
fun IosSectionHeader(text: String, icon: ImageVector? = null, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(start = 32.dp, end = 32.dp, top = 22.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(icon, null, tint = PhrenTheme.secondaryLabel, modifier = Modifier.size(13.dp))
            Spacer(Modifier.width(5.dp))
        }
        Text(text.uppercase(), style = IosType.footnote, color = PhrenTheme.secondaryLabel)
    }
}

@Composable
fun IosSectionFooter(text: String) {
    Text(text, style = IosType.footnote, color = PhrenTheme.secondaryLabel, modifier = Modifier.fillMaxWidth().padding(start = 32.dp, end = 32.dp, top = 7.dp))
}

/**
 * An inset-grouped section inside a LazyColumn: header, rows with rounded
 * outer corners, footer.
 */
fun <T> LazyListScope.iosSection(
    key: String,
    rows: List<T>,
    rowKey: (T) -> Any,
    header: String? = null,
    headerIcon: ImageVector? = null,
    footer: String? = null,
    footerContent: (@Composable () -> Unit)? = null,
    row: @Composable (T, RowPosition) -> Unit,
) {
    item(key = "$key#header", contentType = "header") {
        if (header != null) IosSectionHeader(header, headerIcon) else Spacer(Modifier.height(22.dp))
    }
    items(rows.size, key = { "$key#${rowKey(rows[it])}" }, contentType = { "row" }) { index ->
        row(rows[index], RowPosition.of(index, rows.size))
    }
    if (footer != null || footerContent != null) {
        item(key = "$key#footer", contentType = "footer") {
            if (footerContent != null) Box(Modifier.padding(start = 32.dp, end = 32.dp, top = 7.dp)) { footerContent() } else IosSectionFooter(footer!!)
        }
    }
}

// Swipe actions

data class SwipeAction(
    val label: String,
    val icon: ImageVector,
    val color: Color,
    val onClick: () -> Unit,
)

/**
 * `.swipeActions`: drag the row to reveal action buttons; a long drag past
 * the threshold performs the first action (iOS full swipe).
 */
@Composable
fun SwipeActionsRow(
    leading: List<SwipeAction> = emptyList(),
    trailing: List<SwipeAction> = emptyList(),
    position: RowPosition,
    content: @Composable () -> Unit,
) {
    if (leading.isEmpty() && trailing.isEmpty()) { content(); return }
    val density = LocalDensity.current
    val buttonWidth = with(density) { 74.dp.toPx() }
    val maxTrailing = buttonWidth * trailing.size
    val maxLeading = buttonWidth * leading.size
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var width by remember { mutableStateOf(1f) }

    fun settle(velocity: Float) {
        scope.launch {
            val x = offset.value
            when {
                trailing.isNotEmpty() && x < -width * 0.6f -> {
                    offset.animateTo(-width, tween(180)); trailing.first().onClick(); offset.snapTo(0f)
                }
                leading.isNotEmpty() && x > width * 0.6f -> {
                    offset.animateTo(width, tween(180)); leading.first().onClick(); offset.snapTo(0f)
                }
                x < -maxTrailing / 2 || velocity < -1500f && trailing.isNotEmpty() -> offset.animateTo(-maxTrailing)
                x > maxLeading / 2 || velocity > 1500f && leading.isNotEmpty() -> offset.animateTo(maxLeading)
                else -> offset.animateTo(0f)
            }
        }
    }

    Box(
        Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(position.shape())
            .height(IntrinsicSize.Min)
            .onSizeChanged { width = it.width.toFloat() },
    ) {
        // Revealed buttons, under the content.
        Row(Modifier.fillMaxHeight().align(Alignment.CenterEnd)) {
            trailing.forEach { a ->
                SwipeButton(a, with(density) { (if (offset.value < 0) (-offset.value / trailing.size) else 0f).toDp() }) {
                    scope.launch { offset.animateTo(0f) }; a.onClick()
                }
            }
        }
        Row(Modifier.fillMaxHeight().align(Alignment.CenterStart)) {
            leading.forEach { a ->
                SwipeButton(a, with(density) { (if (offset.value > 0) (offset.value / leading.size) else 0f).toDp() }) {
                    scope.launch { offset.animateTo(0f) }; a.onClick()
                }
            }
        }
        Box(
            Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }
                .draggable(
                    rememberDraggableState { delta ->
                        scope.launch {
                            val min = if (trailing.isEmpty()) 0f else -width
                            val max = if (leading.isEmpty()) 0f else width
                            offset.snapTo((offset.value + delta).coerceIn(min, max))
                        }
                    },
                    Orientation.Horizontal,
                    onDragStopped = { v -> settle(v) },
                ),
        ) {
            UnpaddedCell { content() }
        }
    }
}

/** Content inside a swipe row already has the outer inset; cells drop theirs. */
@Composable
private fun UnpaddedCell(content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalCellInset provides 0) { content() }
}

val LocalCellInset = androidx.compose.runtime.compositionLocalOf { 16 }

@Composable
private fun SwipeButton(action: SwipeAction, width: androidx.compose.ui.unit.Dp, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxHeight().width(width).background(action.color).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (width > 40.dp) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(action.icon, null, tint = Color.White, modifier = Modifier.size(20.dp))
                Text(action.label, style = IosType.caption.copy(fontWeight = FontWeight.Medium), color = Color.White, maxLines = 1)
            }
        }
    }
}

// Controls

/** UISegmentedControl. */
@Composable
fun <T> IosSegmented(options: List<T>, selected: T, label: (T) -> String, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().height(32.dp).clip(RoundedCornerShape(8.dp)).background(IosColors.fill).padding(2.dp),
    ) {
        options.forEach { option ->
            val isSelected = option == selected
            Box(
                Modifier.weight(1f).fillMaxHeight()
                    .clip(RoundedCornerShape(7.dp))
                    .background(if (isSelected) IosColors.fillSelected else Color.Transparent)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onSelect(option) },
                contentAlignment = Alignment.Center,
            ) {
                Text(label(option), style = IosType.footnote.copy(fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium), color = PhrenTheme.text, maxLines = 1)
            }
        }
    }
}

/** `.searchable`: a rounded search field with a magnifier and a clear button. */
@Composable
fun IosSearchField(value: String, onValueChange: (String) -> Unit, prompt: String, modifier: Modifier = Modifier, onSubmit: () -> Unit = {}) {
    Row(
        modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).height(36.dp)
            .clip(RoundedCornerShape(10.dp)).background(IosColors.fill).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Search, null, tint = PhrenTheme.secondaryLabel, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(prompt, style = IosType.body, color = PhrenTheme.secondaryLabel, maxLines = 1)
            BasicTextField(
                value, onValueChange, singleLine = true,
                textStyle = IosType.body.copy(color = PhrenTheme.text),
                cursorBrush = SolidColor(PhrenTheme.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onSubmit() }),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (value.isNotEmpty()) {
            Icon(Icons.Filled.Cancel, "Clear", tint = PhrenTheme.secondaryLabel, modifier = Modifier.size(18.dp).clickable { onValueChange("") })
        }
    }
}

/** A toolbar `Menu` with a checkmarked picker inside. */
@Composable
fun <T> IosPickerMenu(
    icon: ImageVector,
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
    contentDescription: String? = null,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        ToolbarButton(ToolbarAction(icon = icon, contentDescription = contentDescription) { open = true })
        DropdownMenu(open, { open = false }, containerColor = IosColors.menuBg, shape = RoundedCornerShape(13.dp)) {
            options.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label, style = IosType.body, color = PhrenTheme.text) },
                    leadingIcon = { if (value == selected) Icon(Icons.Filled.Check, null, tint = PhrenTheme.text, modifier = Modifier.size(18.dp)) else Spacer(Modifier.size(18.dp)) },
                    onClick = { open = false; onSelect(value) },
                )
            }
        }
    }
}

/** ProgressView(). */
@Composable
fun IosSpinner(modifier: Modifier = Modifier, size: Int = 20, color: Color = PhrenTheme.secondaryLabel) {
    CircularProgressIndicator(modifier.size(size.dp), color = color, strokeWidth = 2.dp)
}

/** `.refreshable`. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IosRefreshable(onRefresh: suspend () -> Unit, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { scope.launch { refreshing = true; try { onRefresh() } finally { refreshing = false } } },
        modifier = modifier,
        content = content,
    )
}

/**
 * A form sheet: `NavigationStack { Form { … } }` inside `.sheet` — inline
 * title, Cancel on the left, the confirm action on the right.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IosSheet(
    onDismiss: () -> Unit,
    title: String,
    cancelLabel: String? = "Cancel",
    confirmLabel: String? = null,
    confirmEnabled: Boolean = true,
    onConfirm: () -> Unit = {},
    trailing: (@Composable RowScope.() -> Unit)? = null,
    leading: (@Composable RowScope.() -> Unit)? = null,
    background: Color = IosColors.groupedSheetBg,
    content: @Composable ColumnScope.() -> Unit,
) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        containerColor = background,
        shape = RoundedCornerShape(topStart = 10.dp, topEnd = 10.dp),
        dragHandle = null,
        contentWindowInsets = { WindowInsets.navigationBars },
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.94f)) {
            Box(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp)) {
                if (leading != null) {
                    Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, content = leading)
                } else if (cancelLabel != null) {
                    Box(Modifier.align(Alignment.CenterStart)) { ToolbarButton(ToolbarAction(text = cancelLabel, onClick = onDismiss)) }
                }
                Text(title, style = IosType.headline, color = PhrenTheme.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.align(Alignment.Center).padding(horizontal = 96.dp))
                Row(Modifier.align(Alignment.CenterEnd), verticalAlignment = Alignment.CenterVertically) {
                    if (trailing != null) trailing()
                    else if (confirmLabel != null) ToolbarButton(ToolbarAction(text = confirmLabel, bold = true, enabled = confirmEnabled, onClick = onConfirm))
                }
            }
            content()
        }
    }
}

/** A row in a sheet's Form. */
@Composable
fun FormCell(position: RowPosition = RowPosition.ONLY, onClick: (() -> Unit)? = null, content: @Composable BoxScope.() -> Unit) =
    IosCell(position, background = IosColors.groupedSheetRow, onClick = onClick, content = content)

/** A small red count badge (tab bar `.badge`). */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier) {
    if (count <= 0) return
    Box(
        modifier.heightIn(min = 18.dp).widthIn(min = 18.dp).background(PhrenTheme.systemRed, CircleShape).padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(if (count > 99) "99+" else "$count", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium), color = Color.White)
    }
}

data class TabItem<T>(val tab: T, val label: String, val icon: ImageVector, val badge: Int = 0)

/** UITabBar. */
@Composable
fun <T> IosTabBar(items: List<TabItem<T>>, selected: T, onSelect: (T) -> Unit) {
    Column(Modifier.fillMaxWidth().background(PhrenTheme.bg).windowInsetsPadding(WindowInsets.navigationBars)) {
        HorizontalDivider(thickness = 0.5.dp, color = PhrenTheme.separator)
        Row(Modifier.fillMaxWidth().height(49.dp), horizontalArrangement = Arrangement.SpaceAround) {
            items.forEach { item ->
                val active = item.tab == selected
                val tint = if (active) PhrenTheme.accent else PhrenTheme.systemGray
                Column(
                    Modifier.weight(1f).fillMaxHeight()
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onSelect(item.tab) }
                        .padding(top = 5.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box {
                        Icon(item.icon, item.label, tint = tint, modifier = Modifier.size(26.dp))
                        if (item.badge > 0) CountBadge(item.badge, Modifier.align(Alignment.TopEnd).offset(x = 12.dp, y = (-4).dp))
                    }
                    Spacer(Modifier.height(2.dp))
                    Text(item.label, style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Medium), color = tint)
                }
            }
        }
    }
}

/** A tappable label-style row button (`Button { } label: { Label(...) }` in a List). */
@Composable
fun RowLabel(text: String, icon: ImageVector? = null, color: Color = PhrenTheme.accent, style: TextStyle = IosType.body) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(icon, null, tint = color, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
        }
        Text(text, style = style, color = color)
    }
}

/** An `.alert` with iOS button styling. */
@Composable
fun IosAlert(
    title: String,
    message: String? = null,
    onDismiss: () -> Unit,
    buttons: List<Triple<String, Boolean, () -> Unit>>,
) {
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.width(270.dp).clip(RoundedCornerShape(14.dp)).background(IosColors.menuBg),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(title, style = IosType.headline, color = PhrenTheme.text, textAlign = TextAlign.Center)
                if (message != null) {
                    Spacer(Modifier.height(2.dp))
                    Text(message, style = IosType.footnote, color = PhrenTheme.text, textAlign = TextAlign.Center)
                }
            }
            buttons.forEach { (label, destructive, action) ->
                HorizontalDivider(thickness = 0.5.dp, color = PhrenTheme.separator)
                Box(Modifier.fillMaxWidth().height(44.dp).clickable { action() }, contentAlignment = Alignment.Center) {
                    Text(label, style = IosType.body, color = if (destructive) PhrenTheme.systemRed else PhrenTheme.accent)
                }
            }
        }
    }
}

/** Modifier for a thin bordered rounded box. */
fun Modifier.roundedBorder(color: Color, radius: Int = 4) = this.border(1.dp, color, RoundedCornerShape(radius.dp))


/** One group inside a toolbar `Menu` (an inline Picker or a Toggle). */
data class MenuItemSpec(val label: String, val checked: Boolean, val onClick: () -> Unit)

/** A toolbar `Menu` holding several inline pickers/toggles, divided like iOS. */
@Composable
fun IosFilterMenu(icon: ImageVector, groups: List<List<MenuItemSpec>>, contentDescription: String? = "Filter") {
    var open by remember { mutableStateOf(false) }
    Box {
        ToolbarButton(ToolbarAction(icon = icon, contentDescription = contentDescription) { open = true })
        DropdownMenu(open, { open = false }, containerColor = IosColors.menuBg, shape = RoundedCornerShape(13.dp)) {
            groups.filter { it.isNotEmpty() }.forEachIndexed { i, group ->
                if (i > 0) HorizontalDivider(thickness = 6.dp, color = Color.Black.copy(alpha = 0.25f))
                group.forEach { item ->
                    DropdownMenuItem(
                        text = { Text(item.label, style = IosType.body, color = PhrenTheme.text) },
                        leadingIcon = { if (item.checked) Icon(Icons.Filled.Check, null, tint = PhrenTheme.text, modifier = Modifier.size(18.dp)) else Spacer(Modifier.size(18.dp)) },
                        onClick = { item.onClick() },
                    )
                }
            }
        }
    }
}

/** Long-press context menu (`.contextMenu`). */
@Composable
fun ContextMenu(expanded: Boolean, onDismiss: () -> Unit, items: List<Triple<String, ImageVector, Pair<Boolean, () -> Unit>>>) {
    DropdownMenu(expanded, onDismiss, containerColor = IosColors.menuBg, shape = RoundedCornerShape(13.dp)) {
        items.forEach { (label, icon, spec) ->
            val (destructive, action) = spec
            val color = if (destructive) PhrenTheme.systemRed else PhrenTheme.text
            DropdownMenuItem(
                text = { Text(label, style = IosType.body, color = color) },
                trailingIcon = { Icon(icon, null, tint = color, modifier = Modifier.size(18.dp)) },
                onClick = { onDismiss(); action() },
            )
        }
    }
}
