package com.phren.android.features

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import com.phren.android.design.PhrenTheme
import com.phren.kit.GraphPayload
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

data class GraphCommand(val action: Action, val id: String = UUID.randomUUID().toString()) {
    sealed interface Action {
        data object Reset : Action
        data object ZoomIn : Action
        data object ZoomOut : Action
        data object Clear : Action
        data class Focus(val id: String) : Action
        data class Reveal(val id: String) : Action
    }
}

sealed interface GraphAction {
    data class Select(val id: String) : GraphAction
    data class Focus(val id: String) : GraphAction
    data class OpenProject(val id: String) : GraphAction
    data class Share(val id: String) : GraphAction
    data class Edit(val id: String) : GraphAction
    data class Delete(val id: String) : GraphAction
    data object Close : GraphAction
}

/** The fields the page sends back for a selected node (GraphNodeRef). */
@Serializable
data class GraphNodeRef(
    val id: String,
    val kind: String? = null,
    val group: String? = null,
    val project: String? = null,
    val store: String? = null,
    val label: String? = null,
    val fullLabel: String? = null,
    val text: String? = null,
    val scoreKey: String? = null,
    val editedText: String? = null,
    val editedSection: String? = null,
    val editedPriority: String? = null,
) {
    val isTask get() = kind == "task" || group?.startsWith("task-") == true
    val isFinding get() = kind == "finding" || group?.startsWith("topic:") == true
    val isProject get() = group == "project"
    val sourceText get() = fullLabel ?: text

    companion object {
        fun of(node: GraphPayload.Node) = GraphNodeRef(node.id, group = node.group, project = node.project, store = node.store,
            label = node.label, fullLabel = node.fullLabel, scoreKey = node.scoreKey)
    }
}

@Serializable private data class GraphActionMessage(val action: String, val id: String = "")

private val json = Json { ignoreUnknownKeys = true }
private const val HOST = "appassets.androidplatform.net"

