package com.phren.android.design

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.phren.android.R
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.util.UUID
import kotlin.math.abs
import kotlin.math.roundToInt

/** A theme's colors, as 0xRRGGBB (PhrenPalette in PhrenAppearance.swift). */
@Serializable
data class PhrenPalette(
    val background: Long, val sunken: Long, val surface: Long, val raised: Long,
    val chatCanvas: Long, val chatPanel: Long, val text: Long, val secondary: Long, val muted: Long, val dim: Long,
    val accent: Long, val hover: Long, val solid: Long, val action: Long, val navigation: Long,
    val toolPanel: Long? = null,
    val link: Long? = null,
    val sessionProject: Long? = null,
    val sessionTitle: Long? = null,
    val sessionMeta: Long? = null,
    val stateWorking: Long? = null,
    val stateWaiting: Long? = null,
    val stateDone: Long? = null,
    val phrenCardSurface: Long? = null,
    val phrenCardBorder: Long? = null,
    val phrenCardAccent: Long? = null,
    val chatInlineCode: Long? = null,
) {
    val resolvedPhrenCardAccent: Long get() = phrenCardAccent ?: action
    val resolvedPhrenCardSurface: Long get() = phrenCardSurface ?: blend(toolPanel ?: chatPanel, resolvedPhrenCardAccent, 0.08)
    val resolvedPhrenCardBorder: Long get() = phrenCardBorder ?: blend(resolvedPhrenCardSurface, resolvedPhrenCardAccent, 0.3)

    companion object {
        /** Blend with this theme's own panel, including light custom themes. */
        fun blend(base: Long, tint: Long, amount: Double): Long = listOf(16, 8, 0).fold(0L) { acc, shift ->
            val v = ((base shr shift) and 255) * (1 - amount) + ((tint shr shift) and 255) * amount
            acc or (v.roundToInt().toLong() shl shift)
        }
    }
}

/** The four built-in themes (PhrenAppearanceStyle). Saved IDs match iOS. */
enum class PhrenAppearanceStyle(val id: String) {
    CHARCOAL("midnight"), AMETHYST("amethyst"), GRAPHITE("graphite"), SLATE("slate");

    val title: String get() = if (this == CHARCOAL) "Charcoal" else id.replaceFirstChar { it.uppercase() }
    val detail: String
        get() = when (this) {
            CHARCOAL -> "Charcoal canvas. Crisp white text."
            AMETHYST -> "Deep violet. Soft lavender."
            GRAPHITE -> "Warm charcoal. Paper-white text."
            SLATE -> "Cool slate. Cyan and lavender."
        }

    val palette: PhrenPalette
        get() = when (this) {
            CHARCOAL -> PhrenPalette(
                0x1E1E1E, 0x141618, 0x282A2C, 0x3C3F42, 0x1E1E1E, 0x0E0E0E, 0xFFFFFF, 0xECEDEE, 0xA4A9B1, 0x999FA8,
                0xB994F4, 0xDCC5FF, 0x7450A7, 0xB994F4, 0xB994F4, toolPanel = 0x121416, link = 0xC2AAFF,
                sessionProject = 0xC2AAFF, sessionTitle = 0xECEDEE, sessionMeta = 0xA4A9B1,
                stateWorking = 0xB994F4, stateWaiting = 0xE0BC7F, stateDone = 0x8AC8AC,
            )
            AMETHYST -> PhrenPalette(
                0x17121F, 0x100C17, 0x251E32, 0x3A2E4D, 0x17121F, 0x100D17, 0xEEE3FF, 0xD8CAE9, 0xB8A6CE, 0xA491BA,
                0xB994F4, 0xDCC5FF, 0x7450A7, 0xC39AF9, 0xDCC5FF,
                sessionProject = 0xC39AF9, sessionTitle = 0xD8CAE9, sessionMeta = 0xB8A6CE,
                stateWorking = 0xC39AF9, stateWaiting = 0xE0BC7F, stateDone = 0x8AC8AC,
            )
            GRAPHITE -> PhrenPalette(
                0x202020, 0x181818, 0x2C2B2E, 0x424045, 0x202020, 0x151416, 0xF2EEF6, 0xDDD8E3, 0xBEB7C6, 0xA8A1B1,
                0xC0AAF2, 0xE0CCFF, 0x756096, 0xC0AAF2, 0xE4D9F3,
                sessionProject = 0xC0AAF2, sessionTitle = 0xDDD8E3, sessionMeta = 0xBEB7C6,
                stateWorking = 0xC0AAF2, stateWaiting = 0xE0BC7F, stateDone = 0x8AC8AC,
            )
            SLATE -> PhrenPalette(
                0x292D3C, 0x242837, 0x373D50, 0x48516A, 0x272832, 0x1C1E27, 0xF3F2F8, 0xDCDFEF, 0xBCC3D8, 0xABB3CA,
                0xB8AAF2, 0xD2C5FF, 0x71609E, 0x70DBE8, 0xE4E3F5,
                sessionProject = 0x70DBE8, sessionTitle = 0xDCDFEF, sessionMeta = 0xBCC3D8,
                stateWorking = 0x70DBE8, stateWaiting = 0xE0BC7F, stateDone = 0x8AC8AC,
            )
        }

