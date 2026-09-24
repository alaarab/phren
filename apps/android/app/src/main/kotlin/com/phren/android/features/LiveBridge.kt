package com.phren.android.features

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.phren.android.AppModel
import com.phren.android.StoreProject
import com.phren.android.design.LocalDismiss
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenEmptyState
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenNavigator

/**
 * Seams to the sections still being ported (computers, schedules, code,
 * skills, knobs, tasks). Each entry is replaced by the real screen as its
 * section lands; until then they say so rather than pretend.
 */
object LiveBridge {
    fun hasComputer(model: AppModel): Boolean = false
    fun allowsSchedules(): Boolean = true
    fun showsCode(model: AppModel): Boolean = true
    fun takePendingProject(): Pair<String, String>? = null
    fun connectComputer(navigator: PhrenNavigator) = navigator.push("connect-computer") { Pending("Add computer") }

    @Composable fun AddProjectView(onAdded: (String) -> Unit) = Pending("Add project")
    @Composable fun VoiceCaptureView(targets: List<StoreProject>) = Pending("Capture")
    @Composable fun ProjectComputerRows(storeId: String, project: String) {}
    @Composable fun SkillsView(project: String, storeId: String) = Pending("Skills")
    @Composable fun TaskListView(storeId: String, project: String) = com.phren.android.features.TaskListView(storeId, project)
    @Composable fun LaunchSessionView(storeId: String, project: String, request: TaskAgentRequest) = Pending("Start agent")
    @Composable fun ProjectKnobsView(storeId: String, project: String) = Pending("Knobs")
    @Composable fun SchedulesView(storeId: String, project: String) = Pending("Schedules")
    @Composable fun CodeView(storeId: String, project: String) = Pending("Code")
    @Composable fun FilesView() = Pending("Files")

    @Composable
    fun Pending(title: String) {
        val navigator = LocalNavigator.current
        val back = LocalDismiss.current ?: navigator::pop
        PhrenNavScreen(title, onBack = back) {
            PhrenEmptyState(title, "This screen is still being ported.", Modifier.fillMaxSize())
        }
    }
}
