package com.phren.kit

import kotlinx.coroutines.runBlocking
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** In-memory stand-in for the REST client (port of FakeGitHubClient). */
class FakeGitHubClient(remote: Map<String, String> = emptyMap()) : GitHubAPI {
    data class Write(val path: String, val message: String, val content: String, val deleted: Boolean)

    val writes = mutableListOf<Write>()
    val blobFetches = mutableListOf<String>()
    private val files = mutableMapOf<String, String>()
    private val shas = mutableMapOf<String, String>()
    private var head = "head-0"
    private var revision = 0
    private val conflictOnce = mutableSetOf<String>()
    private val conflictAlways = mutableSetOf<String>()

    init {
        remote.keys.sorted().forEach { setRemote(it, remote.getValue(it)) }
    }

    @Synchronized fun setRemote(path: String, content: String) {
        revision++
        files[path] = content
        shas[path] = GitBlob.sha(content)
        head = "head-$revision"
    }

    @Synchronized fun failNextPut(vararg paths: String) { conflictOnce += paths }
    @Synchronized fun failEveryPut(vararg paths: String) { conflictAlways += paths }
    @Synchronized fun remoteContent(path: String) = files[path]

    override suspend fun headSha(owner: String, repo: String, branch: String): String? = synchronized(this) { head }

    override suspend fun tree(owner: String, repo: String, sha: String) = synchronized(this) {
        GitTree(sha, false, files.keys.sorted().map { GitTree.Entry(it, "blob", shas[it], files[it]?.toByteArray()?.size) })
    }

    override suspend fun blob(owner: String, repo: String, sha: String): ByteArray = synchronized(this) {
        val path = shas.entries.firstOrNull { it.value == sha }?.key ?: throw GitHubError.InvalidResponse
        blobFetches += path
        files.getValue(path).toByteArray()
    }

    override suspend fun putFile(owner: String, repo: String, path: String, branch: String, content: ByteArray, message: String, sha: String?): ContentsPutResponse = synchronized(this) {
        val text = content.toString(Charsets.UTF_8)
        writes += Write(path, message, text, false)
        if (path in conflictAlways) throw GitHubError.ShaConflict(path)
        if (conflictOnce.remove(path)) throw GitHubError.ShaConflict(path)
        setRemote(path, text)
        ContentsPutResponse(ContentsPutResponse.ContentInfo(shas.getValue(path), path), ContentsPutResponse.CommitInfo(head))
    }

    override suspend fun deleteFile(owner: String, repo: String, path: String, branch: String, message: String, sha: String): Unit = synchronized(this) {
        writes += Write(path, message, "", true)
        if (conflictOnce.remove(path)) throw GitHubError.ShaConflict(path)
        files.remove(path)
        shas.remove(path)
        revision++
        head = "head-$revision"
    }
}

/** Port of SyncEngineCoalescingTests. */
class SyncEngineTests {
    private lateinit var directory: File

    @BeforeTest fun setUp() { directory = Files.createTempDirectory("phren-sync").toFile() }
    @AfterTest fun tearDown() { directory.deleteRecursively() }

    private val reviewSeed = "# myproj Review Queue\n\n## Review\n\n- [2026-07-26] First queued finding\n- [2026-07-26] Second queued finding\n- [2026-07-26] Third queued finding\n\n## Stale\n\n## Conflicts\n"
    private val reviewRemote = "# myproj Review Queue\n\n## Review\n\n- [2026-07-26] First queued finding\n- [2026-07-26] Second queued finding\n- [2026-07-26] Third queued finding\n- [2026-07-26] Fourth queued finding\n\n## Stale\n\n## Conflicts\n"
    private val tasksSeed = "# myproj tasks\n\n## Active\n\n- [ ] Investigate flaky sync test on CI [medium] <!-- bid:013d708f rank:3 -->\n- [ ] Ship the iOS app [high] <!-- bid:aa853063 rank:1 -->\n\n## Queue\n\n## Done\n"
    private val first = "- [2026-07-26] First queued finding"
    private val second = "- [2026-07-26] Second queued finding"
    private val third = "- [2026-07-26] Third queued finding"