    companion object {
        fun from(id: String?) = entries.firstOrNull { it.id == id }
    }
}

@Serializable
data class PhrenCustomTheme(val id: String = UUID.randomUUID().toString(), val name: String, val palette: PhrenPalette)

@Serializable
private data class CustomThemeCollection(val schemaVersion: Int = 2, val themes: List<PhrenCustomTheme>)

/**
 * The selected theme and saved custom themes (PhrenAppearance.swift).
 * Snapshot state, so every screen recolors the moment the choice changes.
 */
object PhrenAppearance {
    private const val STORAGE_KEY = "appearance.theme.v1"
    private const val CUSTOM_KEY = "appearance.custom-themes.v2"
    private const val RECOVERY_KEY = "appearance.custom-themes.recovery"
    private val json = Json { ignoreUnknownKeys = true }
    private var prefs: SharedPreferences? = null

    var selectedID by mutableStateOf(PhrenAppearanceStyle.CHARCOAL.id)
        private set
    val customThemes = mutableStateListOf<PhrenCustomTheme>()
    var storageIssue by mutableStateOf<String?>(null)
        private set

    fun install(context: Context) {
        val p = context.getSharedPreferences("phren", Context.MODE_PRIVATE)
        prefs = p
        p.getString(CUSTOM_KEY, null)?.let { raw ->
            try {
                val collection = json.decodeFromString(CustomThemeCollection.serializer(), raw)
                require(collection.schemaVersion == 2)
                require(collection.themes.map { it.id }.toSet().size == collection.themes.size)
                customThemes.clear(); customThemes += collection.themes
            } catch (_: Exception) {
                // Preserve the original bytes before any later edit replaces them.
                val backups = p.getStringSet(RECOVERY_KEY, emptySet())!!.toMutableSet()
                if (backups.add(raw)) p.edit().putStringSet(RECOVERY_KEY, backups).apply()
                storageIssue = "Saved custom themes couldn't be read. The original data is preserved for recovery; built-in themes are available."
            }
        }
        selectedID = p.getString(STORAGE_KEY, null) ?: PhrenAppearanceStyle.CHARCOAL.id
    }

    fun select(id: String) {
        selectedID = id
        prefs?.edit()?.putString(STORAGE_KEY, id)?.apply()
    }

    private fun persistCustom() {
        prefs?.edit()?.putString(CUSTOM_KEY, json.encodeToString(CustomThemeCollection.serializer(), CustomThemeCollection(themes = customThemes.toList())))?.apply()
    }

    fun save(theme: PhrenCustomTheme) {
        val index = customThemes.indexOfFirst { it.id == theme.id }
        if (index >= 0) customThemes[index] = theme else customThemes += theme
        persistCustom()
        select(theme.id)
    }

    fun remove(theme: PhrenCustomTheme) {
        if (selectedID == theme.id) select(PhrenAppearanceStyle.CHARCOAL.id)
        customThemes.removeAll { it.id == theme.id }
        persistCustom()
    }

    val palette: PhrenPalette
        get() = customThemes.firstOrNull { it.id == selectedID }?.palette ?: (PhrenAppearanceStyle.from(selectedID) ?: PhrenAppearanceStyle.CHARCOAL).palette

