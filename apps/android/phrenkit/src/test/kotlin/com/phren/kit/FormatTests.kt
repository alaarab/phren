package com.phren.kit

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Ports of FindingsFileTests / TasksFileTests / ReviewFileTests /
 * NotesFileTests / FormatGapsTests / JournalFileTests. Mutation tests assert
 * byte-identical output against files the real CLI wrote.
 */
class FindingsFileTests {
    @Test fun parseMatchesCLI() {
        val parsed = FindingsFile(Fixtures.text("findings-after-remove.md")).parse()
        val expected = Fixtures.array("findings-parsed.json")
        assertEquals(expected.size, parsed.size)
        for ((item, exp) in parsed.zip(expected)) {
            assertEquals(exp.str("id"), item.id)
            assertEquals(exp.str("stableId"), item.stableId)
            assertEquals(exp.str("date"), item.date)
            assertEquals(exp.str("text"), item.text)
            assertEquals(exp.str("status"), item.status.rawValue)
            assertEquals(exp.str("scope"), item.scope)
            assertEquals(exp.str("machine"), item.machine)
            assertEquals(exp.str("actor"), item.actor)
            assertEquals(exp.str("status_updated"), item.statusUpdated)
            assertEquals(exp.obj("citationData")?.str("created_at"), item.citationData?.createdAt)
            assertFalse(item.archived)
        }
    }

    @Test fun consolidatedMarkerIsParsed() {
        val marked = "# myproj Findings\n\n<!-- consolidated: 2026-08-01 -->\n\n## 2026-08-02\n\n- [decision] Keep JWT expiry at 15 minutes"
        assertEquals("2026-08-01", FindingsFile(marked).consolidatedDate)
        assertEquals("2025-12-31", FindingsFile("  <!--   consolidated:   2025-12-31 more -->").consolidatedDate)
        assertNull(FindingsFile(Fixtures.text("findings-after-remove.md")).consolidatedDate)
        assertNull(FindingsFile("<!-- consolidated: soon -->").consolidatedDate)
    }

    @Test fun editMatchesCLIByteForByte() {
        val file = FindingsFile(Fixtures.text("findings-after-add.md"))
        file.edit("myproj", "Plain finding with no tag", "Edited finding text that replaced the plain one")
        assertSameContent(file.content, Fixtures.text("findings-after-edit.md"), "edit")
    }

    @Test fun removeMatchesCLIByteForByte() {
        val file = FindingsFile(Fixtures.text("findings-after-edit.md"))
        file.remove("myproj", "Chose SQLite FTS5 over embeddings")
        assertSameContent(file.content, Fixtures.text("findings-after-remove.md"), "remove")
    }

    @Test fun addProducesCLICompatibleBullet() {
        val file = FindingsFile(Fixtures.text("findings-after-remove.md"))
        val fid = file.add(
            "myproj", "[pitfall] New finding from Android",
            FindingsFile.AddOptions(provenance = FindingProvenance(source = "human", machine = "test-pixel", actor = "tester", tool = "phren-android")),
        )
        val added = file.parse().first { it.stableId == fid }
        assertEquals("[pitfall] New finding from Android", added.text)
        assertEquals(FindingLifecycleStatus.ACTIVE, added.status)
        assertEquals("test-pixel", added.machine)
        assertEquals("tester", added.actor)
        assertNotNull(added.citationData)
        val lines = file.content.split("\n")
        val idx = lines.indexOfFirst { it.contains("fid:$fid") }
        assertTrue(isCitationLine(lines[idx + 1]))
        assertTrue(lines[idx + 1].startsWith("  <!-- phren:cite {\"created_at\":"))
    }

    @Test fun addRejectsSecrets() {
        assertFailsWith<PhrenKitError.SecretDetected> { FindingsFile("").add("myproj", "token ghp_" + "a".repeat(36)) }
    }

    @Test fun addSkipsExactDuplicate() {
        val file = FindingsFile(Fixtures.text("findings-after-remove.md"))
        assertFailsWith<PhrenKitError.Duplicate> { file.add("myproj", "[pattern] Always validate JWT expiry before refresh") }
    }

