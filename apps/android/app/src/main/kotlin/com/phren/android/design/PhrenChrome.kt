package com.phren.android.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PhrenType.mono
import com.phren.android.design.PhrenType.semibold

/*
 * PhrenChrome.swift plus the navigation chrome UIKit draws on iOS 26: the
 * opaque bar with an inline title, glass circle and capsule toolbar items,
 * and the floating capsule tab bar. Colors and sizes are measured from the
 * running iOS app (Charcoal): 32pt glass circles, a 44pt #3C3C3C toolbar
 * capsule with #626568 item circles, and a 62pt floating tab capsule inset
 * 26pt whose selected item is a darker pill.
 */

object Glass {
    /** The toolbar capsule and tab bar: bg lifted ~12% toward white. */
    val capsule get() = PhrenPalette.blend(PhrenAppearance.palette.background, 0xFFFFFF, 0.12).let(::hex)
    /** A glass circle inside a capsule. */
    val item get() = PhrenPalette.blend(PhrenAppearance.palette.background, 0xFFFFFF, 0.30).let(::hex)
    /** A standalone glass circle (back button): barely lifted. */
    val circle get() = PhrenPalette.blend(PhrenAppearance.palette.background, 0xFFFFFF, 0.03).let(::hex)
    /** The selected tab's pill: slightly darker than the bar. */
    val selectedTab get() = PhrenPalette.blend(PhrenAppearance.palette.background, 0xFFFFFF, 0.02).let(::hex)
}

/** A toolbar item: glyph (accent) or text, with its spoken label. */
data class ToolbarItem(
    val icon: ImageVector? = null,
    val text: String? = null,
    val label: String,
    val enabled: Boolean = true,
    val tint: Color? = null,
    val bold: Boolean = false,
    val identifier: String? = null,
    /** A PhrenIconButton in the bar: accent glyph on a raised circle. */
    val raised: Boolean = false,
    val onClick: () -> Unit,
)

