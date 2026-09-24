import XCTest
@testable import PhrenKit

final class SnapshotCacheTests: XCTestCase {
    func testStatusChangesReuseSnapshotButLocalEditsInvalidateIt() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStore(rootDirectory: root, owner: "fixture", repo: "brain", branch: "main")
        try await store.write("demo/FINDINGS.md", content: "# Findings\n- First finding\n", blobSha: "one")
        let first = await store.snapshot()
        try await store.updateManifest { $0.lastSyncedAt = Date(); $0.headSha = "two" }
        let unchanged = await store.snapshot()
        XCTAssertEqual(first.revision, unchanged.revision)
        try await store.write("demo/FINDINGS.md", content: "# Findings\n- Changed finding\n", blobSha: nil)
        let edited = await store.snapshot()
        XCTAssertNotEqual(first.revision, edited.revision)
        XCTAssertEqual(edited.findings["demo"]?.first?.text, "Changed finding")
        try await store.delete("demo/FINDINGS.md")
        let deleted = await store.snapshot()
        XCTAssertTrue(deleted.projects.isEmpty)
        XCTAssertNotEqual(edited.revision, deleted.revision)
        try await store.wipe()
        let wiped = await store.snapshot()
        XCTAssertNotEqual(deleted.revision, wiped.revision)
    }

    func testAnotherWriterAndAtomicSameSizeReplacementInvalidateCache() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStore(rootDirectory: root, owner: "fixture", repo: "brain", branch: "main")
        let other = try LocalStore(rootDirectory: root, owner: "fixture", repo: "brain", branch: "main")
        try await store.write("demo/FINDINGS.md", content: "# Findings\n- Alpha\n", blobSha: nil)
        let first = await store.snapshot()
        let file = root.appendingPathComponent("files/demo/FINDINGS.md")
        let date = try XCTUnwrap(file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
        try Data("# Findings\n- Bravo\n".utf8).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: file.path)
        let replacement = await store.snapshot()
        XCTAssertNotEqual(first.revision, replacement.revision)
        XCTAssertEqual(replacement.findings["demo"]?.first?.text, "Bravo")
        try await other.write("another/tasks.md", content: "# Tasks\n## Queue\n- [ ] New task\n", blobSha: nil)
        let added = await store.snapshot()
        XCTAssertEqual(added.tasks["another"]?.queue.first?.line, "New task")
        XCTAssertNotEqual(added.revision, replacement.revision)
    }

    func testWarmLargeSnapshotRetainsRevisionAndGraphIdentity() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStore(rootDirectory: root, owner: "fixture", repo: "brain", branch: "main")
        let content = "# Findings\n## 2026-09-11\n" + (0..<2_000).map { "- [decision] Finding \($0) keeps its original source.\n" }.joined()
        try await store.write("demo/FINDINGS.md", content: content, blobSha: nil)
        let start = Date()
        let first = await store.snapshot()
        let cold = Date().timeIntervalSince(start)
        let warmStart = Date()
        for _ in 0..<10 {
            let next = await store.snapshot()
            XCTAssertEqual(first.revision, next.revision)
        }
        let warm = Date().timeIntervalSince(warmStart) / 10
        print("Snapshot sample: 2000 findings, cold \(cold)s, warm mean \(warm)s")
        let input = await store.graphInput(storeName: "fixture/brain")
        let rebuilt = GraphBuilder.build(input, focusProject: nil)
        XCTAssertEqual(first.findings["demo"]?.count, 2_000)
        XCTAssertFalse(rebuilt.nodes.isEmpty)
    }

    func testRegexCacheKeepsOptionSemanticsSeparate() {
        XCTAssertTrue(JSRegex("hello").regex === JSRegex("hello").regex)
        XCTAssertFalse(JSRegex("hello").test("HELLO"))
        XCTAssertTrue(JSRegex("hello", caseInsensitive: true).test("HELLO"))
        XCTAssertFalse(JSRegex("^hello$").test("first\nhello\nlast"))
        XCTAssertTrue(JSRegex(multiline: "^hello$").test("first\nhello\nlast"))
    }
}
