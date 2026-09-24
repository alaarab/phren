package com.phren.android.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.phren.android.AppModel
import com.phren.android.CaptureLog
import com.phren.android.CaptureLogEntry
import com.phren.android.QuickCaptureDefault
import com.phren.android.VoiceCaptureLastTarget
import com.phren.kit.PendingOp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

data class VoiceCaptureTarget(val storeId: String, val storeName: String, val project: String) {
    val id: String get() = "$storeId|$project"
}

/**
 * On-device dictation (SpeechTranscriber.swift) over SpeechRecognizer. Android's
 * recognizer ends a session at each pause, so it is restarted while recording
 * and finalized segments accumulate — one continuous transcript, like iOS.
 */
class SpeechTranscriber(private val context: Context) {
    enum class PermissionState { NOT_DETERMINED, AUTHORIZED, DENIED }

    var transcript by mutableStateOf("")
        private set
    var isRecording by mutableStateOf(false)
        private set
    var audioLevel by mutableFloatStateOf(0f)
        private set

    private var recognizer: SpeechRecognizer? = null
    private var committed = ""

    val isRecognizerAvailable: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)

    private fun join(a: String, b: String) = if (a.isEmpty()) b else if (b.isEmpty()) a else "$a $b"

    private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        // On-device when the device can: the audio never leaves the phone.
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {
            // Typical speech sits around 2–8 dB here; scale so the pulse reads as "listening".
            audioLevel = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
        }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onError(error: Int) {
            if (!isRecording) return
            // A pause with nothing heard: keep listening.
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) restart()
            else stop()
        }
        override fun onResults(results: Bundle?) {
            best(results)?.let { committed = join(committed, it) }
            transcript = committed
            if (isRecording) restart()
        }
        override fun onPartialResults(partialResults: Bundle?) {
            best(partialResults)?.let { transcript = join(committed, it) }
        }
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun best(bundle: Bundle?) = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }

    private fun restart() {
        recognizer?.cancel()
        recognizer?.startListening(intent)
    }

    fun start() {
        if (!isRecognizerAvailable) throw IllegalStateException("Dictation isn't available in this language on this device.")
        stop()
        committed = ""
        transcript = ""
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).also {
            it.setRecognitionListener(listener)
            it.startListening(intent)
        }
        isRecording = true
    }

    fun stop() {
        isRecording = false
        audioLevel = 0f
        recognizer?.stopListening()
        recognizer?.destroy()
        recognizer = null
    }

    companion object {
        fun currentPermissionState(context: Context): PermissionState =
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) PermissionState.AUTHORIZED
            else PermissionState.NOT_DETERMINED
    }
}

private enum class CaptureKind(val label: String) { NOTE("Note"), TASK("Task") }

/**
 * Dictate a note or a task (VoiceCaptureView.swift). Unsaved text asks before
 * it is discarded; with several targets nothing is preselected unless a
 * default or last target says where it goes.
 */
