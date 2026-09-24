package com.phren.android.features

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.LruCache
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.phren.android.design.IconSegmentItem
import com.phren.android.design.LocalDismiss
import com.phren.android.design.PhrenActionSheet
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenDialog
import com.phren.android.design.PhrenIconSegment
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.SF
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.phrenPanel
import com.phren.kit.LocalStore
import com.phren.kit.SkillFile
import com.phren.kit.SyntaxTokenizer
import kotlinx.coroutines.launch

// MARK: Highlighting (CodeHighlighting.swift)

object CodeHighlighting {
    fun color(kind: SyntaxTokenizer.Kind): Color = when (kind) {
        SyntaxTokenizer.Kind.COMMENT -> Color(0xFF8B949E)
        SyntaxTokenizer.Kind.STRING -> Color(0xFFA5D6FF)
        SyntaxTokenizer.Kind.NUMBER -> Color(0xFF79C0FF)
        SyntaxTokenizer.Kind.KEYWORD -> Color(0xFFFF7B72)
        SyntaxTokenizer.Kind.TYPE -> Color(0xFFFFA657)
        SyntaxTokenizer.Kind.FUNCTION -> Color(0xFFD2A8FF)
        SyntaxTokenizer.Kind.ATTRIBUTE -> Color(0xFF7EE787)
        SyntaxTokenizer.Kind.PUNCTUATION -> PhrenTheme.chatNeutral
    }

    private val cache = object : LruCache<String, AnnotatedString>(4_000_000) {
        override fun sizeOf(key: String, value: AnnotatedString) = key.length + 64
    }

    /** One line, tinted by token; plain text keeps the caller's color. */
    fun highlighted(line: String, language: SyntaxTokenizer.Language): AnnotatedString {
        if (language == SyntaxTokenizer.Language.PLAIN) return AnnotatedString(line)
        val key = "l${language.rawValue}\u0000$line"
        cache.get(key)?.let { return it }
        val value = buildAnnotatedString {
            append(line)
            for (token in SyntaxTokenizer.tokenize(line, language)) addStyle(SpanStyle(color = color(token.kind)), token.range.first, token.range.last + 1)
        }
        cache.put(key, value)
        return value
    }

    fun highlightedBlock(code: String, language: SyntaxTokenizer.Language): AnnotatedString {
        if (language == SyntaxTokenizer.Language.PLAIN) return AnnotatedString(code)
        return buildAnnotatedString {
            code.split("\n").forEachIndexed { i, line -> if (i > 0) append("\n"); append(highlighted(line, language)) }
        }
    }
}

// MARK: Document (ChatRichTextDocument.swift)

class RichTextDocument(text: String) {
    data class Block(val id: Int, val text: String, val language: String?, val heading: Boolean, val rows: List<List<String>> = emptyList())

    val blocks: List<Block> = parse(text)

    companion object {
        private val tableDivider = Regex("""^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$""")
        private val headingPattern = Regex("^#{1,6} ")

        private fun cells(line: String): List<String> {
            val parts = line.trim().split("|").toMutableList()
            if (parts.firstOrNull()?.isBlank() == true) parts.removeAt(0)
            if (parts.lastOrNull()?.isBlank() == true) parts.removeAt(parts.lastIndex)
            return parts.map { it.trim() }
        }

        private fun parse(text: String): List<Block> {
            val result = mutableListOf<Block>()
            val lines = mutableListOf<String>()
            var language: String? = null
            fun flush() {
                if (lines.isEmpty()) return
                val raw = lines.joinToString("\n")
                val content = if (language == null) raw.trim() else raw
                lines.clear()
                if (content.isEmpty()) return
                result += Block(result.size, content, language, false)
            }
            val source = text.split("\n")
            var i = 0
            while (i < source.size) {
                val line = source[i]
                when {
                    line.startsWith("```") -> { flush(); language = if (language == null) line.drop(3).trim() else null }
                    language == null && line.isBlank() -> flush()
                    language == null && headingPattern.containsMatchIn(line) -> {
                        flush(); result += Block(result.size, line.dropWhile { it == '#' || it == ' ' }, null, true)
                    }
                    language == null && line.trim().startsWith("|") && i + 1 < source.size && tableDivider.matches(source[i + 1]) -> {
                        flush()
                        val rows = mutableListOf(cells(line))
                        i += 2
                        while (i < source.size && source[i].trim().startsWith("|")) { rows += cells(source[i]); i++ }
                        val width = rows.maxOf { it.size }
                        result += Block(result.size, "", null, false, rows.map { it + List(width - it.size) { "" } })
                        continue
                    }
                    else -> lines += line
                }
                i++
            }
            flush()
            return result
        }
    }
}

