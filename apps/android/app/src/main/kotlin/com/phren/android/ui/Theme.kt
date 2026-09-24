package com.phren.android.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.EaseInOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.phren.android.R
import kotlinx.coroutines.delay

/**
 * The phren visual identity (port of PhrenTheme.swift): the web UI's
 * deep-void theme plus the site's cyan highlights. Dark-only.
 */
object PhrenTheme {
    // Surfaces — deep-void.ts:19-23
    val bg = Color(0xFF0A0A1A)
    val bgSunken = Color(0xFF0D0D22)
    val surface = Color(0xFF12122A)
    val surfaceRaised = Color(0xFF1A1A3E)

    // Ink — deep-void.ts:25-27
    val text = Color(0xFFECE9F5)
    val textSecondary = Color(0xFFC8C3E3)
    val textMuted = Color(0xFFECE9F5).copy(alpha = 0.55f)
    val textDim = Color(0xFF7A7570)

    // Accents
    val accent = Color(0xFF9058F0)
    val accentHover = Color(0xFFB07AFF)
    val accentSolid = Color(0xFF7C3AED)
    val cyan = Color(0xFF28D3F2)
    val lavender = Color(0xFF9B8DC8)

    // Borders (lavender-tinted)
    val border = Color(0xFF9C8FF8).copy(alpha = 0.18f)
    val borderStrong = Color(0xFF9C8FF8).copy(alpha = 0.32f)

    // Status
    val success = Color(0xFF4ADE80)
    val warning = Color(0xFFFBBF24)
    val danger = Color(0xFFF87171)
    val green = success
    val amber = warning
    val red = danger
    val violet = Color(0xFF7C3AED)

    /** iOS system colors the SwiftUI views use directly. */
    val systemBlue = Color(0xFF0A84FF)
    val systemGreen = Color(0xFF30D158)
    val systemOrange = Color(0xFFFF9F0A)
    val systemRed = Color(0xFFFF453A)
    val systemGray = Color(0xFF8E8E93)
    /** `.secondary` / `.tertiary` foreground styles on a dark background. */
    val secondaryLabel = Color(0xFFEBEBF5).copy(alpha = 0.6f)
    val tertiaryLabel = Color(0xFFEBEBF5).copy(alpha = 0.3f)
    val separator = Color(0xFF545458).copy(alpha = 0.6f)

    enum class ChipRole { PROJECT, STORE, TYPE, STATUS, SCOPE, GOOD, WARN, BAD }

    fun chipColor(role: ChipRole): Color = when (role) {
        ChipRole.PROJECT -> cyan
        ChipRole.STORE -> lavender
        ChipRole.TYPE -> accent
        ChipRole.STATUS -> warning
        ChipRole.SCOPE -> accentHover
        ChipRole.GOOD -> success
        ChipRole.WARN -> warning
        ChipRole.BAD -> danger
    }
}

/** iOS Dynamic Type sizes (default content size category). */
object IosType {
    val largeTitle = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.Bold, lineHeight = 41.sp, letterSpacing = 0.4.sp)
    val title = TextStyle(fontSize = 28.sp, fontWeight = FontWeight.Bold, lineHeight = 34.sp)
    val title2 = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold, lineHeight = 28.sp)
    val title3 = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, lineHeight = 25.sp)
    val headline = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp)
    val body = TextStyle(fontSize = 17.sp, lineHeight = 22.sp)
    val callout = TextStyle(fontSize = 16.sp, lineHeight = 21.sp)
    val subheadline = TextStyle(fontSize = 15.sp, lineHeight = 20.sp)
    val footnote = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp)
    val caption2 = TextStyle(fontSize = 11.sp, lineHeight = 13.sp)

    fun TextStyle.mono(): TextStyle = copy(fontFamily = FontFamily.Monospace)
    fun TextStyle.semibold(): TextStyle = copy(fontWeight = FontWeight.SemiBold)
    fun TextStyle.bold(): TextStyle = copy(fontWeight = FontWeight.Bold)
}

@Composable
fun PhrenMaterialTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = PhrenTheme.accent,
            onPrimary = Color.White,
            secondary = PhrenTheme.cyan,
            background = PhrenTheme.bg,
            onBackground = PhrenTheme.text,
            surface = PhrenTheme.surface,
            onSurface = PhrenTheme.text,
            surfaceVariant = PhrenTheme.surfaceRaised,
            onSurfaceVariant = PhrenTheme.textSecondary,
            surfaceContainer = PhrenTheme.surface,
            surfaceContainerHigh = PhrenTheme.surfaceRaised,
            surfaceContainerHighest = PhrenTheme.surfaceRaised,
            outline = PhrenTheme.borderStrong,
            error = PhrenTheme.danger,
        ),
        content = content,
    )
}