@Composable
fun VoiceCaptureSheet(model: AppModel, targets: List<VoiceCaptureTarget>, preselected: VoiceCaptureTarget?, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val transcriber = remember { SpeechTranscriber(context) }
    var text by remember { mutableStateOf("") }
    var baseText by remember { mutableStateOf("") }
    var selected by remember {
        mutableStateOf(
            preselected ?: run {
                val preferred = QuickCaptureDefault.load(model.prefs)?.let { p -> targets.firstOrNull { it.storeId == p.storeId && it.project == p.project } }
                val last = VoiceCaptureLastTarget.load(model.prefs)?.let { p -> targets.firstOrNull { it.storeId == p.storeId && it.project == p.project } }
                preferred ?: last ?: targets.singleOrNull()
            },
        )
    }
    var permission by remember { mutableStateOf(SpeechTranscriber.currentPermissionState(context)) }
    var recognizerUnavailable by remember { mutableStateOf(false) }
    var startedAt by remember { mutableLongStateOf(0L) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var kind by remember { mutableStateOf(CaptureKind.NOTE) }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permission = if (granted) SpeechTranscriber.PermissionState.AUTHORIZED else SpeechTranscriber.PermissionState.DENIED
    }
    LaunchedEffect(Unit) {
        recognizerUnavailable = !transcriber.isRecognizerAvailable
        if (permission == SpeechTranscriber.PermissionState.NOT_DETERMINED) permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }
    LaunchedEffect(transcriber.transcript) {
        if (transcriber.isRecording) text = if (baseText.isEmpty()) transcriber.transcript
        else if (transcriber.transcript.isEmpty()) baseText
        else if (baseText.endsWith(" ") || baseText.endsWith("\n")) baseText + transcriber.transcript else "$baseText ${transcriber.transcript}"
    }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    // Never leave the mic listening once we're not visible.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_STOP) transcriber.stop()
            if (e == Lifecycle.Event.ON_RESUME) permission = SpeechTranscriber.currentPermissionState(context).let {
                if (it == SpeechTranscriber.PermissionState.NOT_DETERMINED && permission == SpeechTranscriber.PermissionState.DENIED) permission else it
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); transcriber.stop() }
    }

    val hasUnsaved = text.isNotBlank()
    val canSave = hasUnsaved && selected != null
    fun attemptDismiss() = if (hasUnsaved) confirmDiscard = true else onDismiss()
    fun label(t: VoiceCaptureTarget) = if (model.hasMultipleStores) "${t.project} · ${t.storeName}" else t.project

    fun save() {
        val target = selected ?: return
        transcriber.stop()
        val value = text.trim()
        if (value.isEmpty()) return
        saving = true
        val op = when (kind) {
            CaptureKind.NOTE -> AppModel.nowNoteTimestamp().let { (date, time) -> PendingOp.AddNote(target.project, date, time, value) }
            CaptureKind.TASK -> PendingOp.AddTask(target.project, value)
        }
        scope.launch {
            model.performNow(op, target.storeId)
            // Only a write that was accepted gets remembered or logged.
            val accepted = model.lastActionError == null
            if (accepted) {
                VoiceCaptureLastTarget.save(model.prefs, target.storeId, target.project)
                CaptureLog.record(model.prefs, if (kind == CaptureKind.NOTE) CaptureLogEntry.Kind.NOTE else CaptureLogEntry.Kind.TASK, target.storeId, target.project, value, CaptureLogEntry.Source.APP)
            }
            view.performHapticFeedback(if (accepted) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.REJECT)
            onDismiss()
        }
    }

    IosSheet(
        onDismiss = { attemptDismiss() },
        title = if (kind == CaptureKind.NOTE) "Dictate a note" else "Dictate a task",
        background = PhrenTheme.bg,
        trailing = {
            if (saving) IosSpinner(Modifier.padding(horizontal = 12.dp))
            else ToolbarButton(ToolbarAction(text = "Save", bold = true, enabled = canSave) { save() })
        },
        leading = { ToolbarButton(ToolbarAction(text = "Cancel", enabled = !saving) { attemptDismiss() }) },
    ) {
        Box(Modifier.fillMaxSize()) {
            if (targets.isEmpty()) {
                PhrenEmptyState(
                    "No writable store yet",
                    "Your GitHub token needs Contents: Read and write on the store repo before you can add notes.",
                    Modifier.align(Alignment.Center),
                )
            } else {
                Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    IosSegmented(CaptureKind.entries, kind, { it.label }, { kind = it })
                    if (permission == SpeechTranscriber.PermissionState.DENIED) {
                        PermissionDenied(context)
                    } else {
                        MicButton(transcriber, recognizerUnavailable || permission != SpeechTranscriber.PermissionState.AUTHORIZED) {
                            if (transcriber.isRecording) {
                                transcriber.stop()
                                startedAt = 0L
                            } else {
                                baseText = text
                                try {
                                    transcriber.start()
                                    startedAt = System.currentTimeMillis()
                                    now = startedAt
                                } catch (_: Exception) {
                                    recognizerUnavailable = true
                                }
                            }
                        }
                        val caption = when {
                            transcriber.isRecording -> null
                            recognizerUnavailable -> "Dictation isn't available in this language on this device. You can still type below."
                            permission == SpeechTranscriber.PermissionState.NOT_DETERMINED -> "Requesting microphone access…"
                            text.isEmpty() -> "Tap to start dictating"
                            else -> "Tap to keep dictating"
                        }
                        if (caption == null) {
                            val seconds = maxOf(0L, (now - startedAt) / 1000)
                            Text("%d:%02d".format(seconds / 60, seconds % 60), style = IosType.title3.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Normal), color = PhrenTheme.textMuted)
                        } else {
                            Text(caption, style = IosType.footnote, color = PhrenTheme.textMuted, textAlign = TextAlign.Center)
                        }
                    }
                    // Editor
                    Box(
                        Modifier.fillMaxWidth().weight(1f).heightIn(min = 140.dp)
                            .background(PhrenTheme.surface, RoundedCornerShape(10.dp)).border(1.dp, PhrenTheme.border, RoundedCornerShape(10.dp)).padding(13.dp),
                    ) {
                        if (text.isEmpty()) Text("Your dictation appears here — edit freely, or type.", style = IosType.body, color = PhrenTheme.textMuted)
                        BasicTextField(text, { text = it }, textStyle = IosType.body.copy(color = PhrenTheme.text), cursorBrush = SolidColor(PhrenTheme.accent), modifier = Modifier.fillMaxSize())
                    }
                    // Destination
                    if (targets.size > 1) {
                        Column(Modifier.fillMaxWidth()) {
                            // A visible "nothing picked yet": phren won't choose for you.
                            FormPicker("Project", listOf<Pair<VoiceCaptureTarget?, String>>(null to "Choose a project…") + targets.map { it to label(it) }, selected) { selected = it }
                            if (selected == null) {
                                Spacer(Modifier.height(4.dp))
                                Text("Pick where this goes — phren won't choose for you. Set a default in Settings → Quick capture.", style = IosType.footnote, color = PhrenTheme.textMuted)
                            }
                        }
                    } else targets.firstOrNull()?.let {
                        Text("Saving to ${label(it)}", style = IosType.footnote, color = PhrenTheme.textMuted)
                    }
                }
            }
        }
    }
    if (confirmDiscard) {
        IosAlert(
            if (kind == CaptureKind.NOTE) "Discard this note?" else "Discard this task?", null,
            onDismiss = { confirmDiscard = false },
            buttons = listOf(
                Triple("Discard", true) { confirmDiscard = false; onDismiss() },
                Triple("Keep editing", false) { confirmDiscard = false },
            ),
        )
    }
}