fun copyToClipboard(context: Context, text: String, label: String = "phren") {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(label, text))
}

/**
 * ChatRichText.swift: prose paragraphs, headings, fenced code and pipe
 * tables in the transcript's monospaced type. Hold a paragraph for its menu
 * (copy it, select its text, copy the whole message).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun RichText(text: String, reply: String = text, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val document = remember(text) { RichTextDocument(text) }
    var menuFor by remember { mutableStateOf<RichTextDocument.Block?>(null) }
    var selecting by remember { mutableStateOf<Int?>(null) }
    val body = TextStyle(fontFamily = PhrenType.mono, fontSize = 14.5.sp, lineHeight = 21.sp, color = PhrenTheme.chatText)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (block in document.blocks) {
            when {
                block.language != null -> CodeBlock(block.text, block.language)
                block.rows.isNotEmpty() -> {
                    val shape = RoundedCornerShape(14.dp)
                    Box(Modifier.fillMaxWidth().background(PhrenTheme.chatPanel, shape).border(1.dp, PhrenTheme.border, shape)
                        .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = { menuFor = block }, onClick = {})
                        .horizontalScroll(rememberScrollState()).padding(12.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            for (column in block.rows.first().indices) {
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    block.rows.forEachIndexed { r, row ->
                                        Text(inlineMarkdown(row[column], PhrenTheme.chatInlineCode, PhrenTheme.chatPath),
                                            style = body.copy(fontWeight = if (r == 0) FontWeight.SemiBold else FontWeight.Normal, color = if (r == 0) PhrenTheme.chatNeutral else PhrenTheme.chatText))
                                        if (r == 0) Box(Modifier.width(1.dp).height(0.dp))
                                    }
                                }
                            }
                        }
                    }
                }
                else -> {
                    val style = if (block.heading) body.copy(fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold) else body
                    val annotated = inlineMarkdown(block.text, PhrenTheme.chatInlineCode, PhrenTheme.chatPath)
                    if (selecting == block.id) {
                        SelectionContainer(Modifier.fillMaxWidth()) { Text(annotated, style = style) }
                    } else {
                        Text(annotated, style = style, modifier = Modifier.fillMaxWidth()
                            .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = { menuFor = block }, onDoubleClick = { selecting = block.id }, onClick = { selecting = null }))
                    }
                }
            }
        }
    }
    menuFor?.let { block ->
        val actions = if (block.rows.isNotEmpty()) listOf(
            PhrenControlAction("copy-table", "Copy table", SF("tablecells")) { copyToClipboard(context, block.rows.joinToString("\n") { it.joinToString(" | ") }) },
            PhrenControlAction("copy-message", "Copy message", SF("doc.on.doc")) { copyToClipboard(context, reply) },
        ) else listOf(
            PhrenControlAction("copy-paragraph", "Copy paragraph", SF("text.quote")) { copyToClipboard(context, block.text) },
            PhrenControlAction("select-text", "Select text", SF("character.cursor.ibeam")) { selecting = block.id },
            PhrenControlAction("copy-message", "Copy message", SF("doc.on.doc")) { copyToClipboard(context, reply) },
        )
        PhrenActionSheet("Message", actions, identifier = "rich-text-menu") { menuFor = null }
    }
}

/** A fenced block is just the code; holding it copies (ChatCodeBlock). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CodeBlock(text: String, language: String) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    val lines = text.split("\n")
    val truncated = lines.size > 12 || text.length > 2_000
    val preview = lines.take(12).joinToString("\n").take(2_000)
    Box(Modifier.fillMaxWidth().phrenPanel(tool = true)
        .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = { copyToClipboard(context, text); copied = true }, onClick = {})
        .phrenIdentifier("chat-code-block")) {
        Text(CodeHighlighting.highlightedBlock(preview, SyntaxTokenizer.Language.detect(language)),
            style = TextStyle(fontFamily = PhrenType.mono, fontSize = 14.5.sp, lineHeight = 20.sp, color = PhrenTheme.chatText),
            maxLines = 12, modifier = Modifier.fillMaxWidth().padding(12.dp))
        if (language.isNotEmpty() || truncated) {
            Text(if (truncated) "${if (language.isEmpty()) "" else "$language · "}more" else language, style = PhrenType.caption2, color = PhrenTheme.chatNeutralDim,
                modifier = Modifier.align(Alignment.TopEnd).padding(horizontal = 8.dp, vertical = 4.dp))
        }
        if (copied) {
            androidx.compose.runtime.LaunchedEffect(Unit) { kotlinx.coroutines.delay(1_400); copied = false }
            Text("Copied", style = PhrenType.caption.copy(fontWeight = FontWeight.SemiBold), color = PhrenTheme.chatText,
                modifier = Modifier.align(Alignment.Center).background(PhrenTheme.surfaceRaised, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 7.dp).phrenIdentifier("chat-code-copied"))
        }
    }
}

// MARK: Documents (FilesView.swift DocumentContentView / CodeTextView)

/** Store documents and computer files: Markdown preview or source with line numbers. */
@Composable
fun DocumentContentView(path: String, content: String, embedded: Boolean = false, modifier: Modifier = Modifier) {
    val language = SyntaxTokenizer.Language.detect(path)
    var source by remember { mutableStateOf(false) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (language == SyntaxTokenizer.Language.MARKDOWN) {
            Box(Modifier.padding(horizontal = 12.dp)) {
                PhrenIconSegment(listOf(IconSegmentItem(false, SF("doc.richtext"), "Preview"), IconSegmentItem(true, SF("chevron.left.forwardslash.chevron.right"), "Source")),
                    source, { source = it })
            }
        }
        when {
            !source && language == SyntaxTokenizer.Language.MARKDOWN ->
                if (embedded) RichText(content, modifier = Modifier.fillMaxWidth())
                else Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) { RichText(content, modifier = Modifier.fillMaxWidth().padding(16.dp).padding(bottom = 100.dp)) }
            embedded -> Box(Modifier.horizontalScroll(rememberScrollState())) { CodeTextView(content, language) }
            else -> Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState())) { CodeTextView(content, language, bottom = 100) }
        }
    }
}