@Composable
private fun GlassItem(item: ToolbarItem, inCapsule: Boolean) {
    // iOS 26 glass bar items draw in the label color; only raised icon buttons carry the accent.
    val base = item.tint ?: if (item.raised) PhrenTheme.accent else PhrenTheme.text
    val tint = base
    Box(
        Modifier.height(44.dp).widthIn(min = if (inCapsule && item.raised) 58.dp else 44.dp)
            .then(if (!inCapsule) Modifier.background(Glass.capsule, CircleShape) else Modifier)
            .clip(CircleShape)
            .plainClickable(item.enabled, onClick = item.onClick)
            .semantics { contentDescription = item.label }
            .then(if (item.identifier != null) Modifier.phrenIdentifier(item.identifier) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        if (item.icon != null) {
            if (item.raised) {
                Box(Modifier.size(32.dp).background(Glass.item, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(item.icon, null, tint = tint, modifier = Modifier.size(19.dp))
                }
            } else Icon(item.icon, null, tint = tint, modifier = Modifier.size(22.dp))
        } else {
            Text(item.text ?: "", style = if (item.bold) PhrenType.body.semibold() else PhrenType.body, color = tint, modifier = Modifier.padding(horizontal = 14.dp))
        }
    }
}

/** Several toolbar items share one glass capsule; a single glyph is a circle. */
@Composable
fun ToolbarGroup(items: List<ToolbarItem>) {
    if (items.isEmpty()) return
    if (items.size == 1 && items[0].icon != null) { GlassItem(items[0], inCapsule = false); return }
    Row(
        Modifier.height(44.dp).background(Glass.capsule, CircleShape).clip(CircleShape),
        verticalAlignment = Alignment.CenterVertically,
    ) { items.forEach { GlassItem(it, inCapsule = true) } }
}

/**
 * The opaque navigation bar: status-bar inset + 44dp. A root screen's title
 * sits at the leading edge; a pushed screen's is centered between the back
 * button and the trailing items.
 */
@Composable
fun PhrenNavBar(
    title: String,
    onBack: (() -> Unit)? = null,
    leading: List<ToolbarItem> = emptyList(),
    trailing: List<ToolbarItem> = emptyList(),
    titleContent: (@Composable () -> Unit)? = null,
    inSheet: Boolean = false,
    background: Color = PhrenTheme.bg,
) {
    Box(Modifier.fillMaxWidth().background(background).then(if (inSheet) Modifier.padding(top = 16.dp) else Modifier.windowInsetsPadding(WindowInsets.statusBars)).height(44.dp)) {
        // iOS 26 centres an inline title unless a wide trailing group leaves
        // no room for it; then it sits at the leading edge (Projects, Memory).
        val centered = onBack != null || leading.isNotEmpty() || trailing.size < 2
        Row(Modifier.align(Alignment.CenterStart).padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (onBack != null) GlassItem(ToolbarItem(icon = SF("chevron.left"), label = "Back", identifier = "BackButton", onClick = onBack), inCapsule = false)
            if (leading.isNotEmpty()) ToolbarGroup(leading)
            if (!centered) {
                if (titleContent != null) titleContent()
                else Text(title, style = PhrenType.headline, color = PhrenTheme.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 3.dp))
            }
        }
        if (centered) {
            Box(Modifier.align(Alignment.Center).padding(horizontal = 104.dp)) {
                if (titleContent != null) titleContent()
                else Text(title, style = PhrenType.headline, color = PhrenTheme.text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            }
        }
        Row(Modifier.align(Alignment.CenterEnd).padding(end = 16.dp), verticalAlignment = Alignment.CenterVertically) { ToolbarGroup(trailing) }
    }
}

/** A screen: nav bar over content filling the rest, on bg. */
@Composable
fun PhrenNavScreen(
    title: String,
    onBack: (() -> Unit)? = null,
    leading: List<ToolbarItem> = emptyList(),
    trailing: List<ToolbarItem> = emptyList(),
    titleContent: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().background(PhrenTheme.bg)) {
        PhrenNavBar(title, onBack, leading, trailing, titleContent)
        content()
    }
}

/** The floating tab bar's height plus its gap: content that must stay clear of it (the tab bar's safe area). */
val TabBarClearance = 62.dp + 8.dp + 8.dp

@Composable
fun Modifier.tabBarSafeArea(): Modifier = this.windowInsetsPadding(WindowInsets.navigationBars).padding(bottom = TabBarClearance)

data class PhrenTab<T>(val tab: T, val label: String, val icon: ImageVector, val badge: Int = 0, val identifier: String? = null)

/** The floating capsule tab bar (iOS 26 TabView). */
@Composable
fun <T> PhrenTabBar(items: List<PhrenTab<T>>, selected: T, onSelect: (T) -> Unit) {
    Box(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(start = 26.dp, end = 26.dp, bottom = 8.dp)) {
        Row(
            Modifier.fillMaxWidth().height(62.dp)
                .shadow(16.dp, CircleShape, ambientColor = Color.Black.copy(alpha = 0.35f), spotColor = Color.Black.copy(alpha = 0.35f))
                .background(Glass.capsule, CircleShape).clip(CircleShape).padding(4.dp),
        ) {
            items.forEach { item ->
                val active = item.tab == selected
                val tint = PhrenTheme.text
                Column(
                    Modifier.weight(1f).fillMaxHeight().clip(CircleShape)
                        .background(if (active) Glass.selectedTab else Color.Transparent, CircleShape)
                        .plainClickable { onSelect(item.tab) }
                        .semantics { contentDescription = item.label }
                        .then(if (item.identifier != null) Modifier.phrenIdentifier(item.identifier) else Modifier),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
                ) {
                    Box {
                        Icon(item.icon, null, tint = tint, modifier = Modifier.size(26.dp))
                        if (item.badge > 0) {
                            Box(
                                Modifier.align(Alignment.TopEnd).padding(start = 18.dp).heightIn(min = 16.dp).widthIn(min = 16.dp)
                                    .background(Color(0xFFFF453A), CircleShape).padding(horizontal = 4.dp),
                                contentAlignment = Alignment.Center,
                            ) { Text(if (item.badge > 99) "99+" else "${item.badge}", style = PhrenType.caption2.medium(), color = Color.White) }
                        }
                    }
                    Spacer(Modifier.height(1.dp))
                    Text(item.label, style = PhrenType.caption2.medium().copy(fontSize = PhrenType.caption2.fontSize * 0.95f), color = tint, maxLines = 1)
                }
            }
        }
    }
}

// PhrenChrome.swift pieces

@Composable
fun PhrenSectionHeader(title: String, count: Int? = null, trailing: String? = null, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(top = PhrenTheme.Space.small), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
        Text(title.uppercase(), style = PhrenType.sectionLabel, color = PhrenTheme.textMuted)
        if (count != null) PhrenCountBadge(count)
        Spacer(Modifier.weight(1f))
        if (trailing != null) Text(trailing, style = PhrenType.caption2, color = PhrenTheme.textDim)
    }
}

