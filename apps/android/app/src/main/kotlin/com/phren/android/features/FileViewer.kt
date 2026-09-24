package com.phren.android.features

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.widget.MediaController
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import com.phren.android.design.LocalDismiss
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenActionSheet
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenFileTypeIcon
import com.phren.android.design.PhrenIconButton
import com.phren.android.design.PhrenRow
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.semibold
import com.phren.android.design.SF
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.android.design.tabBarSafeArea
import com.phren.kit.FileCSVPage
import com.phren.kit.FilePreviewKind
import com.phren.kit.FileTextCursor
import com.phren.kit.FileTextPage
import com.phren.kit.PhrenKitError
import com.phren.kit.SyntaxTokenizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.security.MessageDigest
import kotlin.math.abs

/**
 * What the viewer shows: a local file, or bytes loaded on demand. Remote
 * computer files join with the agents section (FileViewerItem).
 */
class FileViewerItem(val name: String, val local: File? = null, val previewKind: FilePreviewKind? = null, val contentType: String? = null,
                     val load: (suspend () -> ByteArray)? = null) {
    val id: String = local?.path ?: "load/$name/${System.identityHashCode(this)}"
}

private fun viewerDirectory(context: android.content.Context, identity: String): File {
    val key = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray()).joinToString("") { "%02x".format(it) }
    return File(context.cacheDir, "file-viewer/$key").apply { mkdirs() }
}

private fun safeName(name: String) = name.substringAfterLast('/').let { if (it in setOf("", ".", "..", ".download.json")) "file" else it }

/** Every file the app opens uses this entry point (FileViewer.swift). */
@Composable
fun FileViewer(item: FileViewerItem, actions: List<PhrenControlAction> = emptyList()) {
    val context = LocalContext.current
    val navigator = LocalNavigator.current
    val dismiss = LocalDismiss.current ?: navigator::pop
    var file by remember { mutableStateOf<File?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var showingActions by remember { mutableStateOf(false) }
    var chromeHidden by remember { mutableStateOf(false) }
    LaunchedEffect(item.id) {
        try {
            file = item.local ?: withContext(Dispatchers.IO) {
                val out = File(viewerDirectory(context, item.id), safeName(item.name))
                out.writeBytes(item.load!!.invoke()); out
            }
        } catch (e: Exception) { error = e.message }
    }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val f = file ?: return@rememberLauncherForActivityResult
        uri?.let { runCatching { context.contentResolver.openOutputStream(it)?.use { out -> f.inputStream().use { input -> input.copyTo(out) } } } }
    }
    fun share() {
        val f = file ?: return
        val shareable = if (f.path.startsWith(File(context.cacheDir, "file-viewer").path)) f
            else File(viewerDirectory(context, "share/" + f.path), f.name).also { f.copyTo(it, overwrite = true) }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", shareable)
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(context.contentResolver.getType(uri) ?: "*/*")
            .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
    }
    val kind = item.previewKind ?: FilePreviewKind.detect(item.name, item.contentType)

    @Composable
    fun Header(modifier: Modifier) {
        Row(modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).heightIn(min = 56.dp).padding(start = 16.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(item.name, style = PhrenType.subheadline.semibold(), color = PhrenTheme.text, maxLines = 2, modifier = Modifier.weight(1f))
            if (actions.isNotEmpty()) PhrenIconButton(SF("ellipsis"), "File actions", modifier = Modifier.phrenIdentifier("file-actions")) { showingActions = true }
            if (file != null) {
                PhrenIconButton(SF("square.and.arrow.down"), "Save to Files", modifier = Modifier.phrenIdentifier("file-viewer-save")) { saver.launch(item.name) }
                PhrenIconButton(SF("square.and.arrow.up"), "Share file", modifier = Modifier.phrenIdentifier("file-viewer-share")) { share() }
            }
            PhrenIconButton(SF("xmark"), "Close file", modifier = Modifier.phrenIdentifier("file-viewer-close")) { dismiss() }
        }
    }

    val f = file
    if (f != null && kind == FilePreviewKind.IMAGE) {
        // The picture gets the whole screen on black; the header floats over it.
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            ZoomableImage(f, onTap = { chromeHidden = !chromeHidden }, onDismiss = dismiss)
            if (!chromeHidden) Header(Modifier.background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.72f), Color.Transparent))))
        }
    } else {
        Column(Modifier.fillMaxSize().background(PhrenTheme.bg)) {
            Header(Modifier.background(PhrenTheme.surface))
            Box(Modifier.weight(1f)) {
                when {
                    f == null -> Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically)) {
                        PhrenFileTypeIcon(item.name)
                        Text(error ?: "Downloading file…", style = PhrenType.body, color = PhrenTheme.text)
                    }
                    kind == FilePreviewKind.VIDEO || kind == FilePreviewKind.AUDIO -> MediaView(f)
                    kind == FilePreviewKind.PDF -> PdfView(f)
                    kind in setOf(FilePreviewKind.MARKDOWN, FilePreviewKind.CODE, FilePreviewKind.JSON, FilePreviewKind.CSV, FilePreviewKind.TEXT) -> FileTextView(f, kind)
                    else -> Column(Modifier.fillMaxSize().padding(24.dp).phrenIdentifier("file-viewer-file"), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically)) {
                        PhrenFileTypeIcon(item.name)
                        Text(item.name, style = PhrenType.body, color = PhrenTheme.text)
                        Text(item.contentType ?: "File", style = PhrenType.body, color = PhrenTheme.textMuted)
                        PhrenRow(SF("square.and.arrow.down"), "Save to Files", chevron = false) { saver.launch(item.name) }
                        PhrenRow(SF("square.and.arrow.up"), "Share", chevron = false) { share() }
                    }
                }
            }
        }
    }
    if (showingActions) PhrenActionSheet("File actions", actions, identifier = "file-actions-sheet") { showingActions = false }
}

