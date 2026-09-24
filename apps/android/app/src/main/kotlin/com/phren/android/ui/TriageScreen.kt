package com.phren.android.ui

import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.phren.android.AppModel
import com.phren.android.StoreQueueEntry
import com.phren.kit.PendingOp
import com.phren.kit.QueueItem
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** One card in the deck, snapshotted at open (TriageCard in TriageView.swift). */
data class TriageCard(
    val id: String,
    val storeId: String,
    val storeName: String,
    val project: String,
    val section: QueueItem.Section,
    val date: String,
    val confidence: Double?,
    val risky: Boolean,
    val machine: String?,
    val modelName: String?,
    val text: String,
    val line: String,
) {
    companion object {
        fun of(e: StoreQueueEntry) = TriageCard(
            e.id, e.storeId, e.storeName, e.entry.project, e.entry.item.section, e.entry.item.date,
            e.entry.item.confidence, e.entry.item.risky, e.entry.item.machine, e.entry.item.model, e.entry.item.text, e.entry.item.line,
        )

        fun normalized(text: String) = text.replace(Regex("[\r\n]+"), " ").trim()

        fun rewrittenLine(line: String, newText: String): String {
            val m = Regex("""^- \[(\d{4}-\d{2}-\d{2})\]""").find(line)
            return if (m != null) "- [${m.groupValues[1]}] $newText" else "- $newText"
        }
    }
}

private enum class Outcome { APPROVED, REJECTED, SKIPPED }
private data class BufferedDecision(val card: TriageCard, val approved: Boolean, val id: String = UUID.randomUUID().toString())

private const val THRESHOLD_DP = 110f
private const val UNDO_WINDOW_MS = 4_000L

/**
 * Full-screen, one-card-at-a-time review: swipe right to approve, left to
 * reject, with a 4-second undo grace buffer before anything is enqueued.
 */