    private fun makeEngine(local: Map<String, String>, remote: Map<String, String> = emptyMap()): Pair<SyncEngine, FakeGitHubClient> = runBlocking {
        val store = LocalStore(directory, "o", "r", "main")
        local.forEach { (p, c) -> store.write(p, c, "stale-$p") }
        val client = FakeGitHubClient(remote)
        val engine = SyncEngine(client, store, directory)
        engine.setAutoFlush(false)
        engine to client
    }

    @Test fun consecutiveSameFileOpsCoalesceIntoOneCommit() = runBlocking {
        val (engine, client) = makeEngine(mapOf("myproj/review.md" to reviewSeed))
        for (line in listOf(first, second, third)) engine.enqueue(PendingOp.ApproveQueue("myproj", line))
        engine.flushNow()
        assertEquals(1, client.writes.size)
        assertEquals("phren: myproj(update x3) via android", client.writes[0].message)
        assertFalse(client.writes[0].content.contains("queued finding\n- [2026-07-26] T"))
        listOf("First", "Second", "Third").forEach { assertFalse(client.writes[0].content.contains("$it queued finding")) }
        val status = engine.currentStatus()
        assertEquals(0, status.pendingCount)
        assertEquals(0, status.failedCount)
    }

    @Test fun opsOnDifferentFilesShareOneFlushPlan() = runBlocking {
        val (engine, client) = makeEngine(mapOf("myproj/review.md" to reviewSeed, "myproj/tasks.md" to tasksSeed))
        engine.enqueue(PendingOp.ApproveQueue("myproj", first))
        engine.enqueue(PendingOp.CompleteTask("myproj", "flaky sync test"))
        engine.enqueue(PendingOp.ApproveQueue("myproj", second))
        engine.flushNow()
        assertEquals(listOf("myproj/review.md", "myproj/tasks.md"), client.writes.map { it.path })
        assertEquals(List(2) { "phren: myproj(update x2,task) via android" }, client.writes.map { it.message })
    }

    @Test fun crossProjectBatchApproveIsOneCommitPerFile() = runBlocking {
        val (engine, client) = makeEngine(mapOf("myproj/review.md" to reviewSeed, "other/review.md" to reviewSeed))
        engine.enqueue(PendingOp.ApproveQueue("myproj", first))
        engine.enqueue(PendingOp.ApproveQueue("other", first))
        engine.enqueue(PendingOp.ApproveQueue("myproj", second))
        engine.enqueue(PendingOp.ApproveQueue("other", second))
        engine.flushNow()
        assertEquals(listOf("myproj/review.md", "other/review.md"), client.writes.map { it.path })
        assertEquals(List(2) { "phren: myproj(update x2) other(update x2) via android" }, client.writes.map { it.message })
    }

    @Test fun flushSkipsBytesTheRemoteAlreadyHas() = runBlocking {
        val (firstEngine, firstClient) = makeEngine(mapOf("myproj/review.md" to reviewSeed))
        firstEngine.enqueue(PendingOp.ApproveQueue("myproj", first))
        firstEngine.flushNow()
        val pushed = firstClient.writes.last().content
        firstEngine.close()

        directory.deleteRecursively()
        directory.mkdirs()
        val store = LocalStore(directory, "o", "r", "main")
        store.write("myproj/review.md", reviewSeed, GitBlob.sha(pushed))
        val client = FakeGitHubClient(mapOf("myproj/review.md" to pushed))
        val engine = SyncEngine(client, store, directory)
        engine.setAutoFlush(false)
        engine.enqueue(PendingOp.ApproveQueue("myproj", first))
        engine.flushNow()
        assertTrue(client.writes.isEmpty(), "byte-identical content must not be re-PUT as an empty commit")
        assertEquals(0, engine.currentStatus().pendingCount)
    }