@Composable
fun CodeTextView(code: String, language: SyntaxTokenizer.Language, bottom: Int = 0) {
    val lines = remember(code) { code.split("\n") }
    val number = PhrenType.monoCaption2.copy(color = PhrenTheme.textDim, textAlign = TextAlign.End)
    val line = PhrenType.monoFootnote.copy(color = PhrenTheme.text)
    SelectionContainer {
        Column(Modifier.padding(start = 10.dp, end = 10.dp, top = 8.dp, bottom = (8 + bottom).dp)) {
            lines.forEachIndexed { i, text ->
                Row(Modifier.padding(vertical = 0.5.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("${i + 1}", style = number, modifier = Modifier.width(36.dp))
                    Text(CodeHighlighting.highlighted(text.ifEmpty { " " }, language), style = line, softWrap = false)
                }
            }
        }
    }
}

// MARK: Editing (DocumentEditorSheet.swift)

data class DocumentDraft(val path: String, val content: String?, val id: String = java.util.UUID.randomUUID().toString())

@Composable
fun DocumentEditorSheet(title: String, storeId: String, draft: DocumentDraft, template: String = "") {
    val model = LocalModel.current
    val dismiss = LocalDismiss.current ?: {}
    val initialText = draft.content ?: template
    var text by remember { mutableStateOf(initialText) }
    var expected by remember { mutableStateOf(draft.content) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmingDiscard by remember { mutableStateOf(false) }
    var comparing by remember { mutableStateOf<DocumentDraft?>(null) }
    val dirty = text != initialText || expected != draft.content
    val isSkill = LocalStore.isSkillPath(draft.path)
    val latest = if (isSkill) model.skills(storeId).firstOrNull { it.path == draft.path }?.content
    else model.instructions(draft.path.split("/")[0], storeId)
    val warnings = if (isSkill) SkillFile.frontmatterWarnings(text) else emptyList()

    fun save() {
        if (saving) return
        saving = true
        model.scope.launch {
            try { model.saveDocument(draft.path, text, expected, storeId); dismiss() }
            catch (e: Exception) { error = e.message ?: "The file couldn't be saved." }
            saving = false
        }
    }
    com.phren.android.design.BackCloses(true) { if (dirty) confirmingDiscard = true else dismiss() }
    Column(Modifier.fillMaxSize()) {
        PhrenNavBar(title, inSheet = true,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", enabled = !saving) { if (dirty) confirmingDiscard = true else dismiss() }),
            trailing = listOf(ToolbarItem(text = if (saving) "Saving…" else "Save", label = "Save", bold = true, identifier = "document-save",
                enabled = !saving && (dirty || draft.content == null) && text.isNotBlank() && model.canPush(storeId)) { save() }))
        Text(model.storeName(storeId), style = PhrenType.caption, color = PhrenTheme.textSecondary, modifier = Modifier.padding(horizontal = 16.dp))
        warnings.forEach { Text("⚠ $it", style = PhrenType.caption, color = Color(0xFFFF9F0A), modifier = Modifier.padding(horizontal = 16.dp)) }
        androidx.compose.foundation.text.BasicTextField(
            text, { text = it }, enabled = !saving,
            textStyle = PhrenType.monoBody.copy(color = PhrenTheme.text), cursorBrush = androidx.compose.ui.graphics.SolidColor(PhrenTheme.cyan),
            modifier = Modifier.fillMaxSize().padding(16.dp).phrenIdentifier("document-editor"),
        )
    }
    if (confirmingDiscard) PhrenDialog("Discard your changes?", "The edits you made in this draft will be lost.", listOf(
        PhrenControlAction("discard", "Discard changes", role = PhrenControlAction.Role.DESTRUCTIVE) { dismiss() },
        PhrenControlAction("keep", "Keep editing", role = PhrenControlAction.Role.CANCEL) {},
    ), identifier = "document-discard-dialog") { confirmingDiscard = false }
    error?.let { message ->
        PhrenDialog("Couldn't save", message, buildList {
            if (latest != expected) add(PhrenControlAction("compare", "Compare versions") { comparing = DocumentDraft(draft.path, latest) })
            add(PhrenControlAction("keep-editing", "Keep editing", role = PhrenControlAction.Role.CANCEL) {})
        }, identifier = "document-save-error-dialog") { error = null }
    }
    comparing?.let { latestDraft ->
        com.phren.android.design.PhrenSheet({ comparing = null }) {
            Column(Modifier.fillMaxSize()) {
                PhrenNavBar("Compare versions", inSheet = true,
                    trailing = listOf(ToolbarItem(text = "Use merged draft", label = "Use merged draft", bold = true, identifier = "document-use-merged") {
                        expected = latestDraft.content; comparing = null
                    }))
                com.phren.android.design.PhrenForm {
                    com.phren.android.design.FormSection("Latest in store") {
                        Box(Modifier.padding(16.dp)) {
                            SelectionContainer { Text(latestDraft.content ?: "This file was removed from the store.", style = PhrenType.body, color = PhrenTheme.text) }
                        }
                    }
                    com.phren.android.design.FormSection("Your draft", footer = "Include the changes you want to keep. Saving your merged draft will replace the latest version.") {
                        androidx.compose.foundation.text.BasicTextField(text, { text = it },
                            textStyle = PhrenType.monoBody.copy(color = PhrenTheme.text), cursorBrush = androidx.compose.ui.graphics.SolidColor(PhrenTheme.cyan),
                            modifier = Modifier.fillMaxWidth().padding(16.dp).androidxMinHeight(240).phrenIdentifier("document-merged-draft"))
                    }
                    val context = LocalContext.current
                    com.phren.android.design.FormSection {
                        com.phren.android.design.FormRow("Share draft", icon = SF("square.and.arrow.up"), chevron = false) {
                            context.startActivity(android.content.Intent.createChooser(android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, text), null))
                        }
                    }
                }
            }
        }
    }
}

private fun Modifier.androidxMinHeight(dp: Int) = this.heightIn(min = dp.dp)
