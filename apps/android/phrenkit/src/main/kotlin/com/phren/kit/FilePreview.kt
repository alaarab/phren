package com.phren.kit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64

/** One read stays below the SSH gateway's response cap, including base64 (FilePreview.swift). */
@Serializable
data class FileChunk(
    val offset: Long,
    val length: Int,
    val total: Long,
    val contentType: String,
    val version: String,
    val eof: Boolean,
    val data: String,
) {
    fun bytes(): ByteArray {
        val decoded = try { Base64.getDecoder().decode(data) } catch (_: IllegalArgumentException) { null }
        if (offset < 0 || total < offset || length < 0 || length > MAXIMUM_LENGTH || length.toLong() > total - offset || version.isEmpty() ||
            version.toByteArray().size > 512 || data.toByteArray().size > (MAXIMUM_LENGTH + 2) / 3 * 4 || decoded == null || decoded.size != length ||
            eof != (offset + length == total)) throw PhrenKitError.Validation("The computer returned an invalid file chunk.")
        return decoded
    }

    companion object {
        const val MAXIMUM_LENGTH = 4 * 1024 * 1024
        fun of(offset: Long, total: Long, contentType: String, version: String, bytes: ByteArray) =
            FileChunk(offset, bytes.size, total, contentType, version, offset + bytes.size == total, Base64.getEncoder().encodeToString(bytes))
    }
}

enum class FilePreviewKind(val rawValue: String) {
    VIDEO("video"), AUDIO("audio"), PDF("pdf"), MARKDOWN("markdown"), CODE("code"), JSON("json"), CSV("csv"), IMAGE("image"), TEXT("text"), FILE("file");

    companion object {
        fun detect(name: String, contentType: String?): FilePreviewKind {
            val last = name.substringAfterLast('/')
            // NSString.pathExtension: after the last dot; a leading-dot name like ".env" has none.
            val dot = last.lastIndexOf('.')
            val ext = if (dot > 0) last.substring(dot + 1).lowercase() else ""
            val mime = contentType?.split(";")?.first()?.trim()?.lowercase() ?: ""
            // Specific MIME types win over a misleading filename.
            if (mime == "application/pdf") return PDF
            if (mime == "application/json" || mime.endsWith("+json")) return JSON
            if (mime == "text/csv") return CSV
            if (mime == "text/markdown") return MARKDOWN
            if (mime.startsWith("video/")) return VIDEO
            if (mime.startsWith("audio/")) return AUDIO
            if (mime.startsWith("image/") && mime != "image/svg+xml") return IMAGE
            if (ext in setOf("mp4", "m4v", "mov", "webm", "mkv", "avi")) return VIDEO
            if (ext in setOf("mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "opus")) return AUDIO
            if (ext == "pdf") return PDF
            if (ext == "json") return JSON
            if (ext == "csv") return CSV
            if (ext in setOf("md", "markdown", "mdown")) return MARKDOWN
            if (ext in setOf("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp")) return IMAGE
            if (ext in setOf("ts", "tsx", "js", "jsx", "swift", "py", "rs", "go", "rb", "sh", "bash", "zsh", "c", "h", "cpp", "hpp", "cs", "java", "kt", "html", "css", "scss", "sql", "toml", "yaml", "yml", "xml", "svg", "ini")) return CODE
            if (ext in setOf("txt", "log", "gitignore", "env") || mime.startsWith("text/")) return TEXT
            return FILE
        }
    }
}

/**
 * Each completed append is durable; reopening uses the file's actual length
 * and requires the same remote version (FileChunkAssembly).
 */
class FileChunkAssembly(directory: File, name: String) {
    val file: File = File(directory, name.substringAfterLast('/').let { if (it in setOf("", ".", "..", ".download.json")) "file" else it })
    private val metadata = File(directory, ".download.json")
    private var expected: FileChunk? = null
    private val json = Json { ignoreUnknownKeys = true }

    @Synchronized
    fun prepare(info: FileChunk): Long {
        info.bytes()
        if (info.offset != 0L || info.length != 0) throw PhrenKitError.Validation("Expected file metadata.")
        file.parentFile?.mkdirs()
        val saved = runCatching { json.decodeFromString(FileChunk.serializer(), metadata.readText()) }.getOrNull()
        val size = if (file.exists()) file.length() else 0
        if (saved?.version != info.version || saved.total != info.total || size > info.total || !file.exists()) atomicWrite(file, "")
        atomicWrite(metadata, json.encodeToString(FileChunk.serializer(), info))
        expected = info
        return received()
    }

    fun received(): Long = if (file.exists()) file.length() else 0

    @Synchronized
    fun append(chunk: FileChunk): Long {
        val bytes = chunk.bytes()
        val e = expected
        if (e == null || chunk.version != e.version || chunk.total != e.total || chunk.contentType != e.contentType || chunk.offset != received() || bytes.isEmpty())
            throw PhrenKitError.Validation("The file changed or a download chunk is missing. Open it again.")
        RandomAccessFile(file, "rw").use { raf ->
            try {
                raf.seek(chunk.offset); raf.write(bytes); raf.fd.sync()
            } catch (x: Exception) { raf.setLength(chunk.offset); throw x }
        }
        return chunk.offset + bytes.size
    }
}

/** Cursors keep a large text document on disk; one bounded page is decoded at a time. */
data class FileTextCursor(val offset: Long = 0, val depth: Int = 0, val quoted: Boolean = false, val escaped: Boolean = false)

class FileTextPage(val text: String, val next: FileTextCursor, val eof: Boolean) {
    companion object {
        private fun strictUtf8(bytes: ByteArray, count: Int): String? = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, 0, count)).toString()
        } catch (_: CharacterCodingException) { null }

