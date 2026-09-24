import XCTest
@testable import PhrenKit

/// Each queued op reaches the remote exactly once. An op is applied to the
/// local cache when it is enqueued; the flush must push those bytes, not apply
/// the op again on top of them (an add would land twice or park as a
/// duplicate). Only a conflict pull may recompute, and then from the fresh
/// remote content.
final class SyncEngineSingleApplyTests: XCTestCase {
    private var directory: URL!

    private static let findingsSeed = """
    # myproj Findings

    ## 2026-07-26

    - Existing finding about the build <!-- fid:0a1b2c3d -->

    """

    private static let tasksSeed = """
    # myproj tasks

    ## Active

    - [ ] Ship the iOS app [high] <!-- bid:aa853063 rank:1 -->

    ## Queue

    ## Done

    """

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-single-apply-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Local and remote start identical, as after a clean pull.
    private func makeEngine(_ files: [String: String]) async throws -> (SyncEngine, FakeGitHubClient) {
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        for (path, content) in files {
            try await store.write(path, content: content, blobSha: GitBlob.sha(of: content))
        }
        let client = FakeGitHubClient(remote: files)
        let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)
        return (engine, client)
    }

    private func occurrences(of text: String, in content: String?) -> Int {
        (content ?? "").components(separatedBy: text).count - 1
    }

    func testAddedTaskIsPushedOnce() async throws {
        let (engine, client) = try await makeEngine(["myproj/tasks.md": Self.tasksSeed])

        try await engine.enqueue(.addTask(project: "myproj", text: "Write the single-apply test"))
        await engine.flushNow()

        let remote = await client.remoteContent("myproj/tasks.md")
        XCTAssertEqual(occurrences(of: "Write the single-apply test", in: remote), 1)
        let writes = await client.writes
        XCTAssertEqual(writes.count, 1)
        let failed = await engine.failedOps()
        XCTAssertTrue(failed.isEmpty)
    }

    func testAddedFindingIsPushedOnceAndNotParkedAsDuplicate() async throws {
        let (engine, client) = try await makeEngine(["myproj/FINDINGS.md": Self.findingsSeed])

        try await engine.enqueue(.addFinding(project: "myproj", text: "Queued edits reach the remote exactly once", type: nil))
        await engine.flushNow()

        let remote = await client.remoteContent("myproj/FINDINGS.md")
        XCTAssertEqual(occurrences(of: "Queued edits reach the remote exactly once", in: remote), 1)
        let failed = await engine.failedOps()
        XCTAssertTrue(failed.isEmpty, "the finding must push, not park as a duplicate of itself")
    }

    func testAddedNoteIsPushedOnce() async throws {
        let (engine, client) = try await makeEngine([:])

        try await engine.enqueue(.addNote(project: "myproj", date: "2026-09-23", time: "10:00", text: "A note written once"))
        await engine.flushNow()

        let remote = await client.remoteContent("myproj/notes/2026-09-23.md")
        XCTAssertEqual(occurrences(of: "A note written once", in: remote), 1)
        let failed = await engine.failedOps()
        XCTAssertTrue(failed.isEmpty)
    }

    func testRemovedTaskIsPushedWithoutParking() async throws {
        let (engine, client) = try await makeEngine(["myproj/tasks.md": Self.tasksSeed])

        try await engine.enqueue(.removeTask(project: "myproj", match: "Ship the iOS app"))
        await engine.flushNow()

        let remote = await client.remoteContent("myproj/tasks.md")
        XCTAssertEqual(occurrences(of: "Ship the iOS app", in: remote), 0)
        let failed = await engine.failedOps()
        XCTAssertTrue(failed.isEmpty, "the flush must not look for the task the op already removed")
    }

    /// The conflict path recomputes, but from the pulled remote content, not
    /// from the local copy that already carries the edit.
    func testAddedTaskIsPushedOnceAfterAConflict() async throws {
        let (engine, client) = try await makeEngine(["myproj/tasks.md": Self.tasksSeed])
        await client.setRemote("myproj/tasks.md", Self.tasksSeed.replacingOccurrences(
            of: "## Queue\n", with: "## Queue\n\n- [ ] Added on another machine <!-- bid:bb000001 -->\n"))
        await client.failNextPut(on: ["myproj/tasks.md"])

        try await engine.enqueue(.addTask(project: "myproj", text: "Write the single-apply test"))
        await engine.flushNow()

        let remote = await client.remoteContent("myproj/tasks.md")
        XCTAssertEqual(occurrences(of: "Write the single-apply test", in: remote), 1)
        XCTAssertEqual(occurrences(of: "Added on another machine", in: remote), 1)
        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0)
        XCTAssertEqual(status.failedCount, 0)
    }

    func testASecondFlushPushesNothing() async throws {
        let (engine, client) = try await makeEngine(["myproj/tasks.md": Self.tasksSeed])

        try await engine.enqueue(.addTask(project: "myproj", text: "Write the single-apply test"))
        await engine.flushNow()
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.count, 1)
    }
}