    @Test fun shaConflictReappliesTheWholeGroup() = runBlocking {
        val (engine, client) = makeEngine(mapOf("myproj/review.md" to reviewSeed), mapOf("myproj/review.md" to reviewRemote))
        client.failNextPut("myproj/review.md")
        for (line in listOf(first, second, third)) engine.enqueue(PendingOp.ApproveQueue("myproj", line))
        engine.flushNow()
        assertEquals(2, client.writes.size)
        assertEquals("phren: myproj(update x3) via android", client.writes[1].message)
        val final = client.remoteContent("myproj/review.md")!!
        assertFalse(final.contains("First queued finding"))
        assertTrue(final.contains("Fourth queued finding"))
        assertEquals(0, engine.currentStatus().failedCount)
    }

    @Test fun reapplyParksOnlyTheOpWhoseTargetVanished() = runBlocking {
        val remote = reviewRemote.replace("- [2026-07-26] Second queued finding\n", "")
        val (engine, client) = makeEngine(mapOf("myproj/review.md" to reviewSeed), mapOf("myproj/review.md" to remote))
        client.failNextPut("myproj/review.md")
        for (line in listOf(first, second, third)) engine.enqueue(PendingOp.ApproveQueue("myproj", line))
        engine.flushNow()
        assertEquals(2, client.writes.size)
        assertEquals("phren: myproj(update x2) via android", client.writes[1].message)
        val failed = engine.failedOps()
        assertEquals(listOf<PendingOp>(PendingOp.ApproveQueue("myproj", second)), failed.map { it.op })
        engine.retryFailed()
        engine.flushNow()
        assertEquals(1, engine.failedOps().size)
        assertEquals(2, client.writes.size, "a no-op retry must not manufacture a commit")
    }

    @Test fun secondaryFileIsWrittenFirst() = runBlocking {
        val findingsSeed = "# myproj Findings\n\n## 2026-07-26\n\n- [2026-07-26] First queued finding\n"
        val (engine, client) = makeEngine(mapOf("myproj/review.md" to reviewSeed, "myproj/FINDINGS.md" to findingsSeed))
        engine.enqueue(PendingOp.RejectQueue("myproj", first))
        engine.enqueue(PendingOp.AddFinding("myproj", "A brand new finding"))
        engine.flushNow()
        val paths = client.writes.map { it.path }
        assertTrue(paths.indexOf("myproj/FINDINGS.md") < paths.indexOf("myproj/review.md"))
    }

    @Test fun partialSuccessThenConflictDoesNotParkLandedOps() = runBlocking {
        val (engine, client) = makeEngine(
            mapOf("myproj/review.md" to reviewSeed, "other/review.md" to reviewSeed),
            mapOf("myproj/review.md" to reviewSeed, "other/review.md" to reviewRemote),
        )
        client.failNextPut("other/review.md")
        engine.enqueue(PendingOp.ApproveQueue("myproj", first))
        engine.enqueue(PendingOp.ApproveQueue("other", first))
        engine.flushNow()
        val failed = engine.failedOps()
        assertFalse(failed.any { it.op == PendingOp.ApproveQueue("myproj", first) })
        if (failed.isNotEmpty()) {
            engine.retryFailed()
            engine.flushNow()
            assertTrue(engine.failedOps().isEmpty())
        }
        assertFalse(client.remoteContent("myproj/review.md")!!.contains("First queued finding"))
        assertFalse(client.remoteContent("other/review.md")!!.contains("First queued finding"))
    }

    @Test fun unresolvedConflictParksEachOpIndividually() = runBlocking {
        val (engine, client) = makeEngine(mapOf("myproj/review.md" to reviewSeed), mapOf("myproj/review.md" to reviewRemote))
        client.failEveryPut("myproj/review.md")
        engine.enqueue(PendingOp.ApproveQueue("myproj", first))
        engine.enqueue(PendingOp.ApproveQueue("myproj", second))
        engine.flushNow()
        assertEquals(3, client.writes.size)
        assertEquals(listOf<PendingOp>(PendingOp.ApproveQueue("myproj", first), PendingOp.ApproveQueue("myproj", second)), engine.failedOps().map { it.op })
        assertEquals(0, engine.currentStatus().pendingCount)
    }

    @Test fun readOnlyProjectIsRefusedAtEnqueue() = runBlocking {
        val (engine, _) = makeEngine(emptyMap())
        val error = runCatching { engine.enqueue(PendingOp.AddFinding("global", "x")) }.exceptionOrNull()
        assertTrue(error is PhrenKitError.Validation)
        assertEquals(0, engine.currentStatus().pendingCount)
    }

