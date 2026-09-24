package com.phren.android.features

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.phren.android.design.LocalDismiss
import com.phren.android.design.PhrenColorButton
import com.phren.android.design.PhrenColorSheet
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenDialog
import com.phren.android.design.PhrenFieldSurface
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenSheetHeader
import com.phren.android.design.PhrenStepSlider
import com.phren.android.design.PhrenTextField
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.medium
import com.phren.android.design.PhrenType.semibold
import com.phren.android.design.SF
import com.phren.android.design.SectionLabel
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.design.sessionCard
import com.phren.kit.PendingOp
import com.phren.kit.ProjectKnobs

/**
 * ProjectKnobsView.swift: per-project overrides of the knobs the CLI reads
 * from `phren.project.yaml`, each with "Inherit global" (the key removed).
 * Every change saves at once, so the header has only Done.
 */
@Composable
fun ProjectKnobsView(storeId: String, project: String) {
    val model = LocalModel.current
    val dismiss = LocalDismiss.current ?: {}
    val snapshot = model.snapshot(storeId)
    var knobs by remember { mutableStateOf(snapshot.projectKnobs[project] ?: ProjectKnobs()) }
    var expected by remember { mutableStateOf(snapshot.projectConfigs[project]) }
    var nameColour by remember { mutableStateOf(ProjectNameColor.stored(model, storeId, project)) }
    var nameHex by remember { mutableStateOf(nameColour.hexValue?.drop(1) ?: "") }
    var confirmingReset by remember { mutableStateOf(false) }
    var showingColor by remember { mutableStateOf(false) }

    fun save(new: ProjectKnobs) {
        if (new == knobs) return
        val previous = expected
        expected = new.apply(previous ?: "")
        knobs = new
        model.perform(PendingOp.SetProjectKnobs(project, new, previous), storeId)
    }
    fun chooseColour(value: ProjectNameColor) {
        nameColour = value
        nameHex = value.hexValue?.drop(1) ?: ""
        ProjectNameColor.set(model, value, storeId, project)
    }
    fun <V : Enum<V>> inherited(values: List<V>) = listOf(PhrenOption<V?>(id = "inherit", value = null, title = "Inherit global")) +
        values.map { PhrenOption<V?>(id = it.name, value = it, title = it.name.replaceFirstChar { c -> c.uppercase() }) }
    // Sliders ascend: low on the left, high on the right.
    val proactivity = inherited(ProjectKnobs.Proactivity.entries.reversed())

    Column(Modifier.fillMaxSize().background(PhrenTheme.bg).phrenIdentifier("project-knobs")) {
        PhrenSheetHeader("Knobs") { dismiss() }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)) {
            SectionLabel("Findings", Modifier.phrenIdentifier("knobs-section:findings"))
            KnobSlider("Finding sensitivity", inherited(ProjectKnobs.FindingSensitivity.entries), knobs.findingSensitivity, "findingSensitivity") { save(knobs.copy(findingSensitivity = it)) }
            SectionLabel("Proactivity", Modifier.phrenIdentifier("knobs-section:proactivity"))
            KnobSlider("Proactivity", proactivity, knobs.proactivity, "proactivity") { save(knobs.copy(proactivity = it)) }
            KnobSlider("Proactivity for findings", proactivity, knobs.proactivityFindings, "proactivityFindings") { save(knobs.copy(proactivityFindings = it)) }
            KnobSlider("Proactivity for tasks", proactivity, knobs.proactivityTask, "proactivityTask") { save(knobs.copy(proactivityTask = it)) }
            SectionLabel("Tasks", Modifier.phrenIdentifier("knobs-section:tasks"))
            KnobSlider("Task mode", inherited(ProjectKnobs.TaskMode.entries), knobs.taskMode, "taskMode") { save(knobs.copy(taskMode = it)) }
            SectionLabel("Appearance", Modifier.phrenIdentifier("knobs-section:appearance"))

            // The project name's color: the theme's own, the computer palette, or any color.
            Column(Modifier.fillMaxWidth().sessionCard().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Name color", style = PhrenType.body, color = PhrenTheme.text, modifier = Modifier.weight(1f))
                    Text(project, style = PhrenType.subheadline.semibold(), color = nameColour.color, maxLines = 1, modifier = Modifier.phrenIdentifier("knob-value:nameColour"))
                }
                val choices = listOf(PhrenOption<ProjectNameColor>(id = "default", value = ProjectNameColor.Default, title = "Default")) +
                    ProjectNameColor.PALETTE.mapIndexed { i, hex -> PhrenOption<ProjectNameColor>(id = hex, value = ProjectNameColor.Hex(hex), title = ProjectNameColor.PALETTE_NAMES[i]) }
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 2.dp).phrenIdentifier("knob:nameColour"), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (choice in choices) {
                        Box(Modifier.size(40.dp).plainClickable { chooseColour(choice.value) }.phrenIdentifier("knob:nameColour:${choice.id}"), contentAlignment = Alignment.Center) {
                            Box(Modifier.size(28.dp).background(choice.value.color, CircleShape))
                            if (choice.value == nameColour) Box(Modifier.size(34.dp).border(2.dp, PhrenTheme.text, CircleShape))
                        }
                    }
                }
                Row(Modifier.heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    PhrenColorButton("Custom", nameColour.color, "knob:nameColour:custom") { showingColor = true }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("#", style = PhrenType.monoCaption, color = PhrenTheme.textDim)
                        Box(Modifier.width(80.dp)) {
                            PhrenTextField("RRGGBB", nameHex, { nameHex = it }, identifier = "knob:nameColour:hex", monospaced = true, surface = PhrenFieldSurface.BARE,
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Done))
                        }
                    }
                    Spacer(Modifier.weight(1f))
                }
                androidx.compose.runtime.LaunchedEffect(nameHex) {
                    // Submitted with the keyboard's Done on iOS; a valid six-digit value applies here.
                    ProjectNameColor.normalized(nameHex)?.takeIf { nameHex.length == 6 && it != nameColour.hexValue }?.let { chooseColour(ProjectNameColor.Hex(it)) }
                }
            }

            Column(Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(min = 44.dp).sessionCard().plainClickable { confirmingReset = true }
                .phrenIdentifier("knobs-reset").padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Reset", style = PhrenType.body, color = PhrenTheme.danger)
                Text("Clear every override for this project", style = PhrenType.caption, color = PhrenTheme.textMuted, maxLines = 1)
            }
        }
    }
    if (showingColor) PhrenColorSheet("Name color", nameColour.color, { c ->
        fun channel(v: Float) = (v.coerceIn(0f, 1f) * 255).toInt()
        chooseColour(ProjectNameColor.Hex("#%02X%02X%02X".format(channel(c.red), channel(c.green), channel(c.blue))))
    }, "knob-name-color-editor") { showingColor = false }
    if (confirmingReset) PhrenDialog("Reset all knobs?",
        "Clear every override so the project follows your global settings, and restore the default name color.", listOf(
            PhrenControlAction("reset", "Reset", role = PhrenControlAction.Role.DESTRUCTIVE) { chooseColour(ProjectNameColor.Default); save(ProjectKnobs()) },
            PhrenControlAction("keep", "Keep", role = PhrenControlAction.Role.CANCEL) {},
        ), identifier = "knobs-reset-dialog") { confirmingReset = false }
}

/** One knob per card: title and current value, a reset glyph when overridden, then every stop. */
@Composable
private fun <V> KnobSlider(title: String, options: List<PhrenOption<V?>>, selection: V?, key: String, onSelect: (V?) -> Unit) {
    val current = options.firstOrNull { it.value == selection }?.title ?: ""
    Column(Modifier.fillMaxWidth().sessionCard().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = PhrenType.body, color = PhrenTheme.text, maxLines = 1, modifier = Modifier.weight(1f))
            Text(current, style = PhrenType.subheadline.medium(), color = if (selection == null) PhrenTheme.textMuted else PhrenTheme.accent, maxLines = 1,
                modifier = Modifier.phrenIdentifier("knob-value:$key"))
            if (selection != null) {
                Box(Modifier.size(32.dp).plainClickable { onSelect(null) }.phrenIdentifier("knob-reset:$key"), contentAlignment = Alignment.Center) {
                    Icon(SF("arrow.counterclockwise"), "Inherit global ${title.lowercase()}", tint = PhrenTheme.textMuted, modifier = Modifier.size(14.dp))
                }
            }
        }
        PhrenStepSlider(options, selection, onSelect, identifier = "knob:$key")
    }
}

@Suppress("unused") private val keepColor = Color.Unspecified