/** Pinch to zoom up to the image's own pixels (at least 4×), pan within bounds, drag down at 1× to close (PhrenImageViewer). */
@Composable
private fun ZoomableImage(file: File, onTap: () -> Unit, onDismiss: () -> Unit) {
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(file) { bitmap = withContext(Dispatchers.IO) { BitmapFactory.decodeFile(file.path) } }
    val image = bitmap ?: return
    BoxWithConstraints(Modifier.fillMaxSize().phrenIdentifier("image-viewer")) {
        val density = androidx.compose.ui.platform.LocalDensity.current
        val viewW = with(density) { maxWidth.toPx() }
        val viewH = with(density) { maxHeight.toPx() }
        val fit = minOf(1f, viewW / image.width, viewH / image.height)
        val maxZoom = maxOf(4f, 1f / fit)
        var zoom by remember { mutableFloatStateOf(1f) }
        var offset by remember { mutableStateOf(Offset.Zero) }
        var dismissDrag by remember { mutableFloatStateOf(0f) }
        fun clamp(o: Offset, z: Float): Offset {
            val bx = maxOf(0f, (image.width * fit * z - viewW) / 2)
            val by = maxOf(0f, (image.height * fit * z - viewH) / 2)
            return Offset(o.x.coerceIn(-bx, bx), o.y.coerceIn(-by, by))
        }
        Image(image.asImageBitmap(), null, contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize()
                .pointerInput(Unit) {
                    detectTapGestures(onTap = { onTap() }, onDoubleTap = { zoom = if (zoom > 1.01f) 1f else minOf(maxZoom, 2.5f); offset = clamp(offset, zoom) })
                }
                .pointerInput(maxZoom) {
                    detectTransformGestures { _, pan, gesture, _ ->
                        if (zoom <= 1.0001f && gesture == 1f && pan.y > abs(pan.x)) {
                            dismissDrag += pan.y
                            if (dismissDrag >= maxOf(80f, minOf(160f, viewH * 0.18f)) * density.density) onDismiss()
                        } else {
                            zoom = (zoom * gesture).coerceIn(1f, maxZoom)
                            offset = clamp(offset + pan, zoom)
                        }
                    }
                }
                .graphicsLayer { scaleX = zoom; scaleY = zoom; translationX = offset.x; translationY = offset.y + dismissDrag })
    }
}