        fun read(file: File, cursor: FileTextCursor, json: Boolean = false, limit: Int = 32_768): FileTextPage {
            if (limit !in 4..65_536) throw PhrenKitError.Validation("Invalid text page size.")
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(cursor.offset)
                val buffer = ByteArray(limit)
                var count = 0
                while (count < limit) { val n = raf.read(buffer, count, limit - count); if (n <= 0) break; count += n }
                val end = raf.length()
                val atEnd = cursor.offset + count == end
                // Prefer complete lines; never let one long line pull in the whole file.
                if (!atEnd && !json) {
                    val newline = (count - 1 downTo 0).firstOrNull { buffer[it] == 10.toByte() }
                    if (newline != null && newline > count / 2) count = newline + 1
                }
                var text: String? = null
                val maxTrim = if (atEnd) 0 else minOf(3, count - if (count == 0) 0 else 1)
                for (trim in 0..maxTrim) {
                    strictUtf8(buffer, count - trim)?.let { count -= trim; text = it }
                    if (text != null) break
                }
                val decoded = text
                if (decoded == null || decoded.contains('\u0000')) throw PhrenKitError.Validation("This file is not UTF-8 text. Save or share it to open it elsewhere.")
                var next = cursor.copy(offset = cursor.offset + count)
                val output = if (json) {
                    val (formatted, cursorOut) = formatJSON(decoded, next); next = cursorOut; formatted
                } else decoded
                return FileTextPage(output, next, next.offset == end)
            }
        }

        private fun formatJSON(text: String, start: FileTextCursor): Pair<String, FileTextCursor> {
            var c = start
            val out = StringBuilder()
            fun newline() { out.append("\n").append("  ".repeat(minOf(40, c.depth))) }
            for (ch in text) {
                if (c.quoted) {
                    out.append(ch)
                    c = when {
                        c.escaped -> c.copy(escaped = false)
                        ch == '\\' -> c.copy(escaped = true)
                        ch == '"' -> c.copy(quoted = false)
                        else -> c
                    }
                } else when (ch) {
                    '"' -> { c = c.copy(quoted = true); out.append(ch) }
                    '{', '[' -> { out.append(ch); c = c.copy(depth = c.depth + 1); newline() }
                    '}', ']' -> { c = c.copy(depth = maxOf(0, c.depth - 1)); newline(); out.append(ch) }
                    ',' -> { out.append(ch); newline() }
                    ':' -> out.append(": ")
                    else -> if (!ch.isWhitespace()) out.append(ch)
                }
            }
            return out.toString() to c
        }
    }
}

/** A CSV page ends at a complete record, respecting quoted newlines and escaped quotes. */
class FileCSVPage(val rows: List<List<String>>, val nextOffset: Long, val eof: Boolean) {
    companion object {
        fun read(file: File, offset: Long, maximumBytes: Int = 262_144): FileCSVPage {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(offset)
                val data = ByteArray(maximumBytes)
                var size = 0
                while (size < maximumBytes) { val n = raf.read(data, size, maximumBytes - size); if (n <= 0) break; size += n }
                val atEnd = offset + size == raf.length()
                val rows = mutableListOf<List<String>>()
                var row = mutableListOf<String>()
                val field = java.io.ByteArrayOutputStream()
                var quoted = false
                var i = 0
                var boundary = 0
                fun finishField() {
                    val bytes = field.toByteArray()
                    row += strictUtf8(bytes) ?: throw PhrenKitError.Validation("CSV must contain UTF-8 text.")
                    field.reset()
                }
                while (i < size) {
                    val b = data[i].toInt() and 0xFF
                    if (b == 34) {
                        if (quoted && i + 1 < size && data[i + 1].toInt() == 34) { field.write(34); i++ } else quoted = !quoted
                    } else if (!quoted && b == 44) finishField()
                    else if (!quoted && (b == 10 || b == 13)) {
                        finishField(); rows += row; row = mutableListOf()
                        if (b == 13 && i + 1 < size && data[i + 1].toInt() == 10) i++
                        boundary = i + 1
                        if (rows.size == 100) break
                    } else field.write(b)
                    i++
                }
                if (i >= size && atEnd) {
                    if (quoted) throw PhrenKitError.Validation("This CSV has an unfinished quoted field.")
                    if (field.size() > 0 || row.isNotEmpty()) { finishField(); rows += row }
                    boundary = size
                }
                if (boundary <= 0 && size > 0) throw PhrenKitError.Validation("This CSV record exceeds 256 KiB. Save or share the file to read it elsewhere.")
                return FileCSVPage(rows, offset + boundary, atEnd && boundary == size)
            }
        }

        private fun strictUtf8(bytes: ByteArray): String? = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) { null }
    }
}
