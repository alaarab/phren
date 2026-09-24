package com.phren.android

import android.app.Application
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.phren.android.features.OnboardingFlow
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenNavigationStack
import com.phren.android.design.PhrenNavigator
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenTab
import com.phren.android.design.PhrenTabBar
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenMaterialTheme
import com.phren.android.design.SF
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.features.LiveBridge
import com.phren.android.features.LocalModel
import com.phren.android.features.ProjectsView
import com.phren.kit.KeychainStore

/** Process-wide owner of the one [AppModel] (the SwiftUI App struct's @State). */
class PhrenApplication : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        KeychainStore.backend = KeystoreTokenBackend(this)
        com.phren.android.design.PhrenAppearance.install(this)
        model = AppModel(this)
        // Live sync runs only while the app is visible; returning to the
        // foreground triggers an immediate catch-up pull.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { model.enterForeground() }
            override fun onStop(owner: LifecycleOwner) { model.enterBackground() }
        })
    }
}

val android.content.Context.phrenModel: AppModel get() = (applicationContext as PhrenApplication).model

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // The phren identity is dark-only.
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        val model = phrenModel
        val fixture = if (BuildConfig.DEBUG) intent?.getStringExtra("fixture") else null
        if (fixture != null) model.bootstrapFixture(fixture, intent.getBooleanExtra("agents", false), intent.getBooleanExtra("offline", false))
        else model.bootstrap()
        handleDeepLink(intent)
        setContent {
            PhrenMaterialTheme {
                RootView(model)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    /** Widget taps and shortcuts: `phren://projects|agents|tasks|review`. */
    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "phren") return
        val model = phrenModel
        when (uri.host) {
            "review" -> { model.selectedTab = AppTab.PROJECTS; model.showingMemoryMaintenance = true }
            "projects" -> model.selectedTab = AppTab.PROJECTS
            "agents" -> model.selectedTab = AppTab.AGENTS
            "tasks" -> model.selectedTab = AppTab.TASKS
        }
    }
}

@Composable
fun RootView(model: AppModel) {
    // GitHub is a memory connection, not the app's authentication boundary:
    // the tab hierarchy stays up when it signs out.
    CompositionLocalProvider(LocalModel provides model) { MainTabView(model) }
}

@Composable
private fun MainTabView(model: AppModel) {
    // Each tab keeps its own navigation stack across tab switches.
    val navigators = remember { AppTab.entries.associateWith { PhrenNavigator() } }
    val holder = rememberSaveableStateHolder()
    val ready = model.phase == AppModel.Phase.READY

    Box(Modifier.fillMaxSize().background(PhrenTheme.bg).semantics { testTagsAsResourceId = true }) {
        holder.SaveableStateProvider(model.selectedTab.name) {
            androidx.compose.runtime.CompositionLocalProvider(com.phren.android.design.LocalTabBarVisible provides true) {
            PhrenNavigationStack(navigators.getValue(model.selectedTab)) {
                when (model.selectedTab) {
                    AppTab.PROJECTS -> if (ready) ProjectsView() else OnboardingFlow(model)
                    AppTab.AGENTS -> com.phren.android.features.LiveSessionsView()
                    AppTab.TASKS -> if (ready) com.phren.android.features.TasksView() else MemoryConnectionPrompt("Tasks")
                    AppTab.MEMORY -> if (ready) com.phren.android.features.MemoryView() else MemoryConnectionPrompt("Memory")
                    AppTab.SETTINGS -> com.phren.android.features.SettingsView()
                }
            }
            }
        }
        Box(Modifier.align(Alignment.BottomCenter)) {
            PhrenTabBar(
                listOf(
                    PhrenTab(AppTab.PROJECTS, "Projects", SF("square.grid.2x2.fill"), identifier = "tab-projects"),
                    PhrenTab(AppTab.AGENTS, "Agents", SF("waveform.path"), identifier = "tab-agents"),
                    PhrenTab(AppTab.TASKS, "Tasks", SF("checklist"), identifier = "tab-tasks"),
                    PhrenTab(AppTab.MEMORY, "Memory", SF("point.3.connected.trianglepath.dotted"), identifier = "tab-memory"),
                    PhrenTab(AppTab.SETTINGS, "Settings", SF("gearshape.fill"), identifier = "tab-settings"),
                ),
                model.selectedTab,
            ) { tab ->
                // Re-tapping the current tab pops to root, like UITabBarController.
                if (tab == model.selectedTab) navigators.getValue(tab).popToRoot()
                model.selectedTab = tab
            }
        }
        if (model.showingMemoryConnection) PhrenSheet({ model.showingMemoryConnection = false }) { OnboardingFlow(model, isPresented = true) }
    }
    LaunchedEffect(model.phase) { if (ready) model.showingMemoryConnection = false }
    // This version's notes, once, after the store is connected so the sheet never covers onboarding.
    val context = androidx.compose.ui.platform.LocalContext.current
    var showingWhatsNew by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    LaunchedEffect(model.phase) {
        // Debug fixture stores (the UI-test data) never meet the sheet, as under iOS UI tests.
        val fixture = BuildConfig.DEBUG && model.storeContexts.any { it.descriptor.owner == "sample" }
        if (ready && !fixture && com.phren.android.features.ReleaseNotesStore.shouldPresent(context, model.prefs)) showingWhatsNew = true
    }
    if (showingWhatsNew) PhrenSheet({ showingWhatsNew = false; com.phren.android.features.ReleaseNotesStore.markSeen(model.prefs) }) { com.phren.android.features.WhatsNewSheet() }
}

@Composable
fun MemoryConnectionPrompt(title: String) {
    val model = LocalModel.current
    PhrenNavScreen(title) {
        Column(
            Modifier.fillMaxSize().padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterVertically),
        ) {
            Icon(SF("brain"), null, tint = PhrenTheme.accent, modifier = Modifier.size(46.dp))
            Text("Connect your project memory", style = PhrenType.title2.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = PhrenTheme.text, textAlign = TextAlign.Center)
            Text("Use GitHub to sync findings, skills, and tasks. Your agents and terminals connect directly to your computers.",
                style = PhrenType.callout, color = PhrenTheme.textMuted, textAlign = TextAlign.Center)
            Box(
                Modifier.heightIn(min = 44.dp).background(PhrenTheme.accentSolid, RoundedCornerShape(50))
                    .plainClickable { model.showingMemoryConnection = true }.phrenIdentifier("connect-memory").padding(horizontal = 18.dp),
                contentAlignment = Alignment.Center,
            ) { Text("Connect memory", style = PhrenType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = androidx.compose.ui.graphics.Color.White) }
        }
    }
}