@Composable
fun PhrenCountBadge(count: Int) {
    Text("$count", style = PhrenType.caption2.semibold(), color = PhrenTheme.textSecondary,
        modifier = Modifier.background(PhrenTheme.surfaceRaised, CircleShape).padding(horizontal = 7.dp, vertical = 1.dp))
}

@Composable
fun PhrenNoticeBanner(title: String, message: String, icon: ImageVector = SF("checkmark.circle.fill"), tint: Color = PhrenTheme.success, identifier: String = "phren-notice", modifier: Modifier = Modifier, dismiss: () -> Unit) {
    Row(
        modifier.fillMaxWidth().phrenElevation().phrenPanel().padding(horizontal = PhrenTheme.Space.medium, vertical = PhrenTheme.Space.small).phrenIdentifier(identifier),
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small),
    ) {
        Box(Modifier.width(22.dp).heightIn(min = 44.dp), contentAlignment = Alignment.Center) { Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp)) }
        Column(Modifier.weight(1f).heightIn(min = 44.dp), verticalArrangement = Arrangement.spacedBy(PhrenTheme.Space.xs, Alignment.CenterVertically)) {
            Text(title, style = PhrenType.subheadline.semibold(), color = PhrenTheme.text)
            Text(message, style = PhrenType.footnote, color = PhrenTheme.textSecondary)
        }
        PhrenIconButton(SF("xmark"), "Dismiss $title", modifier = Modifier.phrenIdentifier("$identifier-dismiss"), action = dismiss)
    }
}

data class IconSegmentItem<V>(val value: V, val icon: ImageVector, val label: String)

@Composable
fun <V> PhrenIconSegment(items: List<IconSegmentItem<V>>, selection: V, onSelect: (V) -> Unit, tint: Color = PhrenTheme.accent, identifier: ((V) -> String)? = null) {
    Row(Modifier.background(PhrenTheme.surface, CircleShape).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        items.forEach { item ->
            val sel = item.value == selection
            Box(
                Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp).clip(CircleShape).background(if (sel) tint.copy(alpha = 0.16f) else Color.Transparent, CircleShape)
                    .plainClickable { onSelect(item.value) }.semantics { contentDescription = item.label }
                    .phrenIdentifier(identifier?.invoke(item.value) ?: item.label),
                contentAlignment = Alignment.Center,
            ) { Icon(item.icon, null, tint = if (sel) tint else PhrenTheme.textMuted, modifier = Modifier.size(18.dp)) }
        }
    }
}

/** A tinted capsule label (PhrenChip). */
@Composable
fun PhrenChip(text: String, role: PhrenTheme.ChipRole = PhrenTheme.ChipRole.TYPE, color: Color? = null, icon: ImageVector? = null, monospaced: Boolean = false, modifier: Modifier = Modifier) {
    val c = color ?: PhrenTheme.chipColor(role)
    Row(modifier.background(c.copy(alpha = 0.14f), CircleShape).padding(horizontal = 7.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) { Icon(icon, null, tint = c, modifier = Modifier.size(10.dp)); Spacer(Modifier.width(4.dp)) }
        Text(text, style = (if (monospaced) PhrenType.caption2.mono() else PhrenType.caption2).medium(), color = c, maxLines = 1)
    }
}

@Composable
fun PhrenStatLabel(added: Int? = null, removed: Int? = null, text: String? = null) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        val style = PhrenType.monoCaption.medium()
        if (text != null) Text(text, style = style, color = PhrenTheme.textMuted)
        if (added != null && added > 0) Text("+$added", style = style, color = PhrenTheme.success)
        if (removed != null && removed > 0) Text("-$removed", style = style, color = PhrenTheme.danger)
    }
}