@Composable
private fun MediaView(file: File) {
    AndroidView(factory = { ctx ->
        VideoView(ctx).apply {
            setMediaController(MediaController(ctx).also { it.setAnchorView(this) })
            setVideoURI(Uri.fromFile(file))
            setOnPreparedListener { start() }
        }
    }, modifier = Modifier.fillMaxSize().background(Color.Black).phrenIdentifier("file-viewer-media"))
}

@Composable
private fun PdfView(file: File) {
    val pages = remember { mutableStateListOf<Bitmap>() }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(file) {
        withContext(Dispatchers.IO) {
            try {
                ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                    PdfRenderer(fd).use { renderer ->
                        for (i in 0 until minOf(renderer.pageCount, 200)) {
                            renderer.openPage(i).use { page ->
                                val scale = 1080f / page.width
                                val bmp = Bitmap.createBitmap(1080, (page.height * scale).toInt(), Bitmap.Config.ARGB_8888)
                                bmp.eraseColor(android.graphics.Color.WHITE)
                                page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                withContext(Dispatchers.Main) { pages += bmp }
                            }
                        }
                    }
                }
            } catch (e: Exception) { error = e.message }
        }
    }
    error?.let { Text(it, style = PhrenType.body, color = PhrenTheme.warning, modifier = Modifier.padding(16.dp)); return }
    LazyColumn(Modifier.fillMaxSize().phrenIdentifier("file-viewer-pdf"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        itemsIndexed(pages) { _, bmp ->
            Image(bmp.asImageBitmap(), null, modifier = Modifier.fillMaxWidth().aspectRatio(bmp.width.toFloat() / bmp.height))
        }
    }
}

// MARK: Text (FileTextView.swift)

private sealed interface JsonNode {
    data class Obj(val entries: List<Pair<String, JsonNode>>) : JsonNode
    data class Arr(val items: List<JsonNode>) : JsonNode
    data class Value(val text: String) : JsonNode

    val children: List<Pair<String, JsonNode>> get() = when (this) {
        is Obj -> entries; is Arr -> items.mapIndexed { i, n -> "$i" to n }; is Value -> emptyList()
    }
    val summary: String get() = when (this) {
        is Obj -> "{ ${entries.size} keys }"; is Arr -> "[ ${items.size} items ]"; is Value -> text
    }

    companion object {
        fun make(e: JsonElement, depth: Int): JsonNode {
            if (depth >= 64) throw PhrenKitError.Validation("This JSON is nested too deeply. Save or share the file to read it elsewhere.")
            return when (e) {
                is JsonObject -> Obj(e.keys.sorted().map { it to make(e.getValue(it), depth + 1) })
                is JsonArray -> Arr(e.map { make(it, depth + 1) })
                else -> Value(e.toString())
            }
        }
    }
}