/**
 * GraphWebView.swift: the shared renderer page in one WebView kept for the
 * host's lifetime. Payloads and commands go through JavaScript, never a
 * reload. The page talks to WKWebView's `window.webkit.messageHandlers`; a
 * shim injected ahead of its scripts routes those to this bridge.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun GraphWebView(
    payload: GraphPayload,
    command: GraphCommand?,
    onSelect: (GraphNodeRef?) -> Unit,
    onAction: (GraphAction) -> Unit,
    onError: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val host = remember { GraphHost() }
    host.onSelect = onSelect
    host.onAction = onAction
    host.onError = onError
    host.pendingPayload = payload
    host.pendingCommand = command
    DisposableEffect(Unit) {
        onDispose {
            host.timeout?.let { host.main.removeCallbacks(it) }
            host.webView?.evaluateJavascript("window.phrenGraph && window.phrenGraph.destroy && window.phrenGraph.destroy();", null)
            host.webView?.destroy()
            host.webView = null
        }
    }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                // WRAP_CONTENT (the default) sizes the page to its content, and
                // this page's content is 100% tall: it collapses to 0.
                layoutParams = android.view.ViewGroup.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT)
                setBackgroundColor(PhrenTheme.bg.toArgb())
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.domStorageEnabled = false
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                addJavascriptInterface(host, "PhrenAndroid")
                webViewClient = host.client
                if (com.phren.android.BuildConfig.DEBUG) {
                    WebView.setWebContentsDebuggingEnabled(true)
                    webChromeClient = object : android.webkit.WebChromeClient() {
                        override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                            android.util.Log.d("PhrenGraph", "${message.message()} @${message.lineNumber()}")
                            return true
                        }
                    }
                }
                host.webView = this
                host.startTimeout()
                loadUrl("https://$HOST/graph/index.html")
            }
        },
        update = { host.renderIfReady() },
    )
}

private class GraphHost {
    val main = Handler(Looper.getMainLooper())
    var webView: WebView? = null
    var pendingPayload: GraphPayload? = null
    var pendingCommand: GraphCommand? = null
    var onSelect: (GraphNodeRef?) -> Unit = {}
    var onAction: (GraphAction) -> Unit = {}
    var onError: (String) -> Unit = {}
    var timeout: Runnable? = null
    private var ready = false
    private var rendering = false
    private var lastRendered: GraphPayload? = null
    private var lastCommand: String? = null
    private var attempts = 0

    fun startTimeout() {
        val task = Runnable { if (!ready) onError("The graph took too long to load. Try opening it again.") }
        timeout = task
        main.postDelayed(task, 20_000)
    }

    fun renderIfReady() {
        val view = webView ?: return
        val payload = pendingPayload ?: return
        if (!ready || rendering) return
        if (payload == lastRendered) { runCommand(); return }
        rendering = true
        val text = try { payload.jsonString() } catch (_: Exception) { null }
        if (text == null) { rendering = false; onError("The graph data couldn't be read."); return }
        view.evaluateJavascript("(function(){try{window.phrenHost.render($text);return 'ok'}catch(e){return 'error: '+e}})()") { result ->
            if (com.phren.android.BuildConfig.DEBUG) android.util.Log.d("PhrenGraph", "render ${payload.nodes.size} nodes: $result")
            rendering = false
            if (result?.contains("ok") == true) {
                attempts = 0
                lastRendered = payload
                renderIfReady()
            } else if (attempts < 2) {
                attempts += 1
                main.postDelayed({ renderIfReady() }, 300L * attempts)
            } else {
                attempts = 0
                onError("The graph couldn't be drawn. Try opening it again.")
            }
        }
    }

    private fun runCommand() {
        val command = pendingCommand ?: return
        val view = webView ?: return
        if (command.id == lastCommand) return
        lastCommand = command.id
        fun quote(s: String) = kotlinx.serialization.json.JsonPrimitive(s).toString()
        val call = when (val a = command.action) {
            GraphCommand.Action.Reset -> "reset(null)"
            GraphCommand.Action.ZoomIn -> "zoom(1.4)"
            GraphCommand.Action.ZoomOut -> "zoom(${1 / 1.4})"
            GraphCommand.Action.Clear -> "clear(null)"
            is GraphCommand.Action.Focus -> "focusNode(${quote(a.id)})"
            is GraphCommand.Action.Reveal -> "revealNode(${quote(a.id)})"
        }
        view.evaluateJavascript("(function(){try{window.phrenHost.$call;return 'ok'}catch(e){return 'error'}})()") { result ->
            if (result?.contains("error") == true) onError("That graph control couldn't be applied. Try opening the graph again.")
        }
    }

    @JavascriptInterface
    fun post(name: String, body: String?) {
        main.post { receive(name, body) }
    }

    private fun receive(name: String, body: String?) {
        when (name) {
            "graphReady" -> {
                timeout?.let { main.removeCallbacks(it) }
                ready = true
                renderIfReady()
            }
            "graphSelect" -> {
                if (body == null || body == "null") { onSelect(null); return }
                val node = try { json.decodeFromString(GraphNodeRef.serializer(), body) } catch (_: Exception) { return }
                onSelect(node)
            }
            "graphAction" -> {
                val message = try { json.decodeFromString(GraphActionMessage.serializer(), body ?: return) } catch (_: Exception) { return }
                when (message.action) {
                    "select" -> onAction(GraphAction.Select(message.id))
                    "focus" -> onAction(GraphAction.Focus(message.id))
                    "openProject" -> onAction(GraphAction.OpenProject(message.id))
                    "share" -> onAction(GraphAction.Share(message.id))
                    "edit" -> onAction(GraphAction.Edit(message.id))
                    "delete" -> onAction(GraphAction.Delete(message.id))
                    "close" -> onAction(GraphAction.Close)
                }
            }
            "graphError" -> onError("The graph renderer couldn't load. Try opening it again.")
        }
    }

    val client = object : WebViewClient() {
        /** Serves only the bundled graph directory; everything else is refused. */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (url.host != HOST) return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), "".byteInputStream())
            val path = url.path?.trimStart('/') ?: return null
            if (!path.startsWith("graph/") || path.contains("..")) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
            return try {
                val stream = view.context.assets.open(path)
                if (path.endsWith("index.html")) {
                    val html = stream.bufferedReader().readText().replaceFirst("<head>", "<head>$SHIM")
                    WebResourceResponse("text/html", "utf-8", html.byteInputStream())
                } else {
                    val mime = if (path.endsWith(".js")) "text/javascript" else "application/octet-stream"
                    WebResourceResponse(mime, "utf-8", stream)
                }
            } catch (_: Exception) {
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != HOST

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
            if (request.isForMainFrame) {
                timeout?.let { main.removeCallbacks(it) }
                onError("The graph couldn't be loaded. Try opening it again.")
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onError("The graph was closed to free memory. Tap Try again to reopen it.")
            webView = null
            return true
        }
    }

    companion object {
        /** WKWebView's message handlers, answered by the PhrenAndroid interface. */
        const val SHIM = "<script>window.webkit={messageHandlers:new Proxy({},{get:function(_,n){return{postMessage:function(b){PhrenAndroid.post(String(n),JSON.stringify(b===undefined?null:b))}}}})};</script>"
    }
}
