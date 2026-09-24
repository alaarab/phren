package com.phren.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import com.phren.kit.ColdDocRef

/** A destination pushed onto a tab's stack (NavigationStack values). */
sealed interface Route {
    val title: String

    data class ProjectDetail(val storeId: String, val project: String, override val title: String) : Route
    data class Archive(val storeId: String, val project: String) : Route { override val title = "Archive" }
    data class ArchiveTopic(val storeId: String, val topic: ColdDocRef) : Route { override val title get() = topic.displayName }
    data class Triage(val key: String) : Route { override val title = "Triage" }
    data class SettingsPage(val page: String, override val title: String) : Route
}

/** One NavigationStack: a root plus pushed routes, with UIKit-style push/pop slides. */
class NavStack(val rootTitle: String) {
    val routes = mutableStateListOf<Route>()
    fun push(route: Route) { routes += route }
    fun pop() { if (routes.isNotEmpty()) routes.removeAt(routes.lastIndex) }
    fun popToRoot() { routes.clear() }
    val backLabel: String get() = if (routes.size <= 1) rootTitle else routes[routes.size - 2].title
}

@Composable
fun rememberNavStack(rootTitle: String) = remember { NavStack(rootTitle) }

@Composable
fun NavHostStack(stack: NavStack, root: @Composable () -> Unit, destination: @Composable (Route) -> Unit) {
    val holder = rememberSaveableStateHolder()
    BackHandler(enabled = stack.routes.isNotEmpty()) { stack.pop() }
    val depth = stack.routes.size
    AnimatedContent(
        targetState = depth to stack.routes.lastOrNull(),
        transitionSpec = {
            val forward = targetState.first > initialState.first
            if (forward) {
                slideInHorizontally(tween(320)) { it } togetherWith slideOutHorizontally(tween(320)) { -it / 3 }
            } else {
                slideInHorizontally(tween(320)) { -it / 3 } togetherWith slideOutHorizontally(tween(320)) { it }
            }
        },
        label = "nav",
    ) { (d, route) ->
        Box(Modifier.fillMaxSize()) {
            holder.SaveableStateProvider("depth-$d-${route?.hashCode()}") {
                if (route == null) root() else destination(route)
            }
        }
    }
}
