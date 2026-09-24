package com.phren.android.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateUtils
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider as FixedColor
import com.phren.android.AppModel
import com.phren.android.MainActivity
import com.phren.kit.PhrenTask
import com.phren.kit.atomicWrite
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.time.Instant
import kotlinx.coroutines.launch

/**
 * What the widget renders (WidgetSnapshot.swift). The widget stays fully
 * offline and never touches PhrenKit's stores: the app writes this JSON and
 * the widget reads it.
 */
@Serializable
data class WidgetSnapshot(
    val totalReviewCount: Int,
    val storeBreakdown: List<StoreCount>,
    val topTask: TopTask? = null,
    val lastSyncedAt: String? = null,
) {
    @Serializable data class StoreCount(val storeName: String, val count: Int)
    @Serializable data class TopTask(val text: String, val project: String)
}

object WidgetBridge {
    private const val FILENAME = "widget-snapshot.json"
    private val json = Json { encodeDefaults = true; explicitNulls = false }
    private var lastPublishedContent: String? = null

    private fun file(context: Context) = File(context.filesDir, FILENAME)

    fun load(context: Context): WidgetSnapshot? = try {
        json.decodeFromString(WidgetSnapshot.serializer(), file(context).readText())
    } catch (_: Exception) {
        null
    }

    /**
     * Writes the snapshot every refresh, but reloads widgets only when the
     * visible content changed — a quiet 7s poll never spends update budget.
     */
    fun publish(context: Context, model: AppModel) {
        if (model.storeContexts.isEmpty() && model.phase != AppModel.Phase.READY) {
            file(context).delete()
            if (lastPublishedContent != null) {
                lastPublishedContent = null
                PhrenGlanceWidget.reload(context)
            }
            return
        }
        val snapshot = WidgetSnapshot(
            totalReviewCount = model.totalReviewCount,
            storeBreakdown = model.storeContexts.map { WidgetSnapshot.StoreCount(it.descriptor.displayName, it.snapshot.reviewQueue.size) }.sortedBy { it.storeName },
            topTask = topActiveTask(model),
            lastSyncedAt = model.syncStatus.lastSyncedAt?.toString(),
        )
        try { atomicWrite(file(context), json.encodeToString(WidgetSnapshot.serializer(), snapshot)) } catch (_: Exception) { return }
        val content = json.encodeToString(WidgetSnapshot.serializer(), snapshot.copy(lastSyncedAt = null))
        if (content == lastPublishedContent) return
        lastPublishedContent = content
        PhrenGlanceWidget.reload(context)
    }

    /** Pinned first, then lowest rank, then project name. */
    private fun topActiveTask(model: AppModel): WidgetSnapshot.TopTask? {
        var best: Pair<PhrenTask, String>? = null
        for (d in model.mergedTaskDocs) for (task in d.doc.active) {
            val current = best
            if (current == null || isHigherPriority(task, d.doc.project, current.first, current.second)) best = task to d.doc.project
        }
        return best?.let { WidgetSnapshot.TopTask(it.first.line, it.second) }
    }

    private fun isHigherPriority(a: PhrenTask, aProject: String, b: PhrenTask, bProject: String): Boolean {
        val ap = a.pinned ?: false
        val bp = b.pinned ?: false
        if (ap != bp) return ap
        val ar = a.rank ?: Int.MAX_VALUE
        val br = b.rank ?: Int.MAX_VALUE
        if (ar != br) return ar < br
        return aProject < bProject
    }
}

private object WidgetTheme {
    val bg = Color(0xFF0A0A1A)
    val text = Color(0xFFECE9F5)
    val textMuted = Color(0xFFECE9F5).copy(alpha = 0.55f)
    val accent = Color(0xFF9058F0)
    val cyan = Color(0xFF28D3F2)
    val border = Color(0xFF9C8FF8).copy(alpha = 0.18f)
}

private fun c(color: Color) = FixedColor(color)

