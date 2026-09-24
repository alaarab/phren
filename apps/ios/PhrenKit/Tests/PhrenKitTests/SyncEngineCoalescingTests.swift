import XCTest
@testable import PhrenKit

/// In-memory stand-in for the REST client. Records every write so tests can
/// assert on request count, order and commit message, and serves the
/// ref/tree/blob reads that sha-conflict recovery pulls.
actor FakeGitHubClient: GitHubAPI {
    struct Write: Sendable, Equatable {
        let path: String
        let message: String
        let content: String
        let deleted: Bool
    }

    private(set) var writes: [Write] = []
    /// Paths whose blob was actually downloaded, in order. The cold tier's
    /// central claim — that cataloguing the archive costs no extra requests —
    /// is only checkable against this.
    private(set) var blobFetches: [String] = []
    private var files: [String: String] = [:]
    private var shas: [String: String] = [:]
    private var head = "head-0"
    private var revision = 0
    private var conflictOnce: Set<String> = []
    private var conflictAlways: Set<String> = []
    private var writesOffline = false
    private var notModified = false

    func setWritesOffline(_ value: Bool) { writesOffline = value }
    func setNotModified(_ value: Bool) { notModified = value }

    init(remote: [String: String] = [:]) {
        for path in remote.keys.sorted() {
            revision += 1
            files[path] = remote[path] ?? ""
            shas[path] = GitBlob.sha(of: remote[path] ?? "")
            head = "head-\(revision)"
        }
    }

    /// Publishes remote content, minting a new head so a forced pull sees a
    /// change. Blob shas are content-addressed exactly like the real API, so
    /// the engine's "these bytes are already on the remote" check behaves as
    /// it does against GitHub.
    func setRemote(_ path: String, _ content: String) {
        revision += 1
        files[path] = content
        shas[path] = GitBlob.sha(of: content)
        head = "head-\(revision)"
    }

    /// The next PUT to each path answers 409 (as GitHub does when the blob sha
    /// no longer matches). The attempt is still recorded.
    func failNextPut(on paths: [String]) {
        conflictOnce.formUnion(paths)
    }

    /// Every PUT to these paths answers 409 — a remote that keeps changing
    /// under the flush, exhausting the retry budget.
    func failEveryPut(on paths: [String]) {
        conflictAlways.formUnion(paths)
    }

    func remoteContent(_ path: String) -> String? { files[path] }

    func writes(to path: String) -> [Write] { writes.filter { $0.path == path } }

    // MARK: - GitHubAPI

    func headSha(owner: String, repo: String, branch: String) async throws -> String? { notModified ? nil : head }

    func tree(owner: String, repo: String, sha: String) async throws -> GitTree {
        // Real trees carry `size` on every blob; the cold tier's catalogue is
        // built entirely from what this response already contains.
        GitTree(sha: sha, truncated: false, tree: files.keys.sorted().map { path in
            GitTree.Entry(path: path, type: "blob", sha: shas[path], size: files[path]?.utf8.count)
        })
    }

    func blob(owner: String, repo: String, sha: String) async throws -> Data {
        guard let path = shas.first(where: { $0.value == sha })?.key,
              let content = files[path] else { throw GitHubError.invalidResponse }
        blobFetches.append(path)
        return Data(content.utf8)
    }

    func putFile(owner: String, repo: String, path: String, branch: String,
                 content: Data, message: String, sha: String?) async throws -> ContentsPutResponse {
        let text = String(decoding: content, as: UTF8.self)
        writes.append(Write(path: path, message: message, content: text, deleted: false))
        if writesOffline { throw URLError(.notConnectedToInternet) }
        if conflictAlways.contains(path) { throw GitHubError.shaConflict(path: path) }
        if conflictOnce.remove(path) != nil { throw GitHubError.shaConflict(path: path) }
        setRemote(path, text)
        return ContentsPutResponse(
            content: .init(sha: shas[path] ?? "", path: path),
            commit: .init(sha: head)
        )
    }

    func deleteFile(owner: String, repo: String, path: String, branch: String,
                    message: String, sha: String) async throws {
        writes.append(Write(path: path, message: message, content: "", deleted: true))
        if conflictOnce.remove(path) != nil { throw GitHubError.shaConflict(path: path) }
        files.removeValue(forKey: path)
        shas.removeValue(forKey: path)
        revision += 1
        head = "head-\(revision)"
    }
}