    @Test fun editRefusesArchivedFinding() {
        val content = """
            # myproj Findings

            ## 2026-07-01

            - Active bullet <!-- fid:aaaaaaaa -->

            <details>
            <summary>Archived</summary>

            ## 2026-01-01

            - Archived bullet <!-- fid:bbbbbbbb -->

            </details>
        """.trimIndent()
        val file = FindingsFile(content)
        assertFailsWith<PhrenKitError.ArchivedReadOnly> { file.edit("myproj", "Archived bullet", "changed") }
        assertEquals(listOf("aaaaaaaa"), file.parse().map { it.stableId })
        assertEquals(2, file.parse(includeArchived = true).size)
    }

    @Test fun matchByFid() {
        val file = FindingsFile(Fixtures.text("findings-after-remove.md"))
        val target = file.parse().first()
        assertTrue(file.remove("myproj", "fid:${target.stableId}").contains("fid:${target.stableId}"))
    }

    @Test fun normalizeFindingTextMatchesCLI() {
        assertEquals("[pattern] always validate jwt", normalizeFindingText("- [pattern] Always Validate  JWT <!-- fid:12345678 --> [confidence 0.9]"))
    }

    @Test fun jsWhitespaceSemantics() {
        // JS `\s` and trim() include NBSP / BOM; Java's `\s` does not.
        assertEquals("a b", " a b﻿".collapsedWhitespace.jsTrimmed)
    }
}

class TasksFileTests {
    @Test fun parseMatchesCLI() {
        val file = TasksFile("myproj", Fixtures.text("tasks-after-update.md"))
        val expected = Fixtures.json("tasks-parsed.json") as kotlinx.serialization.json.JsonObject
        assertEquals(expected.str("title"), file.doc.title)
        val items = expected.obj("items")!!
        for ((name, section) in listOf("Active" to PhrenTask.Section.ACTIVE, "Queue" to PhrenTask.Section.QUEUE, "Done" to PhrenTask.Section.DONE)) {
            val actual = file.doc.items(section)
            val exp = items.arr(name)?.map { it as kotlinx.serialization.json.JsonObject } ?: emptyList()
            assertEquals(exp.size, actual.size, name)
            for ((item, e) in actual.zip(exp)) {
                assertEquals(e.str("id"), item.id)
                assertEquals(e.str("stableId"), item.stableId)
                assertEquals(e.str("line"), item.line)
                assertEquals(e.bool("checked"), item.checked)
                assertEquals(e.str("priority"), item.priority?.rawValue)
                assertEquals(e.int("rank"), item.rank)
                assertEquals(e.str("createdAt"), item.createdAt)
            }
        }
    }

    @Test fun renderRoundTripsCLIFile() {
        val content = Fixtures.text("tasks-after-update.md")
        assertSameContent(TasksFile("myproj", content).render(), content, "tasks round-trip")
    }

    @Test fun completeMatchesCLIByteForByte() {
        val file = TasksFile("myproj", Fixtures.text("tasks-after-add.md"))
        file.complete("Write fixture generator")
        assertSameContent(file.render(), Fixtures.text("tasks-after-complete.md"), "complete")
    }

    @Test fun updateMatchesCLIByteForByte() {
        val file = TasksFile("myproj", Fixtures.text("tasks-after-complete.md"))
        file.update("Investigate flaky sync test", TasksFile.Updates("Investigate flaky sync test on CI", PhrenTask.Priority.MEDIUM, PhrenTask.Section.ACTIVE))
        assertSameContent(file.render(), Fixtures.text("tasks-after-update.md"), "update")
    }

    @Test fun addAppendsToQueueWithFreshBid() {
        val file = TasksFile("myproj", Fixtures.text("tasks-after-update.md"))
        val added = file.add("New mobile task [high]")
        assertEquals(PhrenTask.Section.QUEUE, added.section)
        assertEquals(PhrenTask.Priority.HIGH, added.priority)
        assertTrue(TasksFile("myproj", file.render()).doc.queue.any { it.stableId == added.stableId })
    }

    @Test fun matchByBidAndPositionalId() {
        val file = TasksFile("myproj", Fixtures.text("tasks-after-update.md"))
        val target = file.doc.active[0]
        assertEquals(target.stableId, file.complete(target.stableId!!).stableId)
        assertEquals(target.stableId, TasksFile("myproj", Fixtures.text("tasks-after-update.md")).complete("A1").stableId)
    }