    val name: String
        get() = customThemes.firstOrNull { it.id == selectedID }?.name ?: (PhrenAppearanceStyle.from(selectedID) ?: PhrenAppearanceStyle.CHARCOAL).title

    @Suppress("unused")
    private val serializer = ListSerializer(PhrenCustomTheme.serializer())
}

fun hex(value: Long): Color = Color(0xFF000000 or (value and 0xFFFFFF))

/** Colors, spacing and radii (PhrenTheme.swift). Reads the live palette. */
object PhrenTheme {
    object Radius {
        val small = 10.dp
        val questionOption = 12.dp
        val medium = 14.dp
        val large = 18.dp
    }

    object Space {
        val xs = 4.dp
        val small = 8.dp
        val medium = 12.dp
        val large = 16.dp
        val section = 24.dp
    }

    private val p get() = PhrenAppearance.palette
    val bg get() = hex(p.background)
    val bgSunken get() = hex(p.sunken)
    val surface get() = hex(p.surface)
    val surfaceRaised get() = hex(p.raised)
    val chatCanvas get() = hex(p.chatCanvas)
    val chatPanel get() = hex(p.chatPanel)
    val toolPanel get() = hex(p.toolPanel ?: p.chatPanel)
    val phrenCardSurface get() = hex(p.resolvedPhrenCardSurface)
    val phrenCardBorder get() = hex(p.resolvedPhrenCardBorder)
    val phrenCardAccent get() = hex(p.resolvedPhrenCardAccent)
    val link get() = hex(p.link ?: p.action)
    val chatInlineCode get() = hex(p.chatInlineCode ?: chatPathHex(p))
    val text get() = hex(p.text)
    val textSecondary get() = hex(p.secondary)
    val textMuted get() = hex(p.muted)
    val textDim get() = hex(p.dim)
    val navigation get() = hex(p.navigation)
    val accent get() = hex(p.accent)
    val accentHover get() = hex(p.hover)
    val accentSolid get() = hex(p.solid)
    val cyan get() = hex(p.action)
    val sessionProject get() = hex(p.sessionProject ?: p.link ?: p.action)
    val sessionTitle get() = hex(p.sessionTitle ?: p.secondary)
    val sessionMeta get() = hex(p.sessionMeta ?: p.muted)
    val stateWorking get() = hex(p.stateWorking ?: p.action)
    val stateWaiting get() = hex(p.stateWaiting ?: 0xE0BC7F)
    val stateDone get() = hex(p.stateDone ?: 0x8AC8AC)
    val lavender get() = accent

    val onAccent = Color.White
    val border = Color.White.copy(alpha = 0.07f)
    val borderStrong = Color.White.copy(alpha = 0.14f)
    val cardNeedsBorder get() = similarValue(p.surface, p.background)
    val toolNeedsBorder get() = similarValue(p.toolPanel ?: p.chatPanel, p.chatCanvas)
    val panelNeedsBorder get() = similarValue(p.raised, p.background)

    private fun luminance(h: Long) = (((h shr 16) and 255) * 0.2126 + ((h shr 8) and 255) * 0.7152 + (h and 255) * 0.0722) / 255
    private fun similarValue(a: Long, b: Long) = abs(luminance(a) - luminance(b)) < 0.025
    private fun isLight(h: Long) = luminance(h) > 0.55

    val success = hex(0x8AC8AC)
    val warning = hex(0xE0BC7F)
    val danger = hex(0xEF9898)
    val chatText = Color.White
    val chatNeutral = hex(0xA9AEB6)
    val chatNeutralDim = hex(0x868B93)
    val chatUserBubble = Color.White.copy(alpha = 0.08f)

    fun chatPathHex(palette: PhrenPalette): Long = if (isLight(palette.chatCanvas)) 0x1C62A8 else 0x7FB6F0
    val chatPath get() = hex(chatPathHex(p))
    private fun adaptive(dark: Long, light: Long) = hex(if (isLight(p.chatCanvas)) light else dark)
    val chatBranch get() = adaptive(0xF0A06E, 0xA4501C)
    val chatRunning get() = adaptive(0xE8C07A, 0x8A5C00)
    val chatFinished get() = adaptive(0x8AC8AC, 0x2B7552)
    val chatNote get() = adaptive(0x8B9098, 0x6B7079)