/// Covers the write half of the sync engine: consecutive ops on one file
/// become one commit, ops on different files never merge or reorder, and a
/// conflicted group is re-applied whole.
final class SyncEngineCoalescingTests: XCTestCase {
    private var directory: URL!

    private static let reviewSeed = """
    # myproj Review Queue

    ## Review

    - [2026-07-26] First queued finding
    - [2026-07-26] Second queued finding
    - [2026-07-26] Third queued finding

    ## Stale

    ## Conflicts

    """

    /// review.md as another machine left it while the batch was queued: a
    /// fourth item arrived, so every queued approve now targets a stale sha.
    private static let reviewRemote = """
    # myproj Review Queue

    ## Review

    - [2026-07-26] First queued finding
    - [2026-07-26] Second queued finding
    - [2026-07-26] Third queued finding
    - [2026-07-26] Fourth queued finding

    ## Stale

    ## Conflicts

    """

    private static let tasksSeed = """
    # myproj tasks

    ## Active

    - [ ] Investigate flaky sync test on CI [medium] <!-- bid:013d708f rank:3 -->
    - [ ] Ship the iOS app [high] <!-- bid:aa853063 rank:1 -->

    ## Queue

    ## Done

    """

    private static let firstLine = "- [2026-07-26] First queued finding"
    private static let secondLine = "- [2026-07-26] Second queued finding"
    private static let thirdLine = "- [2026-07-26] Third queued finding"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Seeds the local cache with `local` (stale blob shas, as if pulled
    /// earlier) and the fake remote with `remote`, then hands back an engine
    /// whose background flush is disabled so the test drives `flushNow()`.
    private func makeEngine(local: [String: String],
                            remote: [String: String] = [:]) async throws -> (SyncEngine, FakeGitHubClient) {
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        for (path, content) in local {
            try await store.write(path, content: content, blobSha: "stale-\(path)")
        }
        let client = FakeGitHubClient(remote: remote)
        let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)
        return (engine, client)
    }

    // MARK: - Grouping