@Composable
fun PhrenMetadataHeader(title: String, subtitle: String? = null, chips: (@Composable () -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small)) {
            Text(title, style = PhrenType.title3, color = PhrenTheme.text, maxLines = 2, modifier = Modifier.weight(1f))
            trailing?.invoke()
        }
        if (subtitle != null) Text(subtitle, style = PhrenType.caption, color = PhrenTheme.textMuted, maxLines = 1)
        chips?.invoke()
    }
}

@Composable
fun PhrenIconRow(icon: ImageVector, title: String, iconColor: Color = PhrenTheme.textSecondary, subtitle: String? = null, mono: Boolean = false, selected: Boolean = false, modifier: Modifier = Modifier, trailing: (@Composable RowScope.() -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().background(if (selected) PhrenTheme.accent.copy(alpha = 0.16f) else PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.small))
            .padding(horizontal = PhrenTheme.Space.medium, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.small),
    ) {
        Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) { Icon(icon, null, tint = iconColor, modifier = Modifier.size(16.dp)) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = (if (mono) PhrenType.subheadline.mono() else PhrenType.subheadline).medium(), color = PhrenTheme.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = PhrenType.caption2, color = PhrenTheme.textMuted, maxLines = 1)
        }
        trailing?.invoke(this)
    }
}

object PhrenFileType {
    fun info(path: String): Pair<ImageVector, Color> = when (path.substringAfterLast('.', "").lowercase()) {
        "md", "markdown" -> SF("doc.richtext") to PhrenTheme.cyan
        "swift" -> SF("swift") to hex(0xF05138)
        "json" -> SF("curlybraces") to hex(0xE0BC7F)
        "yaml", "yml" -> SF("list.bullet.indent") to PhrenTheme.lavender
        "toml", "ini", "cfg", "conf" -> SF("gearshape") to PhrenTheme.textMuted
        "sh", "bash", "zsh", "fish" -> SF("terminal") to PhrenTheme.success
        "ts", "tsx", "js", "jsx", "mjs", "cjs" -> SF("chevron.left.forwardslash.chevron.right") to hex(0xE0BC7F)
        "py" -> SF("chevron.left.forwardslash.chevron.right") to hex(0x5A9FD4)
        "rs" -> SF("gearshape.2") to hex(0xE0A07F)
        "go" -> SF("chevron.left.forwardslash.chevron.right") to hex(0x6FD6E0)
        "rb" -> SF("diamond") to hex(0xE07070)
        "html", "htm", "css", "scss" -> SF("chevron.left.forwardslash.chevron.right") to hex(0xE08A5A)
        "sql" -> SF("cylinder") to PhrenTheme.lavender
        "png", "jpg", "jpeg", "gif", "webp", "heic", "svg" -> SF("photo") to hex(0xE08AB0)
        else -> SF("doc") to PhrenTheme.textMuted
    }
}

@Composable
fun PhrenFileTypeIcon(path: String, folder: Boolean = false, size: Int = 15) {
    val (icon, color) = if (folder) SF("folder.fill") to PhrenTheme.lavender else PhrenFileType.info(path)
    Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) { Icon(icon, null, tint = color, modifier = Modifier.size(size.dp)) }
}

@Composable
fun PhrenTimelineRail(color: Color = PhrenTheme.accent, top: Boolean = true, bottom: Boolean = true, modifier: Modifier = Modifier) {
    Column(modifier.width(12.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.width(1.5.dp).weight(1f).background(if (top) color.copy(alpha = 0.5f) else Color.Transparent))
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Box(Modifier.width(1.5.dp).weight(1f).background(if (bottom) color.copy(alpha = 0.5f) else Color.Transparent))
    }
}

@Composable
fun PhrenRail(color: Color, modifier: Modifier = Modifier) = Box(modifier.width(3.dp).fillMaxHeight().background(color, CircleShape))

/** A lazily built scrolling screen: 16 horizontal, 12 vertical, 8 between (PhrenScrollScreen). */
@Composable
fun PhrenScrollScreen(spacing: androidx.compose.ui.unit.Dp = PhrenTheme.Space.small, modifier: Modifier = Modifier, content: LazyListScope.() -> Unit) {
    LazyColumn(
        modifier.fillMaxSize().background(PhrenTheme.bg),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = PhrenTheme.Space.large, vertical = PhrenTheme.Space.medium),
        verticalArrangement = Arrangement.spacedBy(spacing),
        content = content,
    )
}

