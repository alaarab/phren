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
import com.phren.android.ui.IosSpinner
import com.phren.android.ui.IosTabBar
import com.phren.android.ui.OnboardingFlow
import com.phren.android.ui.PhrenMaterialTheme
import com.phren.android.ui.PhrenTheme
import com.phren.android.ui.ProjectsScreen
import com.phren.android.ui.ReviewScreen
import com.phren.android.ui.SearchScreen
import com.phren.android.ui.SettingsScreen
import com.phren.android.ui.TabItem
import com.phren.android.ui.TasksScreen
import com.phren.android.ui.TriageScreen
import com.phren.android.ui.rememberNavStack
import com.phren.kit.KeychainStore

/** Process-wide owner of the one [AppModel] (the SwiftUI App struct's @State). */
class PhrenApplication : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        KeychainStore.backend = KeystoreTokenBackend(this)
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
        model.bootstrap()
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

    /** Widget taps: `phren://review`, `phren://tasks`. */
    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "phren") return
        when (uri.host) {
            "review" -> phrenModel.selectedTab = AppTab.REVIEW
            "tasks" -> phrenModel.selectedTab = AppTab.TASKS
        }
    }
}

@Composable
fun RootView(model: AppModel) {
    when (model.phase) {
        AppModel.Phase.LOADING -> Box(Modifier.fillMaxSize().background(PhrenTheme.bg), contentAlignment = Alignment.Center) { IosSpinner() }
        AppModel.Phase.SIGNED_OUT, AppModel.Phase.PICKING_REPO, AppModel.Phase.INITIAL_SYNC -> OnboardingFlow(model)
        AppModel.Phase.READY -> MainTabView(model)
    }
}

@Composable
private fun MainTabView(model: AppModel) {
    // Each tab keeps its own NavigationStack across tab switches.
    val projects = rememberNavStack("Projects")
    val search = rememberNavStack("Search")
    val settings = rememberNavStack("Settings")
    val holder = rememberSaveableStateHolder()
    var triage by remember { mutableStateOf<List<StoreQueueEntry>?>(null) }

    Box(Modifier.fillMaxSize().background(PhrenTheme.bg)) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) {
                holder.SaveableStateProvider(model.selectedTab.name) {
                    when (model.selectedTab) {
                        AppTab.PROJECTS -> ProjectsScreen(model, projects)
                        AppTab.REVIEW -> ReviewScreen(model) { triage = it }
                        AppTab.TASKS -> TasksScreen(model)
                        AppTab.SEARCH -> SearchScreen(model, search)
                        AppTab.SETTINGS -> SettingsScreen(model, settings)
                    }
                }
            }
            IosTabBar(
                listOf(
                    TabItem(AppTab.PROJECTS, "Projects", Icons.Outlined.GridView),
                    TabItem(AppTab.REVIEW, "Review", Icons.Outlined.Verified, model.totalReviewCount),
                    TabItem(AppTab.TASKS, "Tasks", Icons.Outlined.Checklist),
                    TabItem(AppTab.SEARCH, "Search", Icons.Outlined.Search),
                    TabItem(AppTab.SETTINGS, "Settings", Icons.Outlined.Settings),
                ),
                model.selectedTab,
            ) { tab ->
                // Re-tapping the current tab pops to root, like UITabBarController.
                if (tab == model.selectedTab) when (tab) {
                    AppTab.PROJECTS -> projects.popToRoot()
                    AppTab.SEARCH -> search.popToRoot()
                    AppTab.SETTINGS -> settings.popToRoot()
                    else -> {}
                }
                model.selectedTab = tab
            }
        }
        // `.fullScreenCover`
        triage?.let { deck -> TriageScreen(model, deck) { triage = null } }
    }
}