    @Test fun priorityTagAccumulationStripped() {
        assertEquals("Fix bug", TasksFile.stripPriorityTag("Fix bug [high] [high] [high]"))
        assertEquals("Fix bug [pinned]", TasksFile.stripPriorityTag("Fix bug [high] [pinned]"))
    }

    @Test fun continuationLines() {
        val content = "# myproj tasks\n\n## Queue\n\n- [ ] Task with extras <!-- bid:12ab34cd rank:1 -->\n  Context: some background\n  GitHub: #42 https://github.com/owner/repo/issues/42"
        val file = TasksFile("myproj", content)
        val item = file.doc.queue[0]
        assertEquals("some background", item.context)
        assertEquals(42, item.githubIssue)
        assertEquals("https://github.com/owner/repo/issues/42", item.githubUrl)
        val rendered = file.render()
        assertTrue(rendered.contains("  Context: some background"))
        assertTrue(rendered.contains("  GitHub: #42 https://github.com/owner/repo/issues/42"))
    }
}

class ReviewFileTests {
    @Test fun parseMatchesCLI() {
        val parsed = ReviewFile(Fixtures.text("review-seeded.md")).parse()
        val expected = Fixtures.array("review-parsed.json")
        assertEquals(expected.size, parsed.size)
        for ((item, exp) in parsed.zip(expected)) {
            assertEquals(exp.str("id"), item.id)
            assertEquals(exp.str("section"), item.section.rawValue)
            assertEquals(exp.str("date"), item.date)
            assertEquals(exp.str("text"), item.text)
            assertEquals(exp.str("line"), item.line)
            assertEquals(exp.double("confidence"), item.confidence)
            assertEquals(exp.bool("risky"), item.risky)
        }
    }

    @Test fun approveRejectEditMatchCLIByteForByte() {
        val file = ReviewFile(Fixtures.text("review-seeded.md"))
        file.approve(file.parse()[0].line)
        assertSameContent(file.content, Fixtures.text("review-after-approve.md"), "approve")
        file.reject(file.parse()[0].line)
        assertSameContent(file.content, Fixtures.text("review-after-reject.md"), "reject")
        file.edit(file.parse()[0].line, "Edited stale entry text")
        assertSameContent(file.content, Fixtures.text("review-after-edit.md"), "edit queue item")
    }

    @Test fun riskyFlagging() {
        val items = ReviewFile(Fixtures.text("review-seeded.md")).parse()
        assertFalse(items[0].risky)
        assertTrue(items[1].risky)
        assertTrue(items.first { it.section == QueueItem.Section.STALE }.risky)
    }

    @Test fun queueTextNormalization() {
        assertEquals("Some text with escapes and spaces", ReviewFile.cleanQueueEntryText("Some text <!-- source:agent --> with\\nescapes and  spaces"))
        val normalized = ReviewFile.normalizeQueueEntryText("a".repeat(600))
        assertEquals(500, normalized.length)
        assertTrue(normalized.endsWith("…"))
    }

    @Test fun findingsNeedleStripsConfidence() {
        assertEquals("Some captured finding", ReviewFile.findingsTextFor("- [2026-07-26] Some captured finding [confidence 0.85]"))
    }
}

class NotesFileTests {
    @Test fun parseMatchesCLI() {
        val file = NotesFile("myproj", "2026-07-25", Fixtures.text("notes-after-edit-promote.md"))
        val expected = Fixtures.array("notes-parsed.json")
        val byId = file.notes.associateBy { it.stableId }
        assertEquals(expected.size, file.notes.size)
        for (exp in expected) {
            val note = byId.getValue(exp.str("stableId")!!)
            assertEquals(exp.str("id"), note.id)
            assertEquals(exp.str("time"), note.time)
            assertEquals(exp.str("text"), note.text)
            assertEquals(exp.bool("promoted"), note.promoted)
            assertEquals(exp.str("date"), note.date)
        }
    }

    @Test fun renderRoundTripsCLIFile() {
        val content = Fixtures.text("notes-after-edit-promote.md")
        assertSameContent(NotesFile("myproj", "2026-07-25", content).render() ?: "", content, "notes round-trip")
    }

