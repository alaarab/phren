package com.phren.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.service.quicksettings.TileService
import android.speech.RecognizerIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenMaterialTheme
import com.phren.android.design.PhrenTheme
import com.phren.android.features.ProminentButton
import com.phren.kit.LocalStore
import com.phren.kit.PendingOp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The Android side of "Hey Siri, add a task to phren" (AddPhrenTaskIntent /
 * AddPhrenNoteIntent). Launched from the launcher's long-press shortcuts,
 * "Hey Google, open Add Task", the quick-settings tile, or an ACTION_SEND of
 * text. It asks for the text by voice (the recognizer collects it the way
 * Siri's requestValueDialog does), resolves the project the same way the
 * intents do, and confirms "Added to <project>." Capture never needs the
 * network: with the app cold, the op queues in pending-ops.json for the next
 * foreground sync.
 */
class CaptureActivity : ComponentActivity() {
    enum class Kind(val label: String, val prompt: String) {
        TASK("Task", "What's the task?"),
        NOTE("Note", "What should the note say?"),
    }

    private sealed interface Stage {
        data object Listening : Stage
        data class Typing(val prompt: String) : Stage
        data class Choose(val text: String, val prompt: String, val targets: List<PhrenCaptureTarget>) : Stage
        data class Done(val text: String, val destination: String, val spoken: String) : Stage
        data class Failed(val message: String) : Stage
    }

    private var stage by mutableStateOf<Stage>(Stage.Listening)
    private lateinit var kind: Kind
    private var projectName: String? = null

    private val speech = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
        if (result.resultCode == Activity.RESULT_OK && !heard.isNullOrEmpty()) submit(heard)
        // Dictation heard nothing usable — ask again (by keyboard) rather than filing an empty item.
        else stage = Stage.Typing(kind.prompt)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true)
        kind = if (intent.getStringExtra(EXTRA_KIND) == "note") Kind.NOTE else Kind.TASK
        projectName = intent.getStringExtra(EXTRA_PROJECT)
        val shared = intent.takeIf { it.action == Intent.ACTION_SEND }?.getStringExtra(Intent.EXTRA_TEXT)?.trim()
        if (savedInstanceState == null) {
            if (!shared.isNullOrEmpty()) submit(shared)
            else listen()
        }
        setContent { PhrenMaterialTheme { CaptureScreen() } }
    }

    private fun listen() {
        stage = Stage.Listening
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, kind.prompt)
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        try { speech.launch(intent) } catch (_: Exception) { stage = Stage.Typing(kind.prompt) }
    }

    private fun op(text: String, target: PhrenCaptureTarget): PendingOp = when (kind) {
        Kind.TASK -> PendingOp.AddTask(target.project, text)
        Kind.NOTE -> AppModel.nowNoteTimestamp().let { (d, t) -> PendingOp.AddNote(target.project, d, t, text) }
    }

    private fun submit(text: String, chosen: PhrenCaptureTarget? = null) {
        val model = phrenModel
        model.scope.launch {
            try {
                val target = chosen ?: when (val r = PhrenCapture.resolveTarget(model, projectName)) {
                    is PhrenCapture.Resolution.Resolved -> r.target
                    is PhrenCapture.Resolution.Ask -> {
                        val options = projectName?.let { ProjectMatcher.candidates(it, PhrenCapture.targets(model)) }?.takeIf { it.size > 1 }
                            ?: PhrenCapture.targets(model)
                        stage = Stage.Choose(text, r.prompt, options)
                        return@launch
                    }
                }
                PhrenCapture.capture(model, op(text, target), target, CaptureLogEntry.Source.SIRI)
                stage = Stage.Done(text, target.displayName, target.spokenName)
            } catch (e: Exception) {
                stage = Stage.Failed(e.message ?: e.toString())
            }
        }
    }

    @Composable
    private fun CaptureScreen() {
        Box(Modifier.fillMaxSize().background(PhrenTheme.bg.copy(alpha = 0.6f)).clickable(interactionSource = null, indication = null) { finish() }, contentAlignment = Alignment.BottomCenter) {
            Column(
                Modifier.fillMaxWidth().padding(12.dp).background(PhrenTheme.surfaceRaised, RoundedCornerShape(22.dp))
                    .border(1.dp, PhrenTheme.border, RoundedCornerShape(22.dp)).clickable(interactionSource = null, indication = null) {}.padding(18.dp),
            ) {
                Text("PHREN", style = PhrenType.caption2.copy(fontWeight = FontWeight.Bold), color = PhrenTheme.accent)
                Spacer(Modifier.height(10.dp))
                when (val s = stage) {
                    Stage.Listening -> Text(kind.prompt, style = PhrenType.headline, color = PhrenTheme.text)
                    is Stage.Typing -> TypingStage(s.prompt)
                    is Stage.Choose -> ChooseStage(s)
                    is Stage.Done -> DoneStage(s)
                    is Stage.Failed -> {
                        Text(s.message, style = PhrenType.body, color = PhrenTheme.text)
                        Spacer(Modifier.height(14.dp))
                        ProminentButton("OK") { finish() }
                    }
                }
            }
        }
    }

    @Composable
    private fun TypingStage(prompt: String) {
        var text by remember { mutableStateOf("") }
        Text(prompt, style = PhrenType.headline, color = PhrenTheme.text)
        Spacer(Modifier.height(10.dp))
        Box(Modifier.fillMaxWidth().heightIn(min = 80.dp).background(PhrenTheme.surface, RoundedCornerShape(10.dp)).border(1.dp, PhrenTheme.border, RoundedCornerShape(10.dp)).padding(12.dp)) {
            BasicTextField(text, { text = it }, textStyle = PhrenType.body.copy(color = PhrenTheme.text), cursorBrush = SolidColor(PhrenTheme.accent), modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Dictate", style = PhrenType.body, color = PhrenTheme.accent, modifier = Modifier.clickable { listen() })
            Spacer(Modifier.weight(1f))
            Text("Cancel", style = PhrenType.body, color = PhrenTheme.accent, modifier = Modifier.clickable { finish() })
            ProminentButton("Add") { if (text.isNotBlank()) submit(text.trim()) }
        }
    }

    @Composable
    private fun ChooseStage(s: Stage.Choose) {
        Text(s.prompt, style = PhrenType.headline, color = PhrenTheme.text)
        Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.heightIn(max = 320.dp)) {
            items(s.targets, key = { it.entityId }) { t ->
                Text(t.displayName, style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.fillMaxWidth().clickable { submit(s.text, t) }.padding(vertical = 12.dp))
            }
        }
    }

    @Composable
    private fun DoneStage(s: Stage.Done) {
        // CaptureSnippetView: kind, text, destination.
        LaunchedEffect(Unit) { delay(2200); finish() }
        Text("Added to ${s.spoken}.", style = PhrenType.headline, color = PhrenTheme.text)
        Spacer(Modifier.height(12.dp))
        Text(kind.label.uppercase(), style = PhrenType.caption2.copy(fontWeight = FontWeight.SemiBold), color = PhrenTheme.textSecondary)
        Spacer(Modifier.height(8.dp))
        Text(s.text, style = PhrenType.body, color = PhrenTheme.text, maxLines = 4)
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Folder, null, tint = PhrenTheme.textSecondary, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(s.destination, style = PhrenType.footnote.copy(fontWeight = FontWeight.Medium), color = PhrenTheme.textSecondary, maxLines = 1)
        }
    }

    companion object {
        const val EXTRA_KIND = "com.phren.android.extra.KIND"
        const val EXTRA_PROJECT = "com.phren.android.extra.PROJECT"

        fun intent(context: Context, kind: String, project: String? = null) =
            Intent(context, CaptureActivity::class.java).setAction(Intent.ACTION_VIEW)
                .putExtra(EXTRA_KIND, kind).apply { project?.let { putExtra(EXTRA_PROJECT, it) } }
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
}