@Composable
fun TriageScreen(model: AppModel, entries: List<StoreQueueEntry>, onClose: () -> Unit) {
    val deck = remember { mutableStateListOf<TriageCard>().apply { addAll(entries.map(TriageCard::of)) } }
    val total = remember { entries.size }
    val outcomes = remember { mutableStateMapOf<String, Outcome>() }
    val skippedOnce = remember { mutableStateListOf<String>() }
    var buffered by remember { mutableStateOf<BufferedDecision?>(null) }
    var editing by remember { mutableStateOf<TriageCard?>(null) }
    var rejectConfirmed by remember { mutableStateOf(false) }
    var confirmingReject by remember { mutableStateOf(false) }
    var committing by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var pastThreshold by remember { mutableStateOf(false) }
    val drag = remember { Animatable(Offset.Zero, Offset.VectorConverter) }
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val density = LocalDensity.current
    val threshold = with(density) { THRESHOLD_DP.dp.toPx() }

    fun enqueue(d: BufferedDecision) {
        val op = if (d.approved) PendingOp.ApproveQueue(d.card.project, d.card.line) else PendingOp.RejectQueue(d.card.project, d.card.line)
        // Detached from this screen: the flush must land even as it goes away.
        model.perform(op, d.card.storeId)
    }

    fun flushBuffer() {
        val d = buffered ?: return
        buffered = null
        enqueue(d)
    }

    fun decide(approved: Boolean) {
        committing = false
        val card = deck.firstOrNull() ?: return
        flushBuffer()
        outcomes[card.id] = if (approved) Outcome.APPROVED else Outcome.REJECTED
        view.performHapticFeedback(if (approved) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.REJECT)
        deck.removeAt(0)
        scope.launch { drag.snapTo(Offset.Zero) }
        pastThreshold = false
        val decision = BufferedDecision(card, approved)
        if (closing) enqueue(decision) else buffered = decision
    }

    fun springBack() {
        pastThreshold = false
        scope.launch { drag.animateTo(Offset.Zero, spring(dampingRatio = 0.7f, stiffness = Spring.StiffnessMediumLow)) }
    }

    fun commitSwipe(direction: Int) {
        if (deck.isEmpty() || committing) return
        if (direction < 0 && !rejectConfirmed) {
            springBack()
            confirmingReject = true
            return
        }
        committing = true
        scope.launch {
            drag.animateTo(Offset(direction * 2000f, drag.value.y), tween(220))
            decide(direction > 0)
        }
    }

    fun undo() {
        val d = buffered ?: return
        buffered = null
        outcomes.remove(d.card.id)
        pastThreshold = false
        scope.launch { drag.snapTo(Offset.Zero) }
        deck.add(0, d.card)
    }

    fun skip() {
        if (deck.isEmpty() || committing) return
        committing = true
        scope.launch {
            drag.animateTo(Offset(drag.value.x, 2600f), tween(220))
            committing = false
            val card = deck.removeAt(0)
            // Once round the back; a second skip drops it so the deck can't loop forever.
            if (card.id !in skippedOnce) {
                skippedOnce.add(card.id)
                deck.add(card)
            }
            if (outcomes[card.id] == null) outcomes[card.id] = Outcome.SKIPPED
            drag.snapTo(Offset.Zero)
            pastThreshold = false
        }
    }

    fun finish() {
        closing = true
        flushBuffer()
        onClose()
    }

    LaunchedEffect(buffered?.id) {
        val d = buffered ?: return@LaunchedEffect
        delay(UNDO_WINDOW_MS)
        if (buffered?.id == d.id) {
            buffered = null
            enqueue(d)
        }
    }
    DisposableEffect(Unit) { onDispose { flushBuffer() } }
    BackHandler { finish() }

    val dx = drag.value.x
    val swipeProgress = min(abs(dx) / threshold, 1f)
    val revealProgress = min(max(abs(dx), abs(drag.value.y) * 1.4f) / threshold, 1f)
    val resolved = total - deck.size

    Box(Modifier.fillMaxSize().background(PhrenTheme.bg)) {
        Box(Modifier.fillMaxSize().background((if (dx >= 0) PhrenTheme.green else PhrenTheme.red).copy(alpha = if (deck.isEmpty()) 0f else swipeProgress * 0.14f)))
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            // Header
            Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.clickable { finish() }, verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.KeyboardArrowDown, null, tint = PhrenTheme.textSecondary, modifier = Modifier.size(20.dp))
                        Text("Done", style = IosType.subheadline.copy(fontWeight = FontWeight.Medium), color = PhrenTheme.textSecondary)
                    }
                    Spacer(Modifier.weight(1f))
                    Text("${if (deck.isEmpty()) total else resolved + 1} of $total", style = IosType.caption.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.textMuted)
                }
                Spacer(Modifier.height(10.dp))
                val fraction by animateFloatAsState(if (total > 0) resolved.toFloat() / total else 1f, tween(250), label = "progress")
                Box(Modifier.fillMaxWidth().height(3.dp).clip(CircleShape).background(PhrenTheme.border)) {
                    Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().shadow(4.dp, CircleShape, ambientColor = PhrenTheme.accent, spotColor = PhrenTheme.accent).background(PhrenTheme.accent, CircleShape))
                }
            }
            ActionErrorBanner(model)
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                val top = deck.firstOrNull()
                if (top != null) {
                    Box(Modifier.fillMaxSize().padding(start = 20.dp, end = 20.dp, bottom = 8.dp)) {
                        deck.getOrNull(1)?.let { next ->
                            key(next.id) {
                                TriageCardFace(
                                    next, model.hasMultipleStores, next.id in skippedOnce,
                                    Modifier.graphicsLayer {
                                        val s = 0.94f + 0.06f * revealProgress
                                        scaleX = s; scaleY = s
                                        alpha = 0.45f + 0.55f * revealProgress
                                        translationY = (14f - 14f * revealProgress) * density.density
                                    },
                                )
                            }
                        }
                        key(top.id) {
                            Box(
                                Modifier.fillMaxSize()
                                    .graphicsLayer {
                                        translationX = drag.value.x
                                        translationY = drag.value.y
                                        rotationZ = (drag.value.x / density.density / 22f).coerceIn(-13f, 13f)
                                        transformOrigin = TransformOrigin(0.5f, 1f)
                                    }
                                    .pointerInput(top.id, committing) {
                                        if (committing) return@pointerInput
                                        val tracker = VelocityTracker()
                                        detectDragGestures(
                                            onDragStart = { tracker.resetTracking() },
                                            onDragEnd = {
                                                val v = tracker.calculateVelocity()
                                                // A quick flick counts even if it stopped short.
                                                val projected = drag.value.x + v.x * 0.25f * 0.25f
                                                when {
                                                    projected > threshold -> commitSwipe(1)
                                                    projected < -threshold -> commitSwipe(-1)
                                                    else -> springBack()
                                                }
                                            },
                                            onDragCancel = { springBack() },
                                        ) { change, amount ->
                                            tracker.addPosition(change.uptimeMillis, change.position)
                                            // Vertical travel is damped: this is a left/right decision.
                                            val next = Offset(drag.value.x + amount.x, drag.value.y + amount.y * 0.22f)
                                            scope.launch { drag.snapTo(next) }
                                            val crossed = abs(next.x) > threshold
                                            if (crossed != pastThreshold) {
                                                pastThreshold = crossed
                                                view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                                            }
                                        }
                                    },
                            ) {
                                TriageCardFace(top, model.hasMultipleStores, top.id in skippedOnce, Modifier)
                                TriageStamp("APPROVE", PhrenTheme.green, -14f, Modifier.align(Alignment.TopStart).padding(22.dp).alpha(stampOpacity(dx, true, threshold)))
                                TriageStamp("REJECT", PhrenTheme.red, 14f, Modifier.align(Alignment.TopEnd).padding(22.dp).alpha(stampOpacity(dx, false, threshold)))
                            }
                        }
                    }
                } else {
                    TriageSummary(
                        outcomes.values.count { it == Outcome.APPROVED },
                        outcomes.values.count { it == Outcome.REJECTED },
                        outcomes.values.count { it == Outcome.SKIPPED },
                        ::finish,
                    )
                }
            }
            // Undo toast
            Box(Modifier.fillMaxWidth().height(48.dp), contentAlignment = Alignment.Center) {
                androidx.compose.animation.AnimatedVisibility(buffered != null, enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
                    val d = buffered
                    Row(
                        Modifier.shadow(8.dp, CircleShape).background(PhrenTheme.surfaceRaised, CircleShape).border(1.dp, PhrenTheme.border, CircleShape)
                            .padding(horizontal = 16.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val approved = d?.approved ?: true
                        Icon(if (approved) Icons.Filled.CheckCircle else Icons.Filled.Delete, null, tint = if (approved) PhrenTheme.green else PhrenTheme.red, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(if (approved) "Approved" else "Rejected", style = IosType.footnote.copy(fontWeight = FontWeight.SemiBold), color = PhrenTheme.text)
                        Spacer(Modifier.width(10.dp))
                        Box(Modifier.width(1.dp).height(14.dp).background(PhrenTheme.border))
                        Spacer(Modifier.width(10.dp))
                        Text("Undo", style = IosType.footnote.copy(fontWeight = FontWeight.Bold), color = PhrenTheme.cyan, modifier = Modifier.clickable { undo() })
                    }
                }
            }
            if (deck.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().padding(bottom = 14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Row(horizontalArrangement = Arrangement.spacedBy(26.dp), verticalAlignment = Alignment.CenterVertically) {
                        TriageActionButton(Icons.Filled.Close, PhrenTheme.red, "Reject", 62) { commitSwipe(-1) }
                        TriageActionButton(Icons.Filled.Edit, PhrenTheme.lavender, "Edit", 50) { if (!committing) editing = deck.firstOrNull() }
                        TriageActionButton(Icons.Filled.Check, PhrenTheme.green, "Approve", 62) { commitSwipe(1) }
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(Modifier.clickable { skip() }, verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Undo, null, tint = PhrenTheme.textMuted, modifier = Modifier.size(15.dp).rotate(-90f))
                        Spacer(Modifier.width(4.dp))
                        Text("Skip for now", style = IosType.footnote, color = PhrenTheme.textMuted)
                    }
                }
            }
        }
    }

    editing?.let { card ->
        TextEntrySheet("Edit before approving", initialText = card.text, confirmLabel = "Save", onDismiss = { editing = null }) { text, _ ->
            flushBuffer()
            model.perform(PendingOp.EditQueue(card.project, card.line, text), card.storeId)
            val index = deck.indexOfFirst { it.id == card.id }
            if (index >= 0) {
                val normalized = TriageCard.normalized(text)
                deck[index] = deck[index].copy(text = normalized, line = TriageCard.rewrittenLine(card.line, normalized))
            }
        }
    }
    if (confirmingReject) {
        IosAlert(
            "Reject deletes this finding",
            "Rejecting removes the finding from FINDINGS.md permanently. You still get a few seconds to undo. Asked once per session.",
            onDismiss = { confirmingReject = false },
            buttons = listOf(
                Triple("Reject", true) { confirmingReject = false; rejectConfirmed = true; commitSwipe(-1) },
                Triple("Keep it", false) { confirmingReject = false },
            ),
        )
    }
}

