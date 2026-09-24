package com.phren.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.File
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** FilePreviewTests.swift, case for case. */
class FilePreviewTests {
    private fun directory(): File = kotlin.io.path.createTempDirectory("file-preview-").toFile()

    @Test fun chunkAssemblyResumesAfterRecreationAndChangesRestart() {
        val dir = directory()
        val bytes = ByteArray(9 * 1024 * 1024 + 17) { (it % 251).toByte() }
        val info = FileChunk.of(0, bytes.size.toLong(), "video/mp4", "v1", ByteArray(0))
        val first = FileChunkAssembly(dir, "render.mp4")
        assertEquals(0, first.prepare(info))
        val head = FileChunk.of(0, info.total, info.contentType, info.version, bytes.copyOf(FileChunk.MAXIMUM_LENGTH))
        val firstSize = first.append(head)
        assertEquals(FileChunk.MAXIMUM_LENGTH.toLong(), firstSize)
        val resumed = FileChunkAssembly(dir, "render.mp4")
        var offset = resumed.prepare(info)
        assertEquals(firstSize, offset)
        while (offset < info.total) {
            val end = minOf(bytes.size, offset.toInt() + FileChunk.MAXIMUM_LENGTH)
            offset = resumed.append(FileChunk.of(offset, info.total, info.contentType, info.version, bytes.copyOfRange(offset.toInt(), end)))
        }
        assertContentEquals(bytes, resumed.file.readBytes())
        assertEquals(info.total, resumed.prepare(info))
        assertEquals(0, resumed.prepare(FileChunk.of(0, 3, "video/mp4", "v2", ByteArray(0))))
    }

    @Test fun outOfOrderAndChangedChunksAreRejectedWithoutWriting() {
        val assembly = FileChunkAssembly(directory(), "file")
        assembly.prepare(FileChunk.of(0, 10, "text/plain", "a", ByteArray(0)))
        for (chunk in listOf(FileChunk.of(1, 10, "text/plain", "a", byteArrayOf(1)), FileChunk.of(0, 10, "text/plain", "b", byteArrayOf(1)),
            FileChunk.of(0, 10, "text/plain", "a", ByteArray(0)))) {
            assertFailsWith<PhrenKitError> { assembly.append(chunk) }
        }
        assertEquals(0, assembly.received())
        val invalid = """{"offset":0,"length":2,"total":2,"contentType":"text/plain","version":"a","eof":true,"data":"eA=="}"""
        assertFailsWith<PhrenKitError> { Json.decodeFromString(FileChunk.serializer(), invalid).bytes() }
    }

    @Test fun typeDetectionPrefersSpecificMimeAndFallsBackToExtension() {
        val examples = listOf(
            Triple("render.MP4", null, FilePreviewKind.VIDEO), Triple("sound.m4a", "application/octet-stream", FilePreviewKind.AUDIO),
            Triple("download", "application/pdf", FilePreviewKind.PDF), Triple("readme.md", "text/plain", FilePreviewKind.MARKDOWN),
            Triple("app.swift", null, FilePreviewKind.CODE), Triple("data.json", null, FilePreviewKind.JSON), Triple("data.bin", "application/problem+json", FilePreviewKind.JSON),
            Triple("table.csv", null, FilePreviewKind.CSV), Triple("photo.heic", null, FilePreviewKind.IMAGE), Triple("notes.log", null, FilePreviewKind.TEXT),
            Triple("archive.zip", null, FilePreviewKind.FILE), Triple("misleading.mp4", "application/pdf; charset=binary", FilePreviewKind.PDF),
        )
        for ((name, mime, kind) in examples) assertEquals(kind, FilePreviewKind.detect(name, mime), name)
    }

    @Test fun utf8PagesKeepSplitCharactersAndNeverLoadTheWholeText() {
        val file = File(directory(), "large.txt")
        val original = "a世界👋\n".repeat(1000)
        file.writeText(original)
        var cursor = FileTextCursor()
        val output = StringBuilder()
        while (true) {
            val page = FileTextPage.read(file, cursor, limit = 101)
            assertTrue(page.next.offset - cursor.offset <= 101)
            output.append(page.text); cursor = page.next
            if (page.eof) break
        }
        assertEquals(original, output.toString())
    }

    @Test fun streamingJsonPreservesQuotedPunctuationAcrossPages() {
        val file = File(directory(), "data.json")
        val original = """{"message":"braces { and } commas, quote \" and unicode 世界","list":[1,2,true,null]}"""
        file.writeText(original)
        var cursor = FileTextCursor()
        val output = StringBuilder()
        while (true) {
            val page = FileTextPage.read(file, cursor, json = true, limit = 11)
            output.append(page.text); cursor = page.next
            if (page.eof) break
        }
        assertTrue(output.contains("\n"))
        assertEquals(Json.parseToJsonElement(original), Json.parseToJsonElement(output.toString()) as JsonElement)
    }

    @Test fun csvQuotedRecordsAndPagination() {
        val file = File(directory(), "table.csv")
        file.writeText("name,detail\r\n\"sam\",\"comma, quote \"\" and\nnewline\"\r\n" + "a,b\n".repeat(201))
        var offset = 0L
        val rows = mutableListOf<List<String>>()
        while (true) {
            val page = FileCSVPage.read(file, offset)
            rows += page.rows; offset = page.nextOffset
            if (page.eof) break
        }
        assertEquals(203, rows.size)
        assertEquals(listOf("sam", "comma, quote \" and\nnewline"), rows[1])
    }

    @Test fun invalidTrailingUtf8IsNotSilentlyDropped() {
        val file = File(directory(), "invalid.txt")
        file.writeBytes(byteArrayOf(65, 0xE2.toByte(), 0x82.toByte()))
        assertFailsWith<PhrenKitError> { FileTextPage.read(file, FileTextCursor()) }
    }

    @Test fun exactPageBoundariesDoNotOfferAnEmptyNextPage() {
        val file = File(directory(), "exact.txt")
        file.writeText("abcdefgh")
        assertTrue(FileTextPage.read(file, FileTextCursor(), limit = 8).eof)
        file.writeText("a,b\n")
        val csv = FileCSVPage.read(file, 0, maximumBytes = 4)
        assertTrue(csv.eof)
        assertEquals(listOf(listOf("a", "b")), csv.rows)
    }
}