@Composable
private fun FileTextView(file: File, kind: FilePreviewKind) {
    var text by remember { mutableStateOf("") }
    var csv by remember { mutableStateOf<List<List<String>>>(emptyList()) }
    var json by remember { mutableStateOf<JsonNode?>(null) }
    var cursor by remember { mutableStateOf(FileTextCursor()) }
    var next by remember { mutableStateOf(FileTextCursor()) }
    val history = remember { mutableStateListOf<FileTextCursor>() }
    var eof by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var page by remember { mutableIntStateOf(0) }
    var expanded by remember { mutableStateOf(true) }
    LaunchedEffect(page) {
        loading = true; error = null
        try {
            val position = cursor
            withContext(Dispatchers.IO) {
                when {
                    kind == FilePreviewKind.CSV -> {
                        val p = FileCSVPage.read(file, position.offset)
                        csv = p.rows; next = FileTextCursor(offset = p.nextOffset); eof = p.eof
                    }
                    // A bounded JSON document folds per node; larger ones page through a streaming pretty printer.
                    kind == FilePreviewKind.JSON && position.offset == 0L && file.length() <= 1_048_576 -> {
                        json = JsonNode.make(Json.parseToJsonElement(file.readText()), 0); next = position; eof = true
                    }
                    else -> {
                        val p = FileTextPage.read(file, position, json = kind == FilePreviewKind.JSON)
                        text = p.text; next = p.next; eof = p.eof
                    }
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) { error = e.message }
        loading = false
    }
    Column(Modifier.fillMaxSize().phrenIdentifier("file-viewer-${kind.rawValue}")) {
        error?.let { Text(it, style = PhrenType.body, color = PhrenTheme.warning, modifier = Modifier.padding(16.dp)) }
        Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState())) {
            val j = json
            when {
                kind == FilePreviewKind.CSV -> Column {
                    csv.forEachIndexed { r, fields ->
                        Row {
                            fields.forEach { field ->
                                SelectionContainer {
                                    Text(field, style = PhrenType.monoFootnote, color = PhrenTheme.text,
                                        modifier = Modifier.width(180.dp).background(if (r == 0 && page == 0) PhrenTheme.surfaceRaised else PhrenTheme.surface)
                                            .border(0.5.dp, PhrenTheme.border).padding(10.dp))
                                }
                            }
                        }
                    }
                }
                j != null -> Box(Modifier.padding(16.dp)) { JsonRow(j, null, "root") }
                kind == FilePreviewKind.MARKDOWN -> RichText(text, modifier = Modifier.width(380.dp).padding(16.dp))
                else -> Column(Modifier.padding(16.dp)) {
                    if (kind == FilePreviewKind.JSON) Row(Modifier.heightIn(min = 44.dp).plainClickable { expanded = !expanded }.phrenIdentifier("file-json-page-fold"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(SF(if (expanded) "chevron.down" else "chevron.right"), null, tint = PhrenTheme.text, modifier = Modifier.size(14.dp))
                        Text("JSON page ${page + 1}", style = PhrenType.subheadline, color = PhrenTheme.text)
                    }
                    if (kind != FilePreviewKind.JSON || expanded) SelectionContainer {
                        Text(CodeHighlighting.highlightedBlock(text, SyntaxTokenizer.Language.detect(if (kind == FilePreviewKind.JSON) "json" else file.extension)),
                            style = PhrenType.monoFootnote.copy(color = PhrenTheme.text), softWrap = false)
                    }
                }
            }
        }
        if (json == null) Row(Modifier.fillMaxWidth().background(PhrenTheme.surface).tabBarSafeArea().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            PhrenIconButton(SF("chevron.left"), "Previous text page", enabled = history.isNotEmpty() && !loading, modifier = Modifier.phrenIdentifier("file-text-previous")) {
                cursor = history.removeAt(history.lastIndex); page -= 1
            }
            Spacer(Modifier.weight(1f))
            Text(if (loading) "Reading…" else "Page ${page + 1}", style = PhrenType.monoCaption, color = PhrenTheme.text)
            Spacer(Modifier.weight(1f))
            PhrenIconButton(SF("chevron.right"), "Next text page", enabled = !eof && !loading, modifier = Modifier.phrenIdentifier("file-text-next")) {
                history += cursor; cursor = next; page += 1
            }
        }
    }
}

@Composable
private fun JsonRow(node: JsonNode, label: String?, identity: String) {
    var expanded by remember { mutableStateOf(true) }
    var visible by remember { mutableIntStateOf(100) }
    val prefix = label?.let { "$it: " } ?: ""
    Column {
        if (node.children.isEmpty()) {
            SelectionContainer { Text(prefix + node.summary, style = PhrenType.monoFootnote, color = PhrenTheme.text, modifier = Modifier.padding(vertical = 4.dp)) }
        } else {
            Row(Modifier.heightIn(min = 44.dp).plainClickable { expanded = !expanded }.phrenIdentifier("file-json-fold:$identity"),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(SF("chevron.down"), null, tint = PhrenTheme.text, modifier = Modifier.size(12.dp).rotate(if (expanded) 0f else -90f))
                Text(prefix + node.summary, style = PhrenType.monoFootnote, color = PhrenTheme.text)
            }
            if (expanded) Column(Modifier.padding(start = 18.dp)) {
                node.children.take(visible).forEachIndexed { i, (key, child) -> JsonRow(child, key, "$identity/$i") }
                if (node.children.size > visible) Text("Show next 100 items", style = PhrenType.body, color = PhrenTheme.navigation,
                    modifier = Modifier.heightIn(min = 44.dp).plainClickable { visible += 100 }.padding(vertical = 12.dp))
            }
        }
    }
}

@Suppress("unused") private val keepHeight = Modifier.height(0.dp).fillMaxHeight()
@Suppress("unused") private val keepShape = CircleShape
