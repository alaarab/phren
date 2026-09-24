package com.phren.android.features

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.phren.android.AppModel
import com.phren.android.CaptureLog
import com.phren.android.CaptureLogEntry
import com.phren.android.QuickCaptureDefault
import com.phren.android.StoreProject
import com.phren.android.VoiceCaptureLastTarget
import com.phren.android.design.BackCloses
import com.phren.android.design.LocalDismiss
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenDialog
import com.phren.android.design.PhrenEmptyState
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenSingleSelect
import com.phren.android.design.PhrenSingleSelectSheet
import com.phren.android.design.PhrenTextSegment
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.SF
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.kit.PendingOp
import kotlinx.coroutines.launch

/** One writable (store, project) a dictated note can be filed under. */
data class VoiceCaptureTarget(val storeId: String, val storeName: String, val project: String) {
    val id: String get() = "$storeId|$project"
}

private enum class CaptureKind(val title: String) { NOTE("Note"), TASK("Task") }

/** Voice quick capture (VoiceCaptureView.swift). */
@Composable
fun VoiceCaptureView(model: AppModel, targets: List<VoiceCaptureTarget>, preselected: VoiceCaptureTarget? = null, onFinish: (() -> Unit)? = null) {
    val context = LocalContext.current
    val view = LocalView.current
    val dismiss = onFinish ?: LocalDismiss.current ?: {}
    val session = remember { DictationSession(AndroidSpeechRecognizer(context, model.prefs)) { SpeechSettings.apply(model.prefs, it) } }
    var text by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<VoiceCaptureTarget?>(null) }
    var permission by remember { mutableStateOf(AndroidSpeechRecognizer.permission(context)) }
    var recordingStartedAt by remember { mutableStateOf<Long?>(null) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var kind by remember { mutableStateOf(CaptureKind.NOTE) }
    var showingTarget by remember { mutableStateOf(false) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permission = if (granted) AndroidSpeechRecognizer.PermissionState.AUTHORIZED else AndroidSpeechRecognizer.PermissionState.DENIED
    }
    val recognizerUnavailable = !session.isRecognizerAvailable

    LaunchedEffect(Unit) {
        selected = preselected ?: defaultTarget(model, targets)
        if (permission == AndroidSpeechRecognizer.PermissionState.NOT_DETERMINED) request.launch(Manifest.permission.RECORD_AUDIO)
    }
    // Never leave the mic listening once the sheet isn't visible.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) session.stop()
            if (event == Lifecycle.Event.ON_RESUME && permission != AndroidSpeechRecognizer.PermissionState.AUTHORIZED) permission = AndroidSpeechRecognizer.permission(context).let {
                if (it == AndroidSpeechRecognizer.PermissionState.NOT_DETERMINED && permission == AndroidSpeechRecognizer.PermissionState.DENIED) permission else it
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); session.stop() }
    }

    val hasUnsavedText = text.isNotBlank()
    fun attemptDismiss() { if (hasUnsavedText) confirmDiscard = true else dismiss() }
    fun label(t: VoiceCaptureTarget) = if (model.hasMultipleStores) "${t.project} · ${t.storeName}" else t.project
    val options = listOf(PhrenOption<VoiceCaptureTarget?>(id = "none", value = null, title = "Choose a project…")) +
        targets.map { PhrenOption<VoiceCaptureTarget?>(id = it.id, value = it, title = label(it)) }

    fun toggleRecording() {
        if (session.isRecording) session.stop()
        else {
            session.readDraft = { text }
            session.onDraftChange = { text = it }
            session.start(text)
            recordingStartedAt = System.currentTimeMillis()
        }
    }

    fun save() {
        val target = selected ?: return
        session.stop()
        val value = text.trim()
        if (value.isEmpty()) return
        saving = true
        val op = if (kind == CaptureKind.NOTE) {
            val (date, time) = AppModel.nowNoteTimestamp()
            PendingOp.AddNote(target.project, date, time, value)
        } else PendingOp.AddTask(target.project, value)
        model.scope.launch {
            model.performNow(op, target.storeId)
            val accepted = model.lastActionError == null
            if (accepted) {
                VoiceCaptureLastTarget.save(model.prefs, target.storeId, target.project)
                CaptureLog.record(model.prefs, if (kind == CaptureKind.NOTE) CaptureLogEntry.Kind.NOTE else CaptureLogEntry.Kind.TASK,
                    target.storeId, target.project, value, CaptureLogEntry.Source.APP)
            }
            view.performHapticFeedback(if (accepted) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.REJECT)
            dismiss()
        }
    }

    BackCloses(true) { attemptDismiss() }
    Column(Modifier.fillMaxSize().background(PhrenTheme.bg)) {
        PhrenNavBar(if (kind == CaptureKind.NOTE) "Dictate a note" else "Dictate a task", inSheet = onFinish == null,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", enabled = !saving, identifier = "voice-capture-cancel") { attemptDismiss() }),
            trailing = listOf(ToolbarItem(text = if (saving) "Saving…" else "Save", label = "Save", bold = true, enabled = hasUnsavedText && selected != null && !saving,
                identifier = "voice-capture-save") { save() }))
        if (targets.isEmpty()) {
            PhrenEmptyState("No writable store yet", "Your GitHub token needs Contents: Read and write on the store repo before you can add notes.", Modifier.fillMaxSize())
            return@Column
        }
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            PhrenTextSegment(CaptureKind.entries.map { PhrenOption(id = it.title, value = it, title = it.title) }, kind, { kind = it }, identifier = "voice-capture-kind")
            if (permission == AndroidSpeechRecognizer.PermissionState.DENIED) {
                Column(Modifier.padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(SF("mic.slash.fill"), null, tint = PhrenTheme.textMuted, modifier = Modifier.size(40.dp))
                    Text("Microphone access needed", style = PhrenType.headline, color = PhrenTheme.text)
                    Text("Phren dictates notes on this device. Allow microphone access in Settings to use voice capture — you can still type below in the meantime.",
                        style = PhrenType.footnote, color = PhrenTheme.textMuted, textAlign = TextAlign.Center)
                    WideButton("Open Settings", SF("gearshape"), prominent = true) {
                        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                    }
                }
            } else MicSection(session, recordingStartedAt, recognizerUnavailable, permission, text.isEmpty()) { toggleRecording() }

            Box(Modifier.fillMaxWidth().weight(1f).heightIn(min = 140.dp).background(PhrenTheme.surface, RoundedCornerShape(10.dp))
                .border(1.dp, PhrenTheme.border, RoundedCornerShape(10.dp)).padding(13.dp)) {
                if (text.isEmpty()) Text("Your dictation appears here — edit freely, or type.", style = PhrenType.body, color = PhrenTheme.textMuted)
                BasicTextField(text, { text = it; if (session.isRecording) session.updateDraft(it) }, textStyle = PhrenType.body.copy(color = PhrenTheme.text),
                    cursorBrush = SolidColor(PhrenTheme.cyan), modifier = Modifier.fillMaxSize().phrenIdentifier("voice-capture-text"))
            }
            if (targets.size > 1) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    PhrenSingleSelect(options, selected, placeholder = "Choose a project…", identifier = "voice-capture-project") { showingTarget = true }
                    if (selected == null) Text("Pick where this goes — phren won't choose for you. Set a default in Settings → Quick capture.",
                        style = PhrenType.footnote, color = PhrenTheme.textMuted)
                }
            } else targets.firstOrNull()?.let { Text("Saving to ${label(it)}", style = PhrenType.footnote, color = PhrenTheme.textMuted) }
        }
    }
    if (showingTarget) PhrenSingleSelectSheet("Project", options, selected, { selected = it }, rowPrefix = "voice-capture-project") { showingTarget = false }
    if (confirmDiscard) PhrenDialog(if (kind == CaptureKind.NOTE) "Discard this note?" else "Discard this task?", "The text you dictated will be lost.", listOf(
        PhrenControlAction("discard", "Discard", role = PhrenControlAction.Role.DESTRUCTIVE) { dismiss() },
        PhrenControlAction("keep", "Keep editing", role = PhrenControlAction.Role.CANCEL) {},
    ), identifier = "voice-capture-discard-dialog") { confirmDiscard = false }
}