    val green get() = success
    val amber get() = warning
    val red get() = danger
    val violet get() = accentSolid

    fun hostColor(hex: String?): Color {
        if (hex == null || !Regex("^#[0-9A-Fa-f]{6}$").matches(hex)) return textMuted
        return hex(hex.drop(1).toLong(16))
    }

    enum class ChipRole { HOST, PROJECT, STORE, TYPE, STATUS, SCOPE, GOOD, WARN, BAD }

    fun chipColor(role: ChipRole): Color = when (role) {
        ChipRole.HOST -> textSecondary
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
        typography = PhrenType.material,
        content = content,
    )
}

// Screen scaffolding modifiers (the View extensions in PhrenTheme.swift)

fun Modifier.phrenCard(radius: Dp = PhrenTheme.Radius.large): Modifier {
    val shape = RoundedCornerShape(radius)
    return this.background(PhrenTheme.surface, shape)
        .then(if (PhrenTheme.cardNeedsBorder) Modifier.border(0.5.dp, PhrenTheme.border, shape) else Modifier)
}

fun Modifier.phrenPanel(tool: Boolean = false, radius: Dp = PhrenTheme.Radius.medium): Modifier {
    val shape = RoundedCornerShape(radius)
    val needsBorder = if (tool) PhrenTheme.toolNeedsBorder else PhrenTheme.panelNeedsBorder
    val borderColor = PhrenTheme.border
    return this.clip(shape).background(if (tool) PhrenTheme.toolPanel else PhrenTheme.surfaceRaised, shape)
        .then(if (needsBorder) Modifier.border(0.5.dp, borderColor, shape) else Modifier)
        .then(if (!tool) Modifier.drawBehind {
            val inset = radius.toPx()
            drawLine(borderColor, Offset(inset, 0f), Offset(size.width - inset, 0f), strokeWidth = 0.5.dp.toPx())
        } else Modifier)
}

fun Modifier.phrenElevation(): Modifier =
    this.shadow(18.dp, RoundedCornerShape(PhrenTheme.Radius.medium), ambientColor = Color.Black.copy(alpha = 0.3f), spotColor = Color.Black.copy(alpha = 0.3f))

/** One rectangle per session, Moshi-style: a flat rounded fill, no border. */
fun Modifier.sessionCard(): Modifier = this.background(PhrenTheme.surface, RoundedCornerShape(PhrenTheme.Radius.medium))

/** The pixel-art phren, optionally bobbing like the site's animated poses. */
@Composable
fun PhrenMascot(size: Dp = 140.dp, bobbing: Boolean = true, glow: Boolean = true, modifier: Modifier = Modifier) {
    val offset = if (bobbing) {
        rememberInfiniteTransition(label = "bob").animateFloat(0f, -6f, infiniteRepeatable(tween(1400, easing = EaseInOut), RepeatMode.Reverse), label = "y").value
    } else 0f
    Box(modifier.size(size).offset(y = offset.dp), contentAlignment = Alignment.Center) {
        if (glow) {
            Box(Modifier.size(size * 0.8f).shadow(size / 6, RoundedCornerShape(50), ambientColor = PhrenTheme.cyan.copy(alpha = 0.25f), spotColor = PhrenTheme.cyan.copy(alpha = 0.25f)))
        }
        Image(ImageBitmap.imageResource(R.drawable.phren_mascot), null, filterQuality = FilterQuality.None, modifier = Modifier.size(size))
    }
}

/** Mascot-led empty state, with optional action buttons below. */
@Composable
fun PhrenEmptyState(title: String, message: String, modifier: Modifier = Modifier, actions: (@Composable () -> Unit)? = null) {
    Column(modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center) {
        PhrenMascot(76.dp, bobbing = false, glow = false, modifier = Modifier.alpha(0.8f))
        Spacer(Modifier.height(12.dp))
        Text(title, style = PhrenType.headline, color = PhrenTheme.text)
        Spacer(Modifier.height(12.dp))
        Text(message, style = PhrenType.footnote, color = PhrenTheme.textMuted, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 280.dp))
        if (actions != null) {
            Spacer(Modifier.height(20.dp))
            Column(horizontalAlignment = Alignment.CenterHorizontally) { actions() }
        }
    }
}