    @Test fun editAndPromoteMatchCLIByteForByte() {
        val file = NotesFile("myproj", "2026-07-25", Fixtures.text("notes-after-add.md"))
        val n1 = file.notes.first { it.time == "14:30:05" }
        file.edit(n1.stableId, "First note, edited")
        file.markPromoted(n1.stableId)
        assertSameContent(file.render() ?: "", Fixtures.text("notes-after-edit-promote.md"), "edit+promote")
    }

    @Test fun removeLastNoteDeletesFile() {
        val file = NotesFile("myproj", "2026-07-25", null)
        file.remove(file.add("only note", "10:00:00").stableId)
        assertNull(file.render())
    }

    @Test fun promoteTwiceRefused() {
        val file = NotesFile("myproj", "2026-07-25", Fixtures.text("notes-after-edit-promote.md"))
        assertFailsWith<PhrenKitError.Validation> { file.markPromoted(file.notes.first { it.promoted }.stableId) }
    }

    @Test fun headingLikeBodyLineEscaped() {
        val file = NotesFile("myproj", "2026-07-25", null)
        val sneaky = "## 10:00 <!-- nid:aaaabbbb -->"
        file.add("first line\n$sneaky", "11:00:00")
        val reparsed = NotesFile("myproj", "2026-07-25", file.render())
        assertEquals(1, reparsed.notes.size)
        assertTrue(reparsed.notes[0].text.contains("#$sneaky"))
    }

    @Test fun noteLengthCap() {
        assertFailsWith<PhrenKitError.Validation> { NotesFile("myproj", "2026-07-25", null).add("x".repeat(10_001), "10:00:00") }
    }
}

class FormatGapsTests {
    @Test fun unknownAnnotationSurvivesAddAndEdit() {
        val afterAdd = Fixtures.text("findings-unknown-annotation-after-add.md")
        val afterEdit = Fixtures.text("findings-unknown-annotation-after-edit.md")
        val file = FindingsFile(afterAdd)
        file.edit("myproj", "Unknown metadata comments must survive edits verbatim", "Edited text after an unrecognised annotation round trip")
        assertSameContent(file.content, afterEdit, "edit with unrecognised annotation")
        assertTrue(file.content.contains("""<!-- someday:field "x" -->"""))
    }

    @Test fun legacyDetailsBlockParseMatchesCLI() {
        val file = FindingsFile(Fixtures.text("findings-legacy-details-archive.md"))
        val defaultParsed = file.parse()
        val expectedDefault = Fixtures.array("findings-legacy-details-archive-default-parsed.json")
        assertEquals(expectedDefault.size, defaultParsed.size)
        assertEquals("Active finding outside any archive block", defaultParsed.first().text)
        val withArchived = file.parse(includeArchived = true)
        assertEquals(Fixtures.array("findings-legacy-details-archive-with-archived-parsed.json").size, withArchived.size)
        val archived = withArchived.first { it.stableId == "0000abcd" }
        assertEquals("Archived finding inside a legacy details block", archived.text)
        assertEquals("superseded", archived.status.rawValue)
        assertEquals("2026-01-06", archived.statusUpdated)
        assertEquals("superseded_by", archived.statusReason)
        assertEquals("replacement text", archived.statusRef)
        assertTrue(archived.archived)
        assertFailsWith<PhrenKitError.ArchivedReadOnly> {
            FindingsFile(Fixtures.text("findings-legacy-details-archive.md")).remove("myproj", "Archived finding inside a legacy details block")
        }
    }

    @Test fun nonstandardTagIsNotMangled() {
        val afterAdd = Fixtures.text("findings-nonstandard-tag-after-add.md")
        val entry = FindingsFile(afterAdd).parse().first { it.stableId == "0000a002" }
        assertEquals("[nonstandard] Bracket tags outside every known vocabulary must not be mangled", entry.text)
        assertEquals("nonstandard", entry.typeTag)
        val file = FindingsFile(afterAdd)
        file.edit("myproj", "Bracket tags outside every known vocabulary must not be mangled", "Edited text without supplying any tag of its own")
        assertSameContent(file.content, Fixtures.text("findings-nonstandard-tag-after-edit.md"), "edit with nonstandard tag")
    }