    @Test fun teamStoreAddsGoToTheJournal() = runBlocking {
        val (engine, client) = makeEngine(emptyMap())
        engine.setWriteContext(SyncEngine.WriteContext(actor = "octocat", machine = "pixel", usesTeamJournal = true))
        engine.enqueue(PendingOp.AddFinding("myproj", "Journal me", "decision"))
        engine.flushNow()
        val write = client.writes.single()
        assertTrue(write.path.startsWith("myproj/journal/") && write.path.endsWith("-octocat.md"))
        assertTrue(write.content.endsWith("- [decision] Journal me <!-- source:human machine:pixel actor:octocat -->\n"))
    }

    @Test fun pullMirrorsHotTierAndCataloguesColdTier() = runBlocking {
        val (engine, client) = makeEngine(emptyMap(), mapOf(
            "myproj/FINDINGS.md" to "# myproj Findings\n\n<!-- consolidated: 2026-08-01 -->\n",
            "myproj/reference/topics/build-tooling.md" to "# myproj - Build tooling\n\n## Archived 2026-01-01\n\n- Old finding\n",
            "myproj/.config/secret.json" to "{}",
        ))
        engine.pull(force = true)
        assertEquals(listOf("myproj/FINDINGS.md"), client.blobFetches, "cold docs are catalogued, never downloaded")
        val topics = engine.coldStore.topics("myproj")
        assertEquals("Build tooling", topics.single().displayName)
        val doc = engine.coldDocument(topics.single().path)
        assertTrue(doc.entries.single().archived)
        engine.coldDocument(topics.single().path)
        assertEquals(2, client.blobFetches.size, "a hydrated doc is served from cache at the same sha")
    }

    @Test fun commitMessageAndGroupingKeys() {
        val approve = PendingOp.ApproveQueue("myproj", "- x")
        val reject = PendingOp.RejectQueue("myproj", "- x")
        val complete = PendingOp.CompleteTask("myproj", "x")
        assertEquals("myproj/notes/2026-07-26.md", PendingOp.AddNote("myproj", "2026-07-26", "09:00", "hi").primaryPath)
        assertEquals(listOf("myproj/review.md", "myproj/FINDINGS.md"), reject.editablePaths)
        assertEquals("phren: myproj(update x2) via android", PendingOp.commitMessage(listOf(approve, reject)))
        assertEquals("phren: myproj(task x12) via android", PendingOp.commitMessage(List(12) { complete }))
        assertEquals("phren: myproj(update,task x2) via android", PendingOp.commitMessage(listOf(approve, complete, complete)))
        assertEquals("phren: myproj(update x2) other(update) via android", PendingOp.commitMessage(listOf(approve, PendingOp.ApproveQueue("other", "- y"), approve)))
    }

    @Test fun gitBlobShaMatchesGitObjectIdentity() {
        assertEquals("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", GitBlob.sha(""))
        assertEquals("ce013625030ba8dba906f756967f9e9ca394464a", GitBlob.sha("hello\n"))
    }

    @Test fun pendingQueueSurvivesRestartAndQuarantinesCorruption() = runBlocking {
        val (engine, _) = makeEngine(mapOf("myproj/review.md" to reviewSeed))
        engine.enqueue(PendingOp.ApproveQueue("myproj", first))
        engine.close()
        val reopened = SyncEngine(FakeGitHubClient(), LocalStore(directory, "o", "r", "main"), directory)
        assertEquals(1, reopened.pendingOps().size)

        File(directory, "pending-ops.json").writeText("{not json")
        val corrupt = SyncEngine(FakeGitHubClient(), LocalStore(directory, "o", "r", "main"), directory)
        assertEquals(0, corrupt.pendingOps().size)
        assertEquals(StorageIssue.Kind.UNREADABLE, corrupt.storageIssues.single().kind)
        assertTrue(directory.listFiles()!!.any { it.name.startsWith("pending-ops.corrupt-") })
    }
}