/** Web-UI card: solid navy surface, lavender border, soft violet shadow. */
fun Modifier.phrenCard(radius: Dp = 6.dp): Modifier = this
    .shadow(10.dp, RoundedCornerShape(radius), ambientColor = PhrenTheme.accentSolid.copy(alpha = 0.18f), spotColor = PhrenTheme.accentSolid.copy(alpha = 0.18f))
    .background(PhrenTheme.surface, RoundedCornerShape(radius))
    .border(1.dp, PhrenTheme.border, RoundedCornerShape(radius))

/** The pixel-art phren, optionally bobbing like the site's animated poses. */
@Composable
fun PhrenMascot(size: Dp = 140.dp, bobbing: Boolean = true, glow: Boolean = true, modifier: Modifier = Modifier) {
    val offset = if (bobbing) {
        val transition = rememberInfiniteTransition(label = "bob")
        transition.animateFloat(0f, -6f, infiniteRepeatable(tween(1400, easing = EaseInOut), RepeatMode.Reverse), label = "bobY").value
    } else 0f
    Box(modifier.size(size).offset(y = offset.dp), contentAlignment = Alignment.Center) {
        if (glow) {
            Box(
                Modifier.size(size * 0.8f)
                    .shadow(size / 6, RoundedCornerShape(50), ambientColor = PhrenTheme.cyan.copy(alpha = 0.25f), spotColor = PhrenTheme.cyan.copy(alpha = 0.25f)),
            )
        }
        Image(
            ImageBitmap.imageResource(R.drawable.phren_mascot),
            contentDescription = null,
            filterQuality = FilterQuality.None,
            modifier = Modifier.size(size),
        )
    }
}

/**
 * The site's tilted white "finding card" with a typewriter line — the cute
 * signature moment on the sign-in screen.
 */
@Composable
fun TypewriterFindingCard() {
    val lines = remember {
        listOf(
            "[pattern] always validate JWT expiry before refresh",
            "[decision] chose FTS5 over embeddings for v1 search",
            "[pitfall] session hooks fire twice in mixed mode",
            "[architecture] git is the sync layer — no server",
        )
    }
    var lineIndex by remember { mutableIntStateOf(0) }
    var visible by remember { mutableIntStateOf(0) }
    var caretOn by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(55)
            val line = lines[lineIndex]
            visible++
            if (visible > line.length + 24) {
                visible = 0
                lineIndex = (lineIndex + 1) % lines.size
            }
        }
    }
    LaunchedEffect(Unit) {
        while (true) { delay(700); caretOn = !caretOn }
    }
    val ink = Color(0xFF12122A)
    Box(Modifier.rotate(-1.2f)) {
        Column(
            Modifier.width(260.dp)
                // The site's hard offset shadow (box-shadow: 4px 4px 0)
                .drawBehind {
                    val o = 4.dp.toPx()
                    drawRoundRect(Color.Black.copy(alpha = 0.35f), topLeft = Offset(o, o), size = size, cornerRadius = CornerRadius(3.dp.toPx()))
                }
                .background(Color.White, RoundedCornerShape(3.dp))
                .border(1.dp, ink, RoundedCornerShape(3.dp))
                .padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 12.dp),
        ) {
            Text("FINDING", style = TextStyle(fontSize = 9.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp), color = PhrenTheme.accentSolid)
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    lines[lineIndex].take(visible),
                    style = TextStyle(fontSize = 11.sp, fontFamily = FontFamily.Monospace),
                    color = ink, maxLines = 1, overflow = TextOverflow.Clip,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Box(Modifier.width(2.dp).height(12.dp).background(if (caretOn) ink else Color.Transparent))
            }
            Spacer(Modifier.height(6.dp))
            Text("~/.phren · synced", style = TextStyle(fontSize = 9.sp, fontFamily = FontFamily.Monospace, letterSpacing = 1.sp), color = Color(0xFF5A4A7A))
        }
    }
}

/** Mascot-led empty state (PhrenEmptyState.swift). */
@Composable
fun PhrenEmptyState(title: String, message: String, modifier: Modifier = Modifier) {
    Column(modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        PhrenMascot(size = 76.dp, bobbing = false, glow = false, modifier = Modifier.alpha(0.8f))
        Spacer(Modifier.height(12.dp))
        Text(title, style = IosType.headline.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.text)
        Spacer(Modifier.height(12.dp))
        Text(message, style = IosType.footnote, color = PhrenTheme.textMuted, textAlign = TextAlign.Center, modifier = Modifier.width(280.dp))
    }
}

val ZeroPadding = PaddingValues(0.dp)