    @Test fun textOnlyUpdateDropsPriorityAndPinned() {
        val file = TasksFile("myproj", Fixtures.text("tasks-pinned-before-text-edit.md"))
        val before = file.doc.queue.first { it.stableId == "0000b001" }
        assertEquals(PhrenTask.Priority.HIGH, before.priority)
        assertEquals(true, before.pinned)
        file.update("Ship urgent fix", TasksFile.Updates(text = "Ship urgent fix (renamed)"))
        val updated = file.doc.queue.first { it.stableId == "0000b001" }
        assertNull(updated.priority)
        assertNull(updated.pinned)
        assertSameContent(file.render(), Fixtures.text("tasks-pinned-after-text-only-edit.md"), "text-only update on pinned task")
    }

    @Test fun reviewQueueTruncatesAt500UTF16Units() {
        val entry = ReviewFile(Fixtures.text("review-unicode-boundary.md")).parse().first { it.text.startsWith("🧵") }
        assertEquals(500, entry.text.length)
        assertTrue(entry.text.endsWith("…"))
        assertFalse(entry.text.contains("CANARY"))
        assertEquals(Fixtures.array("review-unicode-boundary-parsed.json").first().str("text"), entry.text)
    }

    @Test fun supersedesTruncateAt60UTF16Units() {
        val parsed = FindingsFile(Fixtures.text("findings-unicode-supersede-after.md")).parse()
        val old = parsed.first { it.stableId == "0000a003" }
        val new = parsed.first { it.stableId == "0000a004" }
        assertEquals(60, old.supersededBy?.length)
        assertEquals(60, new.supersedes?.length)
        val expected = Fixtures.json("findings-unicode-supersede-parsed.json") as kotlinx.serialization.json.JsonObject
        assertEquals(expected.obj("old")?.str("supersededBy"), old.supersededBy)
        assertEquals(expected.obj("new")?.str("supersedes"), new.supersedes)
    }
}

class JournalFileTests {
    private val date = "2026-07-28"

    @Test fun fileNameRoundTrips() {
        assertEquals("myproj/journal/2026-07-28-tester.md", JournalFile.path("myproj", date, "tester"))
        assertEquals("2026-07-28" to "other-actor", JournalFile.parseFileName("2026-07-28-other-actor.md"))
        assertNull(JournalFile.parseFileName("2026-07-28.md"))
        assertNull(JournalFile.parseFileName("2026-07-28-tester.txt"))
    }

    @Test fun actorIsSanitized() {
        assertEquals("Ala_s_Pixel", JournalFile.sanitizeActor("Ala's Pixel"))
        assertEquals(".._.._etc_passwd", JournalFile.sanitizeActor("../../etc/passwd"))
        assertEquals("unknown", JournalFile.sanitizeActor("  "))
        assertEquals("unknown", JournalFile.sanitizeActor(null))
        for (raw in listOf("octocat", "Ala's Pixel", "../../etc/passwd", null)) {
            val actor = JournalFile.sanitizeActor(raw)
            val path = JournalFile.path("myproj", date, actor)
            assertEquals(3, path.split("/").size)
            assertTrue(LocalStore.isWritablePath(path))
        }
    }

    @Test fun appendMatchesCLIByteForByte() {
        val file = JournalFile(date, "tester")
        file.append("[decision] Team stores journal their findings instead of splicing FINDINGS.md", "test-machine")
        file.append("Second entry of the day appends to the same actor file", "test-machine")
        assertSameContent(file.content!!, Fixtures.text("journal-2026-07-28-tester.md"), "journal append")

        val other = JournalFile(date, "other-actor")
        other.append("Entry written by a different actor on the same day")
        assertSameContent(other.content!!, Fixtures.text("journal-2026-07-28-other-actor.md"), "journal append without machine")
    }

    @Test fun readMatchesCLI() {
        val expected = Fixtures.array("journal-parsed.json")
        // journal.ts:184 — filenames sorted then reversed.
        val files = listOf("tester", "other-actor")
            .map { JournalFile(date, it, Fixtures.text("journal-2026-07-28-$it.md")) }
            .sortedByDescending { it.fileName }
        assertEquals(expected.size, files.size)
        for ((file, exp) in files.zip(expected)) {
            assertEquals(exp.str("file"), file.fileName)
            assertEquals(exp.str("actor"), file.actor)
            assertEquals(exp.arr("entries")?.map { (it as kotlinx.serialization.json.JsonPrimitive).content }, file.entries)
            assertTrue(file.findings().all { it.date == date && it.actor == file.actor && it.isJournalEntry })
        }
    }
}