private fun stampOpacity(dx: Float, forward: Boolean, threshold: Float): Float {
    if (if (forward) dx <= 0 else dx >= 0) return 0f
    val travel = abs(dx)
    val start = threshold * 0.35f
    if (travel <= start) return 0f
    return min((travel - start) / (threshold - start), 1f)
}

@Composable
private fun TriageCardFace(card: TriageCard, showStore: Boolean, secondPass: Boolean, modifier: Modifier) {
    val sectionColor = when (card.section) {
        QueueItem.Section.REVIEW -> PhrenTheme.accentHover
        QueueItem.Section.STALE -> PhrenTheme.amber
        QueueItem.Section.CONFLICTS -> PhrenTheme.red
    }
    Column(modifier.fillMaxSize().phrenCard()) {
        Row(Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TagChip(card.project, PhrenTheme.ChipRole.PROJECT)
            if (showStore) TagChip(card.storeName, PhrenTheme.ChipRole.STORE)
            Spacer(Modifier.weight(1f))
            TagChip(card.section.rawValue.lowercase(), sectionColor)
        }
        // A one-liner sits centered; a long finding scrolls from the top.
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val h = maxHeight
            Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Box(Modifier.fillMaxWidth().heightIn(min = h).padding(horizontal = 20.dp, vertical = 22.dp), contentAlignment = Alignment.CenterStart) {
                    Text(card.text, style = TextStyle(fontSize = 21.sp, lineHeight = 30.sp), color = PhrenTheme.text)
                }
            }
        }
        HorizontalDivider(thickness = 0.5.dp, color = PhrenTheme.border)
        Row(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val mono = IosType.caption2.copy(fontFamily = FontFamily.Monospace)
            Text(card.date, style = mono, color = PhrenTheme.textMuted)
            card.confidence?.let { Text("conf %.0f%%".format(it * 100), style = mono, color = if (it < 0.7) PhrenTheme.amber else PhrenTheme.textMuted) }
            card.machine?.let { Text(it, style = mono, color = PhrenTheme.textDim, maxLines = 1) }
            card.modelName?.let { Text(it, style = mono, color = PhrenTheme.textDim, maxLines = 1) }
            Spacer(Modifier.weight(1f))
            if (secondPass) Text("skipped once", style = mono, color = PhrenTheme.lavender)
            if (card.risky) Icon(Icons.Filled.Warning, null, tint = PhrenTheme.amber, modifier = Modifier.size(12.dp))
        }
    }
}