/** Review count + top active task, at a glance (PhrenGlanceWidget.swift). */
class PhrenGlanceWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, MEDIUM))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snapshot = WidgetBridge.load(context)
        provideContent {
            GlanceTheme {
                Box(
                    GlanceModifier.fillMaxSize().background(WidgetTheme.bg).cornerRadius(22.dp).padding(16.dp)
                        .clickable(open(context, "phren://review")),
                ) {
                    if (snapshot == null) OpenPhrenEmpty()
                    else if (LocalSize.current.width >= MEDIUM.width) Medium(context, snapshot)
                    else Small(snapshot)
                }
            }
        }
    }

    companion object {
        private val SMALL = DpSize(140.dp, 140.dp)
        private val MEDIUM = DpSize(300.dp, 140.dp)

        fun reload(context: Context) {
            val appContext = context.applicationContext
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launch {
                try {
                    val manager = androidx.glance.appwidget.GlanceAppWidgetManager(appContext)
                    manager.getGlanceIds(PhrenGlanceWidget::class.java).forEach { PhrenGlanceWidget().update(appContext, it) }
                } catch (_: Exception) {
                }
            }
        }
    }
}

private fun open(context: Context, uri: String) =
    actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri), context, MainActivity::class.java))

private val label = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)

@Composable
private fun Small(snapshot: WidgetSnapshot) {
    Column(GlanceModifier.fillMaxSize()) {
        Text("PHREN", style = label.copy(color = c(WidgetTheme.accent)))
        Spacer(GlanceModifier.defaultWeight())
        Text("${snapshot.totalReviewCount}", style = TextStyle(fontSize = 40.sp, fontWeight = FontWeight.Bold, color = c(WidgetTheme.text)), maxLines = 1)
        Text("to review", style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, color = c(WidgetTheme.textMuted)))
    }
}

@Composable
private fun Medium(context: Context, snapshot: WidgetSnapshot) {
    Row(GlanceModifier.fillMaxSize()) {
        Column(GlanceModifier.defaultWeight().fillMaxHeight().clickable(open(context, "phren://review"))) {
            Text("PHREN", style = label.copy(color = c(WidgetTheme.accent)))
            Spacer(GlanceModifier.height(4.dp))
            Text("${snapshot.totalReviewCount}", style = TextStyle(fontSize = 32.sp, fontWeight = FontWeight.Bold, color = c(WidgetTheme.text)), maxLines = 1)
            Text("to review", style = TextStyle(fontSize = 11.sp, color = c(WidgetTheme.textMuted)))
            if (snapshot.storeBreakdown.size > 1) {
                Text(snapshot.storeBreakdown.joinToString(" · ") { "${it.storeName} ${it.count}" }, style = TextStyle(fontSize = 11.sp, color = c(WidgetTheme.textMuted)), maxLines = 1)
            }
        }
        Spacer(GlanceModifier.width(12.dp))
        Box(GlanceModifier.width(1.dp).fillMaxHeight().background(WidgetTheme.border)) {}
        Spacer(GlanceModifier.width(12.dp))
        Column(GlanceModifier.defaultWeight().fillMaxHeight().clickable(open(context, "phren://tasks"))) {
            Text("TOP TASK", style = label.copy(color = c(WidgetTheme.cyan)))
            Spacer(GlanceModifier.height(4.dp))
            val top = snapshot.topTask
            if (top != null) {
                Text(top.text, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, color = c(WidgetTheme.text)), maxLines = 2)
                Text(top.project, style = TextStyle(fontSize = 11.sp, color = c(WidgetTheme.textMuted)), maxLines = 1)
            } else {
                Text("Nothing active", style = TextStyle(fontSize = 12.sp, color = c(WidgetTheme.textMuted)))
            }
            Spacer(GlanceModifier.defaultWeight())
            snapshot.lastSyncedAt?.let { raw ->
                val at = runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull()
                if (at != null) {
                    Text("synced " + DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS), style = TextStyle(fontSize = 11.sp, color = c(WidgetTheme.textMuted)), maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun OpenPhrenEmpty() {
    Column(GlanceModifier.fillMaxSize()) {
        Text("PHREN", style = label.copy(color = c(WidgetTheme.accent)))
        Spacer(GlanceModifier.defaultWeight())
        Text("↗", style = TextStyle(fontSize = 22.sp, color = c(WidgetTheme.cyan)))
        Text("Open phren", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, color = c(WidgetTheme.text)))
        Text("Sign in to see your review queue", style = TextStyle(fontSize = 11.sp, color = c(WidgetTheme.textMuted)), maxLines = 2)
    }
}

class PhrenGlanceWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PhrenGlanceWidget()
}
