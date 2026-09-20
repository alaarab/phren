import XCTest
@testable import PhrenKit

/// `phren.project.yaml` is shared property: the CLI writes `sourcePath`,
/// `ownership`, retention/workflow blocks and the knobs; the phone may only
/// touch the knobs. These pin the line-preserving rewrite and the one write op
/// allowed to reach the file.
final class ProjectKnobsTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-knobs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeEngine(local: [String: String])
        async throws -> (SyncEngine, LocalStore, FakeGitHubClient) {
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        for (path, content) in local {
            try await store.write(path, content: content, blobSha: GitBlob.sha(of: content))
        }
        let client = FakeGitHubClient(remote: local)
        let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)
        return (engine, store, client)
    }

    // MARK: - parse

    func testParsesTheFiveKnobsFromTheConfigMapping() {
        let yaml = """
        ownership: repo-managed
        sourcePath: /home/sam/Projects/demo
        config:
          findingSensitivity: balanced
          proactivity: low
          proactivityFindings: "medium" # a note
          proactivityTask: 'high'
          taskMode: manual
          retentionPolicy:
            ttlDays: 90
        """
        XCTAssertEqual(ProjectKnobs.parse(yaml), ProjectKnobs(
            findingSensitivity: .balanced, proactivity: .low,
            proactivityFindings: .medium, proactivityTask: .high, taskMode: .manual
        ))
    }

    func testUnknownValuesAndMissingConfigReadAsUnset() {
        XCTAssertEqual(ProjectKnobs.parse("sourcePath: /home/sam/demo\n"),
                       ProjectKnobs(), "keys outside config: are not knobs")
        XCTAssertEqual(ProjectKnobs.parse("config:\n  taskMode: sometimes\n"),
                       ProjectKnobs(), "an unknown value is not a chosen default")
        XCTAssertEqual(ProjectKnobs.parse(""), ProjectKnobs())
    }

    // MARK: - apply

    func testApplyPreservesUnrelatedLinesAndANestedBlock() {
        let yaml = """
        ownership: repo-managed
        sourcePath: /home/sam/Projects/demo
        config:
          findingSensitivity: balanced
          retentionPolicy:
            ttlDays: 90
            decay:
              d30: 0.9
        """
        let applied = ProjectKnobs(findingSensitivity: .aggressive, taskMode: .suggest).apply(to: yaml)
        XCTAssertEqual(applied, """
        ownership: repo-managed
        sourcePath: /home/sam/Projects/demo
        config:
          findingSensitivity: aggressive
          retentionPolicy:
            ttlDays: 90
            decay:
              d30: 0.9
          taskMode: suggest
        """)
    }

    func testApplyRemovesAKeyWhenTheValueIsNil() {
        let yaml = "config:\n  findingSensitivity: balanced\n  taskMode: auto\n"
        let applied = ProjectKnobs(findingSensitivity: .balanced).apply(to: yaml)
        XCTAssertEqual(applied, "config:\n  findingSensitivity: balanced\n")
        XCTAssertFalse(applied.contains("taskMode"))
    }

    func testApplyToAnEmptyFileCreatesTheConfigBlock() {
        XCTAssertEqual(ProjectKnobs().apply(to: ""), "")
        XCTAssertEqual(ProjectKnobs(proactivity: .low).apply(to: ""),
                       "config:\n  proactivity: low\n")
    }

    func testApplyNormalizesAnEmptyInlineConfig() {
        XCTAssertEqual(ProjectKnobs(taskMode: .off).apply(to: "sourcePath: /home/sam/demo\nconfig: {}\n"),
                       "sourcePath: /home/sam/demo\nconfig:\n  taskMode: off\n")
    }

    func testApplyRoundTripsThroughParse() {
        let yaml = """
        ownership: detached
        config:
          findingSensitivity: conservative
          proactivityFindings: high
        """
        let desired = ProjectKnobs(findingSensitivity: .aggressive, proactivity: .low,
                                   proactivityFindings: .high, proactivityTask: .medium,
                                   taskMode: .auto)
        XCTAssertEqual(ProjectKnobs.parse(desired.apply(to: yaml)), desired)
        // And applying the same knobs again is a no-op, which is what makes the
        // op safe to replay after a lost reply.
        let once = desired.apply(to: yaml)
        XCTAssertEqual(desired.apply(to: once), once)
    }

    // MARK: - Snapshot

    func testSnapshotCarriesParsedKnobsAndTheRawConfig() async throws {
        let content = "sourcePath: /home/sam/demo\nconfig:\n  taskMode: manual\n"
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        try await store.write("demo/phren.project.yaml", content: content, blobSha: nil)

        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.projectKnobs["demo"], ProjectKnobs(taskMode: .manual))
        XCTAssertEqual(snapshot.projectConfigs["demo"], content)
    }

    // MARK: - The write op

    func testSetProjectKnobsWritesTheFileAndPreservesSiblings() async throws {
        let existing = "ownership: repo-managed\nsourcePath: /home/sam/Projects/demo\n"
            + "config:\n  retentionPolicy:\n    ttlDays: 90\n"
        let (engine, store, client) = try await makeEngine(local: ["demo/phren.project.yaml": existing])

        let op = PendingOp.setProjectKnobs(project: "demo",
                                           knobs: ProjectKnobs(findingSensitivity: .aggressive, taskMode: .suggest),
                                           expectedContent: existing)
        try await engine.enqueue(op)

        let read = await store.read("demo/phren.project.yaml")
        let written = try XCTUnwrap(read)
        XCTAssertTrue(written.contains("sourcePath: /home/sam/Projects/demo"))
        XCTAssertTrue(written.contains("ttlDays: 90"))
        XCTAssertTrue(written.contains("findingSensitivity: aggressive"))
        XCTAssertTrue(written.contains("taskMode: suggest"))

        await engine.flushNow()
        let remote = await client.remoteContent("demo/phren.project.yaml")
        XCTAssertEqual(remote, written)
        let pending = await engine.pendingOps()
        XCTAssertTrue(pending.isEmpty)
    }

    func testSetProjectKnobsRefusesAStaleExpectedContent() async throws {
        let (engine, store, _) = try await makeEngine(local: [
            "demo/phren.project.yaml": "config:\n  taskMode: auto\n",
        ])
        do {
            try await engine.enqueue(.setProjectKnobs(
                project: "demo", knobs: ProjectKnobs(taskMode: .off),
                expectedContent: "config:\n  taskMode: manual\n"
            ))
            XCTFail("a stale expectedContent must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("changed since"))
        }
        let unchanged = await store.read("demo/phren.project.yaml")
        XCTAssertEqual(unchanged, "config:\n  taskMode: auto\n")
        let pending = await engine.pendingOps()
        XCTAssertTrue(pending.isEmpty)
    }

    func testSetProjectKnobsRoundTripsThroughTheQueue() async throws {
        let (engine, _, _) = try await makeEngine(local: [:])
        let op = PendingOp.setProjectKnobs(project: "demo",
                                           knobs: ProjectKnobs(proactivity: .low),
                                           expectedContent: nil)
        try await engine.enqueue(op)

        let loaded = PendingOpsQueue.load(from: directory.appendingPathComponent("pending-ops.json"))
        XCTAssertNil(loaded.issue)
        XCTAssertEqual(loaded.queue.schemaVersion, PendingOpsQueue.currentSchemaVersion)
        XCTAssertEqual(loaded.queue.pending.map(\.op), [op])
    }
}