@Composable
private fun TriageStamp(text: String, color: Color, angle: Float, modifier: Modifier) {
    Text(
        text,
        style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp),
        color = color,
        modifier = modifier.rotate(angle)
            .shadow(10.dp, RoundedCornerShape(6.dp), ambientColor = color.copy(alpha = 0.35f), spotColor = color.copy(alpha = 0.35f))
            .border(3.dp, color, RoundedCornerShape(6.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

@Composable
private fun TriageActionButton(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color, label: String, diameter: Int, onClick: () -> Unit) {
    Box(
        Modifier.size(diameter.dp).background(tint.copy(alpha = 0.12f), CircleShape).border(1.5.dp, tint.copy(alpha = 0.5f), CircleShape).clip(CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = tint, modifier = Modifier.size((diameter * 0.42f).dp))
    }
}

@Composable
private fun TriageSummary(approved: Int, rejected: Int, skipped: Int, onDone: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(bottom = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(1f))
        PhrenMascot(size = 96.dp)
        Spacer(Modifier.height(22.dp))
        Text(if (approved + rejected == 0) "Nothing decided" else "Queue triaged", style = IosType.title3.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.text)
        Spacer(Modifier.height(6.dp))
        Text(
            when {
                skipped > 0 -> "Skipped items stay in the queue — they'll be waiting next time."
                approved + rejected == 0 -> "The deck is back where it started."
                else -> "Changes sync as soon as the network allows."
            },
            style = IosType.footnote, color = PhrenTheme.textMuted, textAlign = TextAlign.Center, modifier = Modifier.width(280.dp),
        )
        Spacer(Modifier.height(22.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Stat(approved, "approved", PhrenTheme.green)
            Stat(rejected, "rejected", PhrenTheme.red)
            Stat(skipped, "skipped", PhrenTheme.lavender)
        }
        Spacer(Modifier.weight(1f))
        Box(
            Modifier.fillMaxWidth().padding(horizontal = 32.dp).clip(RoundedCornerShape(8.dp)).background(PhrenTheme.accentSolid).clickable(onClick = onDone).padding(vertical = 14.dp),
            contentAlignment = Alignment.Center,
        ) { Text("Done", style = IosType.headline, color = Color.White) }
    }
}

@Composable
private fun Stat(value: Int, label: String, color: Color) {
    Column(
        Modifier.width(92.dp).background(PhrenTheme.surface, RoundedCornerShape(6.dp)).border(1.dp, PhrenTheme.border, RoundedCornerShape(6.dp)).padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("$value", style = TextStyle(fontSize = 30.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace), color = color)
        Spacer(Modifier.height(4.dp))
        Text(label, style = IosType.caption2.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.textMuted)
    }
}