/** Quick-settings tile: add a task from the shade, locked or not. */
class CaptureTileService : TileService() {
    override fun onClick() {
        super.onClick()
        val intent = CaptureActivity.intent(this, "task")
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(android.app.PendingIntent.getActivity(this, 0, intent, android.app.PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}

/**
 * Per-project launcher shortcuts ("Add a task to <project>"), the analogue of
 * PhrenAppShortcuts.donateProjects: republished only when the writable
 * project set changes, and never narrowed by the UI's store filter.
 */
object AppShortcuts {
    private var donated: List<String>? = null

    fun donateProjects(context: Context, model: AppModel) {
        val projects = model.storeContexts.filter { it.descriptor.canPush }.flatMap { c ->
            c.snapshot.projects.filter { !LocalStore.isReadOnlyProject(it.name) }.map { "${c.id}|${it.name}" }
        }.sorted()
        if (projects == donated) return
        donated = projects
        val manager = context.getSystemService(ShortcutManager::class.java) ?: return
        // Two static shortcuts already exist; fill the rest with the most recent capture target.
        val last = VoiceCaptureLastTarget.load(model.prefs)?.takeIf { "${it.storeId}|${it.project}" in projects }
        val dynamic = if (last == null) emptyList() else listOf(
            ShortcutInfo.Builder(context, "task-${last.project}")
                .setShortLabel("Task → ${last.project}")
                .setLongLabel("Add a task to ${last.project}")
                .setIcon(Icon.createWithResource(context, R.drawable.ic_shortcut_task))
                .setIntent(CaptureActivity.intent(context, "task", last.project))
                .build(),
        )
        try { manager.dynamicShortcuts = dynamic } catch (_: Exception) {}
    }
}
