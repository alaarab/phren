package com.phren.android.design

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.phren.android.design.PhrenType.bold
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/*
 * `Form` / `List(.insetGrouped)` and `List(.plain)` as iOS 26 draws them in
 * this app (PhrenForm, PhrenList): measured from the simulator. Grouped
 * sections are 16 in from the edges, radius 26, rows 52 tall, a hairline
 * separator that starts at the title, and a bold 17 header 17 in from the
 * card. Plain rows carry their own cards; `swipeActions` is PhrenSwipeRow.
 */

private val groupShape = RoundedCornerShape(26.dp)

/** A scrolling inset-grouped form on bg. */
@Composable
fun PhrenForm(modifier: Modifier = Modifier, bottomPadding: Dp = 100.dp, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxSize().background(PhrenTheme.bg).verticalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = bottomPadding),
        content = content,
    )
}

/** One grouped section: bold header, a rounded card of rows, optional footer. */
@Composable
fun FormSection(header: String? = null, footer: String? = null, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().padding(top = if (header != null) 14.dp else 18.dp, bottom = 8.dp)) {
        if (header != null) {
            Text(header, style = PhrenType.headline.bold(), color = PhrenTheme.text, modifier = Modifier.padding(start = 17.dp, bottom = 10.dp))
        }
        Column(Modifier.fillMaxWidth().clip(groupShape).background(PhrenTheme.surface, groupShape), content = content)
        if (footer != null) {
            Text(footer, style = PhrenType.footnote, color = PhrenTheme.textMuted, modifier = Modifier.padding(start = 17.dp, end = 17.dp, top = 7.dp))
        }
    }
}

/** The hairline between grouped rows, inset to the title. */
@Composable
fun FormDivider(inset: Dp = 50.dp) {
    Box(Modifier.fillMaxWidth().padding(start = inset, end = 16.dp).height(0.5.dp).background(PhrenTheme.borderStrong))
}

/** A grouped row: accent glyph, title, trailing value, chevron. */
@Composable
fun FormRow(
    title: String,
    icon: ImageVector? = null,
    value: String? = null,
    chevron: Boolean = true,
    titleColor: Color = PhrenTheme.text,
    iconTint: Color = PhrenTheme.accent,
    subtitle: String? = null,
    enabled: Boolean = true,
    identifier: String? = null,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp)
            .then(if (onClick != null) Modifier.plainClickable(enabled, onClick = onClick) else Modifier)
            .then(if (identifier != null) Modifier.phrenIdentifier(identifier) else Modifier)
            .padding(start = if (icon != null) 14.dp else 16.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Box(Modifier.width(24.dp), contentAlignment = Alignment.Center) { Icon(icon, null, tint = iconTint, modifier = Modifier.size(22.dp)) }
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = PhrenType.body, color = if (enabled) titleColor else PhrenTheme.textDim, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = PhrenType.footnote, color = PhrenTheme.textMuted)
        }
        if (value != null) {
            Spacer(Modifier.width(8.dp))
            Text(value, style = PhrenType.body, color = PhrenTheme.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
        }
        trailing?.invoke(this)
        if (chevron && onClick != null) {
            Spacer(Modifier.width(10.dp))
            Icon(SF("chevron.right"), null, tint = PhrenTheme.textDim, modifier = Modifier.size(15.dp))
        }
    }
}

/** Rows joined by inset hairlines. */
@Composable
fun FormRows(count: Int, inset: Dp = 50.dp, row: @Composable (Int) -> Unit) {
    for (i in 0 until count) {
        if (i > 0) FormDivider(inset)
        row(i)
    }
}

// Plain lists

/** `List(.plain)` on bg, with pull-to-refresh room for the floating tab bar. */
@Composable
fun PhrenPlainList(modifier: Modifier = Modifier, bottomPadding: Dp = 110.dp, content: LazyListScope.() -> Unit) {
    LazyColumn(modifier.fillMaxSize().background(PhrenTheme.bg), contentPadding = PaddingValues(bottom = bottomPadding)) {
        // A fixed first row keeps the list pinned to its top when rows are
        // inserted above the first visible key (a new day's finding), as a
        // UITableView does; otherwise the new row lands above the viewport.
        item(key = "phren-list-top") { Spacer(Modifier.height(1.dp)) }
        content()
    }
}