    func testConsecutiveSameFileOpsCoalesceIntoOneCommit() async throws {
        let (engine, client) = try await makeEngine(local: ["myproj/review.md": Self.reviewSeed])

        for line in [Self.firstLine, Self.secondLine, Self.thirdLine] {
            try await engine.enqueue(.approveQueue(project: "myproj", line: line))
        }
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.count, 1, "three approves on one review.md must be one commit")
        XCTAssertEqual(writes[0].path, "myproj/review.md")
        XCTAssertEqual(writes[0].message, "phren: myproj(update x3) via ios")
        // All three ops are in the single serialization.
        XCTAssertFalse(writes[0].content.contains("First queued finding"))
        XCTAssertFalse(writes[0].content.contains("Second queued finding"))
        XCTAssertFalse(writes[0].content.contains("Third queued finding"))

        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0)
        XCTAssertEqual(status.failedCount, 0)
    }

    func testSingleOpKeepsThePlainCommitMessage() async throws {
        let (engine, client) = try await makeEngine(local: ["myproj/review.md": Self.reviewSeed])

        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.firstLine))
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0].message, "phren: myproj(update) via ios")
        let failed = await engine.failedOps()
        XCTAssertTrue(failed.isEmpty, "an op applied locally must still push, not park")
    }

    func testOpsOnDifferentFilesShareOneFlushPlan() async throws {
        let (engine, client) = try await makeEngine(local: [
            "myproj/review.md": Self.reviewSeed,
            "myproj/tasks.md": Self.tasksSeed,
        ])

        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.firstLine))
        try await engine.enqueue(.completeTask(project: "myproj", match: "flaky sync test"))
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.map(\.path), ["myproj/review.md", "myproj/tasks.md"])
        // One plan, one message: both files carry the whole batch's summary.
        XCTAssertEqual(writes.map(\.message), [
            "phren: myproj(update,task) via ios",
            "phren: myproj(update,task) via ios",
        ])
    }

    /// The regression behind the 41-commit burst of 2026-08-01: a batch
    /// approve spanning several projects interleaves their review.md ops, and
    /// the old contiguous-prefix grouping split at every project switch — one
    /// commit per run, most of them empty re-PUTs of bytes an earlier run had
    /// already pushed. The whole queue must flush as one plan: one commit per
    /// distinct file, every op counted once.
    func testCrossProjectBatchApproveIsOneCommitPerFile() async throws {
        let (engine, client) = try await makeEngine(local: [
            "myproj/review.md": Self.reviewSeed,
            "other/review.md": Self.reviewSeed,
        ])

        // Interleaved, as a store-wide triage session produces them.
        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.firstLine))
        try await engine.enqueue(.approveQueue(project: "other", line: Self.firstLine))
        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.secondLine))
        try await engine.enqueue(.approveQueue(project: "other", line: Self.secondLine))
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.map(\.path), ["myproj/review.md", "other/review.md"],
                       "four interleaved approves across two projects must be exactly two commits")
        XCTAssertEqual(writes.map(\.message), [
            "phren: myproj(update x2) other(update x2) via ios",
            "phren: myproj(update x2) other(update x2) via ios",
        ])
        for write in writes {
            XCTAssertFalse(write.content.contains("First queued finding"))
            XCTAssertFalse(write.content.contains("Second queued finding"))
            XCTAssertTrue(write.content.contains("Third queued finding"))
        }

        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0)
        XCTAssertEqual(status.failedCount, 0)
    }

    /// Interleaving files never loses edits: each file is serialized once,
    /// carrying every op that touched it, in FIFO order.
    func testInterleavedFilesFlushEachFileOnceWithAllEdits() async throws {
        let (engine, client) = try await makeEngine(local: [
            "myproj/review.md": Self.reviewSeed,
            "myproj/tasks.md": Self.tasksSeed,
        ])

        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.firstLine))
        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.secondLine))
        try await engine.enqueue(.completeTask(project: "myproj", match: "flaky sync test"))
        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.thirdLine))
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.map(\.path), ["myproj/review.md", "myproj/tasks.md"],
                       "review → tasks → review coalesces to one write per file")
        XCTAssertEqual(writes.map(\.message), [
            "phren: myproj(update x3,task) via ios",
            "phren: myproj(update x3,task) via ios",
        ])
        // The single review.md write carries all three approves.
        XCTAssertFalse(writes[0].content.contains("First queued finding"))
        XCTAssertFalse(writes[0].content.contains("Second queued finding"))
        XCTAssertFalse(writes[0].content.contains("Third queued finding"))
    }

    /// Replaying an op whose bytes the remote already has (an idempotent
    /// retry after a crash between the PUT landing and the queue persisting,
    /// or an op enqueued mid-flush whose edit rode the previous push) must
    /// not PUT byte-identical content — GitHub records that as an empty
    /// commit rather than rejecting it.
    func testFlushSkipsBytesTheRemoteAlreadyHas() async throws {
        // First engine: produce the post-approve bytes the "remote" will hold.
        let (first, firstClient) = try await makeEngine(local: ["myproj/review.md": Self.reviewSeed])
        try await first.enqueue(.approveQueue(project: "myproj", line: Self.firstLine))
        await first.flushNow()
        let firstWrites = await firstClient.writes
        let pushed = try XCTUnwrap(firstWrites.last?.content)

        // Second engine: cache already holds those bytes with their true
        // content-addressed sha — the state right after that PUT succeeded.
        try FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        try await store.write("myproj/review.md", content: Self.reviewSeed, blobSha: GitBlob.sha(of: pushed))
        let client = FakeGitHubClient(remote: ["myproj/review.md": pushed])
        let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)

        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.firstLine))
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertTrue(writes.isEmpty, "byte-identical content must not be re-PUT as an empty commit")
        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0, "the skipped op still drains from the queue")
        XCTAssertEqual(status.failedCount, 0)
    }

    // MARK: - Conflict recovery

    func testShaConflictReappliesTheWholeGroup() async throws {
        let (engine, client) = try await makeEngine(
            local: ["myproj/review.md": Self.reviewSeed],
            remote: ["myproj/review.md": Self.reviewRemote]
        )
        await client.failNextPut(on: ["myproj/review.md"])

        for line in [Self.firstLine, Self.secondLine, Self.thirdLine] {
            try await engine.enqueue(.approveQueue(project: "myproj", line: line))
        }
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.count, 2, "one conflicted attempt, then one retry — still one commit per attempt")
        XCTAssertEqual(writes[1].message, "phren: myproj(update x3) via ios",
                       "the retry re-applies all three ops, not just the conflicting one")

        let content = await client.remoteContent("myproj/review.md")
        let final = try XCTUnwrap(content)
        XCTAssertFalse(final.contains("First queued finding"))
        XCTAssertFalse(final.contains("Second queued finding"))
        XCTAssertFalse(final.contains("Third queued finding"))
        // The remote change the conflict was about survives the re-apply.
        XCTAssertTrue(final.contains("Fourth queued finding"))

        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0)
        XCTAssertEqual(status.failedCount, 0)
    }

    /// Parking stays per-op: when the refetch reveals one item already gone,
    /// that op alone lands in "Needs attention" and the rest still commit.
    func testReapplyParksOnlyTheOpWhoseTargetVanished() async throws {
        let remote = Self.reviewRemote.replacingOccurrences(
            of: "- [2026-07-26] Second queued finding\n", with: "")
        let (engine, client) = try await makeEngine(
            local: ["myproj/review.md": Self.reviewSeed],
            remote: ["myproj/review.md": remote]
        )
        await client.failNextPut(on: ["myproj/review.md"])

        for line in [Self.firstLine, Self.secondLine, Self.thirdLine] {
            try await engine.enqueue(.approveQueue(project: "myproj", line: line))
        }
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[1].message, "phren: myproj(update x2) via ios")

        let failed = await engine.failedOps()
        XCTAssertEqual(failed.count, 1)
        XCTAssertEqual(failed.first?.op, .approveQueue(project: "myproj", line: Self.secondLine))
        XCTAssertEqual(failed.first?.op.label, "Approve review item")

        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0)
        XCTAssertEqual(status.failedCount, 1)

        // Retrying re-applies it (its edit never reached the document) and
        // parks it again rather than pushing a commit that contains nothing.
        await engine.retryFailed()
        await engine.flushNow()
        let stillFailed = await engine.failedOps()
        XCTAssertEqual(stillFailed.count, 1)
        let afterRetry = await client.writes
        XCTAssertEqual(afterRetry.count, 2, "a no-op retry must not manufacture a commit")
    }

    /// A file that is one op's SECONDARY and another op's PRIMARY must still be
    /// written first. `reject` mirrors into FINDINGS.md while `addFinding` owns
    /// it; classifying by "is a primary for some op" put review.md first, which
    /// inverts the recovery property — a conflict on FINDINGS.md would then
    /// replay a reject whose queue line had already been removed remotely.
    func testAFileThatIsBothSecondaryAndPrimaryIsStillWrittenFirst() async throws {
        let findingsSeed = """
        # myproj Findings

        ## 2026-07-26

        - [2026-07-26] First queued finding

        """
        let (engine, client) = try await makeEngine(local: [
            "myproj/review.md": Self.reviewSeed,
            "myproj/FINDINGS.md": findingsSeed,
        ])

        // reject → [review.md, FINDINGS.md]; addFinding → [FINDINGS.md].
        try await engine.enqueue(.rejectQueue(project: "myproj", line: Self.firstLine))
        try await engine.enqueue(.addFinding(project: "myproj", text: "A brand new finding", type: nil))
        await engine.flushNow()

        let paths = await client.writes.map(\.path)
        let findingsIdx = try XCTUnwrap(paths.firstIndex(of: "myproj/FINDINGS.md"))
        let reviewIdx = try XCTUnwrap(paths.firstIndex(of: "myproj/review.md"))
        XCTAssertLessThan(findingsIdx, reviewIdx,
                          "the secondary mirror must be pushed before the queue file that addresses it")
    }

    /// Partial success inside one multi-path plan: file A's PUT lands, file B's
    /// 409s. A's ops are already on the remote — they must NOT be parked, and a
    /// user must never be left with "Needs attention" entries that no retry can
    /// clear. (Before whole-queue plans, a plan had one path and this shape was
    /// structurally impossible.)
    func testPartialSuccessThenConflictDoesNotParkTheOpsThatLanded() async throws {
        let (engine, client) = try await makeEngine(
            local: [
                "myproj/review.md": Self.reviewSeed,
                "other/review.md": Self.reviewSeed,
            ],
            // The remote must exist: the conflict path force-pulls, and a
            // forced pull against an empty remote would erase the local cache
            // and make the failure a different bug than the one under test.
            remote: [
                "myproj/review.md": Self.reviewSeed,
                "other/review.md": Self.reviewRemote,
            ]
        )
        // myproj is written first (first-seen order); fail only the second file.
        await client.failNextPut(on: ["other/review.md"])

        try await engine.enqueue(.approveQueue(project: "myproj", line: Self.firstLine))
        try await engine.enqueue(.approveQueue(project: "other", line: Self.firstLine))
        await engine.flushNow()

        let failed = await engine.failedOps()
        XCTAssertFalse(
            failed.contains { $0.op == .approveQueue(project: "myproj", line: Self.firstLine) },
            "the op whose file was pushed successfully must not land in Needs attention"
        )

        // Whatever parked must be clearable — a retry that can never succeed is
        // a dead end for the user.
        if !failed.isEmpty {
            await engine.retryFailed()
            await engine.flushNow()
            let stillFailed = await engine.failedOps()
            XCTAssertTrue(stillFailed.isEmpty, "retryFailed must be able to drain parked ops, not re-park them forever")
        }

        // Both approvals must be reflected on the remote.
        let myprojRemote = await client.remoteContent("myproj/review.md")
        let otherRemote = await client.remoteContent("other/review.md")
        let myproj = try XCTUnwrap(myprojRemote)
        let other = try XCTUnwrap(otherRemote)
        XCTAssertFalse(myproj.contains("First queued finding"))
        XCTAssertFalse(other.contains("First queued finding"))
    }

    func testUnresolvedConflictParksEachOpIndividually() async throws {
        let (engine, client) = try await makeEngine(
            local: ["myproj/review.md": Self.reviewSeed],
            remote: ["myproj/review.md": Self.reviewRemote]
        )
        // Every attempt conflicts — three tries, then park.
        await client.failEveryPut(on: ["myproj/review.md"])

        for line in [Self.firstLine, Self.secondLine] {
            try await engine.enqueue(.approveQueue(project: "myproj", line: line))
        }
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.count, 3, "maxWriteAttempts tries, each still a single commit")
        let failed = await engine.failedOps()
        XCTAssertEqual(failed.count, 2, "the group parks as individual entries, not one blob")
        XCTAssertEqual(failed.map(\.op), [
            .approveQueue(project: "myproj", line: Self.firstLine),
            .approveQueue(project: "myproj", line: Self.secondLine),
        ])
        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0)
    }

    // MARK: - Op metadata

    func testCommitMessageAndGroupingKeys() {
        let approve = PendingOp.approveQueue(project: "myproj", line: "- x")
        let reject = PendingOp.rejectQueue(project: "myproj", line: "- x")
        let complete = PendingOp.completeTask(project: "myproj", match: "x")
        let note = PendingOp.addNote(project: "myproj", date: "2026-07-26", time: "09:00", text: "hi")

        XCTAssertEqual(approve.primaryPath, "myproj/review.md")
        XCTAssertEqual(reject.primaryPath, "myproj/review.md")
        XCTAssertEqual(complete.primaryPath, "myproj/tasks.md")
        XCTAssertEqual(note.primaryPath, "myproj/notes/2026-07-26.md")
        XCTAssertEqual(reject.editablePaths, ["myproj/review.md", "myproj/FINDINGS.md"])

        XCTAssertEqual(PendingOp.commitMessage(for: [approve]), "phren: myproj(update) via ios")
        XCTAssertEqual(PendingOp.commitMessage(for: [approve, reject]),
                       "phren: myproj(update x2) via ios")
        XCTAssertEqual(PendingOp.commitMessage(for: Array(repeating: complete, count: 12)),
                       "phren: myproj(task x12) via ios")

        // Mixed kinds aggregate per project; projects keep first-seen order.
        XCTAssertEqual(PendingOp.commitMessage(for: [approve, complete, complete]),
                       "phren: myproj(update,task x2) via ios")
        let otherApprove = PendingOp.approveQueue(project: "other", line: "- y")
        XCTAssertEqual(PendingOp.commitMessage(for: [approve, otherApprove, approve]),
                       "phren: myproj(update x2) other(update) via ios")
    }

    func testGitBlobShaMatchesGitObjectIdentity() {
        // Vectors from `git hash-object`: the empty blob and "hello\n".
        XCTAssertEqual(GitBlob.sha(of: ""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
        XCTAssertEqual(GitBlob.sha(of: "hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a")
    }
}
