import XCTest
@testable import PhrenKit

final class OfflineSyncTests: XCTestCase {
    func testFailedWriteWaitsForNextPollAndRetriesAnUnchangedHead() async throws {
        try await verifyRecovery(notModified: false)
    }

    func testFailedWriteRetriesAfterNotModifiedResponse() async throws {
        try await verifyRecovery(notModified: true)
    }

    func testConflictReapplyPreservesQueuedCreationTime() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStore(rootDirectory: root, owner: "o", repo: "r", branch: "main")
        let client = FakeGitHubClient(remote: ["demo/tasks.md": "# Tasks\n\n## Queue\n"])
        let engine = SyncEngine(client: client, store: store, stateDirectory: root)
        await engine.setAutoFlush(false)
        await engine.pull()
        try await engine.enqueue(.addTask(project: "demo", text: "Created before conflict"))
        let queued = await engine.pendingOps()
        let creation = try XCTUnwrap(queued.first?.queuedAt).ISO8601Format(.init(includingFractionalSeconds: true))
        await client.setRemote("demo/tasks.md", "# Tasks\n\n## Queue\n- [ ] From another computer <!-- bid:abcdef01 -->\n")
        await client.failNextPut(on: ["demo/tasks.md"])
        await engine.flushNow()
        let remote = await client.remoteContent("demo/tasks.md")
        let tasks = TasksFile(project: "demo", content: remote ?? "").doc.queue
        XCTAssertEqual(tasks.count, 2)
        XCTAssertEqual(tasks.first { $0.line == "Created before conflict" }?.createdAt, creation)
        XCTAssertNil(tasks.first { $0.stableId == "abcdef01" }?.createdAt)
        let pending = await engine.pendingOps()
        XCTAssertTrue(pending.isEmpty)
    }

    private func verifyRecovery(notModified: Bool) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStore(rootDirectory: root, owner: "o", repo: "r", branch: "main")
        let client = FakeGitHubClient(remote: ["demo/tasks.md": "# Tasks\n\n## Queue\n"])
        let engine = SyncEngine(client: client, store: store, stateDirectory: root)
        await engine.pull()
        await client.setWritesOffline(true)
        try await engine.enqueue(.addTask(project: "demo", text: "Saved in the elevator"))
        // Leave automatic flushing enabled: an offline request must settle,
        // rather than continuously rescheduling itself between sync polls.
        try await Task.sleep(nanoseconds: 150_000_000)
        let attempts = await client.writes.count
        XCTAssertEqual(attempts, 1)
        let queued = await engine.pendingOps()
        XCTAssertEqual(queued.count, 1)
        let expectedCreation = try XCTUnwrap(queued.first?.queuedAt).ISO8601Format(.init(includingFractionalSeconds: true))
        let local = await store.read("demo/tasks.md")
        XCTAssertEqual(TasksFile(project: "demo", content: local ?? "").doc.queue.first?.createdAt, expectedCreation)

        await client.setWritesOffline(false)
        await client.setNotModified(notModified)
        await engine.pull()
        for _ in 0..<100 {
            if await engine.pendingOps().isEmpty { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let remaining = await engine.pendingOps()
        let remote = await client.remoteContent("demo/tasks.md")
        XCTAssertTrue(remaining.isEmpty)
        XCTAssertTrue(remote?.contains("Saved in the elevator") == true)
        XCTAssertEqual(TasksFile(project: "demo", content: remote ?? "").doc.queue.first?.createdAt, expectedCreation)
        await engine.setAutoFlush(false)
        await engine.flushNow()
    }
}