/**
 * A plain list's section label row (plainListSectionLabel): the row keeps
 * the list's surface cell behind it, full width, with a hairline under it.
 */
@Composable
fun PlainSectionLabel(text: String, modifier: Modifier = Modifier, trailing: (@Composable RowScope.() -> Unit)? = null) {
    Column(modifier.fillMaxWidth().background(PhrenTheme.surface)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text.uppercase(), style = PhrenType.sectionLabel, color = PhrenTheme.textMuted, modifier = Modifier.weight(1f))
            trailing?.invoke(this)
        }
        Box(Modifier.fillMaxWidth().padding(start = 14.dp).height(0.5.dp).background(PhrenTheme.borderStrong))
    }
}

/** One card in a plain list (sessionCard + separatedSessionRow): 14 margins, 4 apart. */
fun Modifier.separatedCard(): Modifier = this.padding(horizontal = 14.dp, vertical = 4.dp).fillMaxWidth()

data class SwipeAction(val title: String, val icon: ImageVector, val tint: Color, val destructive: Boolean = false, val action: () -> Unit)

/**
 * `swipeActions`: drag the row to reveal its buttons; a full swipe runs the
 * first one. Rows with no actions in a direction leave that drag alone, so
 * the screen's own Back pan still works.
 */
@Composable
fun PhrenSwipeRow(
    trailing: List<SwipeAction> = emptyList(),
    leading: List<SwipeAction> = emptyList(),
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    if (trailing.isEmpty() && leading.isEmpty()) { Box(modifier) { content() }; return }
    val density = LocalDensity.current
    val button = with(density) { 74.dp.toPx() }
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var width = remember { floatArrayOf(0f) }
    fun settle(to: Float) = scope.launch { offset.animateTo(to, tween(220)) }
    Box(modifier.onSizeChanged { width[0] = it.width.toFloat() }) {
        Row(Modifier.matchParentSize()) {
            if (offset.value > 0) Row(Modifier.fillMaxHeight()) { leading.forEach { SwipeButton(it) { settle(0f); it.action() } } }
            Spacer(Modifier.weight(1f))
            if (offset.value < 0) Row(Modifier.fillMaxHeight()) { trailing.reversed().forEach { SwipeButton(it) { settle(0f); it.action() } } }
        }
        Box(
            Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }
                .pointerInput(trailing.size, leading.size) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            val v = offset.value
                            when {
                                v < -width[0] * 0.6f && trailing.isNotEmpty() -> { settle(0f); trailing.first().action() }
                                v > width[0] * 0.6f && leading.isNotEmpty() -> { settle(0f); leading.first().action() }
                                v < -button * 0.5f -> settle(-button * trailing.size)
                                v > button * 0.5f -> settle(button * leading.size)
                                else -> settle(0f)
                            }
                        },
                    ) { change, amount ->
                        val next = offset.value + amount
                        val allowed = (next <= 0 && trailing.isNotEmpty()) || (next >= 0 && leading.isNotEmpty())
                        if (allowed) { change.consume(); scope.launch { offset.snapTo(next) } }
                    }
                },
        ) { content() }
    }
}

@Composable
private fun SwipeButton(action: SwipeAction, onClick: () -> Unit) {
    Column(
        Modifier.width(74.dp).fillMaxHeight().padding(vertical = 4.dp, horizontal = 3.dp)
            .clip(RoundedCornerShape(PhrenTheme.Radius.medium)).background(action.tint).plainClickable(onClick = onClick)
            .phrenIdentifier(action.title),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Icon(action.icon, action.title, tint = Color.White, modifier = Modifier.size(20.dp))
        Text(action.title, style = PhrenType.caption.copy(color = Color.White))
    }
}
