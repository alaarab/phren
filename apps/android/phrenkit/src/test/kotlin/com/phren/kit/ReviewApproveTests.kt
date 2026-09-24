package com.phren.kit

import kotlinx.coroutines.runBlocking
import java.io.File
import java.nio.file.Files
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Approve must promote, not discard (ReviewApproveTests.swift). `phren extract`
 * queues every candidate below autoAcceptThreshold into review.md without
 * writing it to FINDINGS.md, so for those the queue line is the only copy
 * (`approveQueueItemDetailed` in data/access.ts).
 */
class ReviewApproveTests {
    private lateinit var directory: File

    @BeforeTest fun setUp() { directory = Files.createTempDirectory("phren-approve").toFile() }
    @AfterTest fun tearDown() { directory.deleteRecursively() }

    private val queueLine = "- [2026-07-26] [pitfall] Session hooks fire twice when both modes are enabled [confidence 0.60] <!-- source:extract machine:laptop actor:codex -->"

    private fun makeEngine(usesTeamJournal: Boolean = false, queue: String = queueLine, findings: String? = null): Pair<SyncEngine, LocalStore> = runBlocking {
        val store = LocalStore(directory, "o", "r", "main")
        store.write("proj/review.md", "# proj Review Queue\n\n## Review\n\n$queue\n\n## Stale\n\n## Conflicts\n", null)
        if (findings != null) store.write("proj/FINDINGS.md", findings, null)
        val engine = SyncEngine(FakeGitHubClient(), store, directory)
        engine.setAutoFlush(false)
        engine.setWriteContext(SyncEngine.WriteContext("octocat", "Pixel", usesTeamJournal))
        engine to store
    }

    @Test fun approvingAnExtractionCandidateWritesTheFinding() = runBlocking {
        // No FINDINGS.md at all: the queue line is the only copy of this text.
        val (engine, store) = makeEngine()
        engine.enqueue(PendingOp.ApproveQueue("proj", queueLine))
        engine.flushNow()

        val findings = assertNotNull(store.read("proj/FINDINGS.md"), "approve must create FINDINGS.md, not discard the candidate")
        assertTrue(findings.contains("- [pitfall] Session hooks fire twice when both modes are enabled"))
        // Written today, but the day it was queued is kept, as the CLI does.
        assertTrue(findings.contains("<!-- phren:queued \"2026-07-26\" -->"))
        // The observation's own provenance, not the device that approved it.
        assertTrue(findings.contains("<!-- source:extract machine:laptop actor:codex -->"))
        assertFalse(findings.contains("Pixel"))
        // The confidence marker is queue bookkeeping.
        assertFalse(findings.contains("confidence"))
        assertFalse(store.read("proj/review.md")!!.contains("Session hooks fire twice"), "the line should be dequeued")
    }

    @Test fun approvingAnItemAlreadyInFindingsDoesNotDuplicateIt() = runBlocking {
        val (engine, store) = makeEngine(findings = "# proj Findings\n\n## 2026-07-20\n\n- [pitfall] Session hooks fire twice when both modes are enabled <!-- fid:11112222 -->\n")
        engine.enqueue(PendingOp.ApproveQueue("proj", queueLine))
        engine.flushNow()
        val findings = store.read("proj/FINDINGS.md")!!
        assertEquals(1, findings.split("Session hooks fire twice").size - 1, "the existing finding should be kept as-is, not duplicated")
        assertTrue(findings.contains("fid:11112222"))
        assertFalse(store.read("proj/review.md")!!.contains("Session hooks fire twice"))
    }

    @Test fun approvingIntoATeamStoreWritesTheJournal() = runBlocking {
        val (engine, store) = makeEngine(usesTeamJournal = true)
        engine.enqueue(PendingOp.ApproveQueue("proj", queueLine))
        engine.flushNow()
        val today = FindingsFile.isoTimestamp(Instant.now()).take(10)
        val journal = assertNotNull(store.read("proj/journal/$today-octocat.md"), "a team-store approve belongs in the journal")
        assertTrue(journal.contains("Session hooks fire twice when both modes are enabled"))
        assertNull(store.read("proj/FINDINGS.md"), "team stores never line-splice FINDINGS.md")
        assertFalse(store.read("proj/review.md")!!.contains("Session hooks fire twice"))
    }

    @Test fun approveKeepsTheQueueLineWhenPromotionFails() = runBlocking {
        val secretLine = "- [2026-07-26] deploy key is sk-ant-api03-" + "A".repeat(90)
        val (engine, store) = makeEngine(queue = secretLine)
        // enqueue applies locally first, so a domain error surfaces here and nothing is queued or written.
        try {
            engine.enqueue(PendingOp.ApproveQueue("proj", secretLine))
            fail("approving a line containing a credential should fail")
        } catch (_: PhrenKitError) { }
        engine.flushNow()
        assertTrue(store.read("proj/review.md")!!.contains("sk-ant-api03"), "the queue line must survive a failed promotion")
        assertNull(store.read("proj/FINDINGS.md"))
    }

    @Test fun approvingAnItemOnlyInAnArchiveBlockDequeuesWithoutWriting() = runBlocking {
        val archived = "# proj Findings\n\n<details>\n<summary>Archived 2026-07-01</summary>\n\n- [pitfall] Session hooks fire twice when both modes are enabled <!-- fid:33334444 -->\n\n</details>\n"
        val (engine, store) = makeEngine(findings = archived)
        engine.enqueue(PendingOp.ApproveQueue("proj", queueLine))
        engine.flushNow()
        // The CLI's already_archived outcome: the archive is left untouched.
        assertEquals(archived, store.read("proj/FINDINGS.md"))
        assertFalse(store.read("proj/review.md")!!.contains("Session hooks fire twice"))
    }

    /** The promoted bullet has the CLI's shape: the queued date after any source comment, before the lifecycle comments, no confidence. */
    @Test fun promotedBulletMatchesTheCLIFixture() {
        val cliLines = Fixtures.text("findings-after-approve.md").split("\n")
        val cliIndex = cliLines.indexOfFirst { it.contains("Session hooks fire twice") }
        val line = "- [2026-07-26] [pitfall] Session hooks fire twice when both MCP and hooks mode are enabled [confidence 0.60]"
        val file = FindingsFile("")
        file.add("myproj", ReviewFile.findingsTextFor(line), FindingsFile.AddOptions(
            provenance = ReviewFile.capturedProvenanceFor(line), queuedDate = ReviewFile.queuedDateFor(line),
            now = Instant.parse("2026-07-26T13:00:00Z")))
        val lines = file.content.split("\n")
        val index = lines.indexOfFirst { it.contains("Session hooks fire twice") }
        val withoutFid = { s: String -> s.replace(Regex("fid:[0-9a-f]{8}"), "fid:X") }
        assertEquals(withoutFid(cliLines[cliIndex]), withoutFid(lines[index]))
        assertEquals(cliLines[cliIndex + 1], lines[index + 1])
    }
}
