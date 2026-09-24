package com.phren.android.design

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/*
 * NavigationSupport.swift: one navigation stack per tab, pushes that slide
 * like UINavigationController, the app-wide drag-anywhere Back, and page
 * sheets. Destinations are composables keyed by a stable string, so a
 * pushed screen keeps its saveable state while something sits over it.
 */

class NavEntry(val key: String, val content: @Composable () -> Unit)

class PhrenNavigator {
    val entries = mutableStateListOf<NavEntry>()
    /** Screens that own horizontal drags (graph, terminal) switch the pan off. */
    var panEnabled by mutableStateOf(true)

    fun push(key: String, content: @Composable () -> Unit) { entries += NavEntry(key, content) }
    fun pop() { if (entries.isNotEmpty()) entries.removeAt(entries.lastIndex) }
    fun popToRoot() { entries.clear() }
    /** Pops back to the nearest screen keyed [key]; false when none is on the stack. */
    fun pop(toKey: String): Boolean {
        val i = entries.dropLast(1).indexOfLast { it.key == toKey }
        if (i < 0) return false
        while (entries.size > i + 1) entries.removeAt(entries.lastIndex)
        return true
    }
    val depth get() = entries.size
}

val LocalNavigator = staticCompositionLocalOf { PhrenNavigator() }

/** The Back action a screen's chrome calls: pop, or close the sheet it sits in. */
val LocalDismiss = staticCompositionLocalOf<(() -> Unit)?> { null }

@Composable
fun rememberNavigator() = remember { PhrenNavigator() }

/**
 * A stack root plus its pushed screens. A rightward, mostly horizontal drag
 * anywhere pops (panToGoBack); the system back gesture pops too.
 */
@Composable
fun PhrenNavigationStack(navigator: PhrenNavigator = rememberNavigator(), root: @Composable () -> Unit) {
    val holder = rememberSaveableStateHolder()
    BackHandler(enabled = navigator.entries.isNotEmpty()) { navigator.pop() }
    CompositionLocalProvider(LocalNavigator provides navigator) {
        val depth = navigator.entries.size
        AnimatedContent(
            targetState = depth to navigator.entries.lastOrNull(),
            transitionSpec = {
                if (targetState.first > initialState.first) {
                    slideInHorizontally(tween(320)) { it } togetherWith slideOutHorizontally(tween(320)) { -it / 3 }
                } else {
                    slideInHorizontally(tween(320)) { -it / 3 } togetherWith slideOutHorizontally(tween(320)) { it }
                }
            },
            label = "nav",
        ) { (d, entry) ->
            Box(
                Modifier.fillMaxSize().background(PhrenTheme.bg)
                    .then(if (d > 0) Modifier.panToGoBack(navigator) else Modifier),
            ) {
                holder.SaveableStateProvider("$d:${entry?.key ?: "root"}") {
                    CompositionLocalProvider(LocalDismiss provides if (d > 0) navigator::pop else LocalDismiss.current) {
                        if (entry == null) root() else entry.content()
                    }
                }
            }
        }
    }
}

private fun Modifier.panToGoBack(navigator: PhrenNavigator): Modifier = pointerInput(navigator) {
    var dx = 0f
    var dy = 0f
    detectHorizontalDragGestures(
        onDragStart = { dx = 0f; dy = 0f },
        onDragEnd = { if (navigator.panEnabled && dx > 70.dp.toPx()) navigator.pop() },
    ) { change, amount -> dx += amount; dy += kotlin.math.abs(change.position.y - change.previousPosition.y) }
}

/**
 * A page sheet (`.sheet`): slides up over a dimmed app, rounded top corners,
 * its own navigation stack, dismissed by Back or a Cancel/Done in its header.
 */
@Composable
fun PhrenSheet(onDismiss: () -> Unit, fullScreen: Boolean = false, background: Color = PhrenTheme.bg, content: @Composable () -> Unit) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
            AnimatedVisibility(shown, enter = fadeIn(tween(250)), exit = fadeOut(tween(200))) {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.4f)))
            }
            AnimatedVisibility(shown, enter = slideInVertically(tween(320)) { it }, exit = slideOutVertically(tween(250)) { it }) {
                val shape = if (fullScreen) RoundedCornerShape(0.dp) else RoundedCornerShape(38.dp)
                Column(
                    Modifier.fillMaxSize()
                        .then(if (fullScreen) Modifier else Modifier.windowInsetsPadding(WindowInsets.statusBars))
                        .clip(shape).background(background).imePadding(),
                ) {
                    CompositionLocalProvider(LocalDismiss provides onDismiss, LocalTabBarVisible provides false) {
                        val navigator = rememberNavigator()
                        PhrenNavigationStack(navigator) {
                            CompositionLocalProvider(LocalDismiss provides onDismiss) { content() }
                        }
                    }
                }
            }
        }
    }
}