@Composable
private fun MicSection(session: DictationSession, startedAt: Long?, unavailable: Boolean, permission: AndroidSpeechRecognizer.PermissionState, empty: Boolean, toggle: () -> Unit) {
    val recording = session.isRecording
    val pulse = rememberInfiniteTransition(label = "pulse").animateFloat(0f, 1f, infiniteRepeatable(tween(1200), RepeatMode.Restart), label = "pulse")
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.size(176.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(132.dp).background(PhrenTheme.surfaceRaised, CircleShape).border(1.dp, PhrenTheme.border, CircleShape))
            if (recording) {
                Box(Modifier.size((132 + session.audioLevel * 44).dp).border(3.dp, PhrenTheme.cyan.copy(alpha = 0.45f), CircleShape))
                Box(Modifier.size((132 + pulse.value * 44).dp).alpha(1 - pulse.value).border(2.dp, PhrenTheme.cyan.copy(alpha = 0.25f), CircleShape))
            }
            val color = if (recording) PhrenTheme.danger else PhrenTheme.accentSolid
            val enabled = !unavailable && permission == AndroidSpeechRecognizer.PermissionState.AUTHORIZED
            Box(Modifier.size(96.dp).shadow(16.dp, CircleShape, ambientColor = color, spotColor = color).background(color, CircleShape)
                .plainClickable(enabled, onClick = toggle).phrenIdentifier("voice-capture-mic").alpha(if (enabled) 1f else 0.45f), contentAlignment = Alignment.Center) {
                Icon(SF(if (recording) "stop.fill" else "mic.fill"), if (recording) "Stop dictation" else "Start dictation", tint = Color.White, modifier = Modifier.size(38.dp))
            }
        }
        val now = rememberNow()
        when {
            recording -> {
                val seconds = startedAt?.let { ((now - it) / 1000).coerceAtLeast(0) } ?: 0
                Text("%d:%02d".format(seconds / 60, seconds % 60), style = PhrenType.title3, color = PhrenTheme.textMuted)
            }
            session.failureReason != null -> Text(session.failureReason!!, style = PhrenType.footnote, color = PhrenTheme.warning, textAlign = TextAlign.Center)
            unavailable -> Text("Dictation isn't available in this language on this device. You can still type below.", style = PhrenType.footnote, color = PhrenTheme.textMuted, textAlign = TextAlign.Center)
            permission == AndroidSpeechRecognizer.PermissionState.NOT_DETERMINED -> Text("Requesting microphone access…", style = PhrenType.footnote, color = PhrenTheme.textMuted)
            else -> Text(if (empty) "Tap to start dictating" else "Tap to keep dictating", style = PhrenType.footnote, color = PhrenTheme.textMuted)
        }
    }
}

/** The configured default, then the last project anything was captured into, then nothing (unless there is only one). */
private fun defaultTarget(model: AppModel, targets: List<VoiceCaptureTarget>): VoiceCaptureTarget? {
    QuickCaptureDefault.load(model.prefs)?.let { p -> targets.firstOrNull { it.storeId == p.storeId && it.project == p.project }?.let { return it } }
    VoiceCaptureLastTarget.load(model.prefs)?.let { p -> targets.firstOrNull { it.storeId == p.storeId && it.project == p.project }?.let { return it } }
    return targets.singleOrNull()
}

fun List<StoreProject>.voiceTargets() = map { VoiceCaptureTarget(it.storeId, it.storeName, it.project.name) }