@Composable
private fun MicButton(transcriber: SpeechTranscriber, disabled: Boolean, onClick: () -> Unit) {
    val recording = transcriber.isRecording
    val level by animateFloatAsState(transcriber.audioLevel, tween(100), label = "level")
    val pulse = rememberInfiniteTransition(label = "pulse")
    val pulseProgress by pulse.animateFloat(0f, 1f, infiniteRepeatable(tween(1200), RepeatMode.Restart), label = "p")
    Box(Modifier.size(176.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(132.dp).background(PhrenTheme.surfaceRaised, CircleShape).border(1.dp, PhrenTheme.border, CircleShape))
        if (recording) {
            Box(Modifier.size((132 + level * 44).dp).border(3.dp, PhrenTheme.cyan.copy(alpha = 0.45f), CircleShape))
            Box(Modifier.size((132 + 44 * pulseProgress).dp).alpha(1f - pulseProgress).border(2.dp, PhrenTheme.cyan.copy(alpha = 0.25f), CircleShape))
        }
        val fill = if (recording) PhrenTheme.danger else PhrenTheme.accentSolid
        val glow = if (recording) PhrenTheme.danger else PhrenTheme.accent
        Box(
            Modifier.size(96.dp).shadow(16.dp, CircleShape, ambientColor = glow.copy(alpha = 0.5f), spotColor = glow.copy(alpha = 0.5f))
                .clip(CircleShape).background(fill).alpha(if (disabled) 0.4f else 1f)
                .clickable(enabled = !disabled, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (recording) Icons.Filled.Stop else Icons.Filled.Mic, if (recording) "Stop dictation" else "Start dictation", tint = Color.White, modifier = Modifier.size(40.dp))
        }
    }
}

@Composable
private fun PermissionDenied(context: Context) {
    Column(Modifier.padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(Icons.Filled.MicOff, null, tint = PhrenTheme.textMuted, modifier = Modifier.size(40.dp))
        Text("Microphone access needed", style = IosType.headline, color = PhrenTheme.text)
        Text(
            "Phren dictates notes on this device. Allow microphone access in Settings to use voice capture — you can still type below in the meantime.",
            style = IosType.footnote, color = PhrenTheme.textMuted, textAlign = TextAlign.Center,
        )
        ProminentButton("Open Settings", Icons.Filled.Settings, fill = false) {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
        }
    }
}