/** A sheet's header: Cancel · title · Done/Save (PhrenSheetHeader). */
@Composable
fun PhrenSheetHeader(title: String, trailingTitle: String = "Done", canSave: Boolean = true, identifierPrefix: String? = null, cancel: (() -> Unit)? = null, save: () -> Unit) {
    Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = PhrenTheme.Space.large)) {
        Text(title, style = PhrenType.subheadline.semibold(), color = PhrenTheme.text, maxLines = 1, modifier = Modifier.align(Alignment.Center).padding(horizontal = 80.dp))
        if (cancel != null) {
            Box(Modifier.align(Alignment.CenterStart).heightIn(min = 44.dp).widthIn(min = 44.dp).plainClickable(onClick = cancel).phrenIdentifier(identifierPrefix?.let { "$it-cancel" } ?: "sheet-cancel"), contentAlignment = Alignment.CenterStart) {
                Text("Cancel", style = PhrenType.body, color = PhrenTheme.accentSolid)
            }
        }
        Box(Modifier.align(Alignment.CenterEnd).heightIn(min = 44.dp).widthIn(min = 44.dp).plainClickable(canSave, onClick = save).phrenIdentifier(identifierPrefix?.let { "$it-save" } ?: "sheet-done"), contentAlignment = Alignment.CenterEnd) {
            Text(trailingTitle, style = PhrenType.body, color = if (canSave) PhrenTheme.accentSolid else PhrenTheme.textDim)
        }
    }
}

data class PhrenMenuItem(val id: String, val title: String, val icon: ImageVector, val isEnabled: Boolean = true, val action: () -> Unit)

/** The anchored menu card (PhrenMenuCard): 240 wide, 44pt rows. */
@Composable
fun PhrenMenuCard(items: List<PhrenMenuItem>, identifier: String, width: androidx.compose.ui.unit.Dp = 240.dp, dismiss: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Column(Modifier.width(width).shadow(12.dp, shape).background(PhrenTheme.surfaceRaised, shape).border(0.5.dp, PhrenTheme.border, shape).clip(shape).phrenIdentifier(identifier)) {
        items.forEachIndexed { i, item ->
            if (i > 0) Box(Modifier.fillMaxWidth().height(0.5.dp).background(PhrenTheme.border))
            Row(
                Modifier.fillMaxWidth().height(44.dp).alpha(if (item.isEnabled) 1f else 0.4f).plainClickable(item.isEnabled) { dismiss(); item.action() }
                    .phrenIdentifier("$identifier:${item.id}").padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(Modifier.width(24.dp), contentAlignment = Alignment.Center) { Icon(item.icon, null, tint = PhrenTheme.textMuted, modifier = Modifier.size(19.dp)) }
                Text(item.title, style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
            }
        }
    }
}

/** A settings/menu row with a tinted icon tile (PhrenMenuRow). */
@Composable
fun PhrenMenuRow(title: String, icon: ImageVector, subtitle: String? = null, color: Color = PhrenTheme.textSecondary, titleColor: Color = PhrenTheme.text, compact: Boolean = false) {
    Row(Modifier.padding(vertical = if (compact) 2.dp else 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PhrenTheme.Space.medium)) {
        Box(Modifier.size(40.dp).background(color.copy(alpha = 0.08f), RoundedCornerShape(PhrenTheme.Radius.small)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = color, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = PhrenType.body.medium(), color = titleColor)
            if (subtitle != null) Text(subtitle, style = PhrenType.caption, color = PhrenTheme.textMuted)
        }
    }
}

/** Card row in a plain list (plainListCardRow): 14 margins, 3 between, radius 14. */
fun Modifier.plainListCardRow(): Modifier = this.padding(horizontal = 14.dp, vertical = 3.dp).fillMaxWidth()
    .background(PhrenTheme.surface, RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 8.dp)

@Suppress("unused")
private fun keep(scope: BoxScope, i: IntrinsicSize) = Unit
