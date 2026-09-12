import XCTest
@testable import PhrenKit

final class AuthoredFileTests: XCTestCase {
    private var directory: URL!
    private let skillPath = "demo/skills/audit.md"
    private let instructionsPath = "demo/CLAUDE.md"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("phren-authored-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    private func makeEngine(local: [String: String], remote: [String: String]? = nil)
        async throws -> (SyncEngine, LocalStore, FakeGitHubClient) {
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        for (path, content) in local {
            try await store.write(path, content: content, blobSha: GitBlob.sha(of: content))
        }
        let client = FakeGitHubClient(remote: remote ?? local)
        let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)
        return (engine, store, client)
    }

    func testOnlyCanonicalInstructionsAndSkillPathsAreEditable() {
        for path in ["global/CLAUDE.md", instructionsPath, skillPath, "global/skills/audit/SKILL.md"] {
            XCTAssertTrue(LocalStore.isWritablePath(path), path)
            XCTAssertTrue(LocalStore.isSyncedPath(path), path)
        }
        for path in ["CLAUDE.md", "/demo/CLAUDE.md", "demo//CLAUDE.md", "demo/../CLAUDE.md",
                     "demo/AGENTS.md", "demo/GEMINI.md", "profiles/CLAUDE.md", "demo.archived/CLAUDE.md",
                     "global/FINDINGS.md", "global/skills//audit.md", "/global/skills/audit.md",
                     "global/skills/audit.md/", "demo/skills/audit/script.sh"] {
            XCTAssertFalse(LocalStore.isWritablePath(path), path)
        }
    }

    func testStaleUpdatesDeletesAndCreatesAreRejected() {
        for content: String? in ["Phone draft", nil] {
            XCTAssertThrowsError(try AuthoredFile.validate(path: skillPath, current: "Remote draft",
                                                           expected: "Opened draft", content: content))
        }
        XCTAssertThrowsError(try AuthoredFile.validate(path: skillPath, current: "Existing",
                                                       expected: nil, content: "New"))
        XCTAssertNoThrow(try AuthoredFile.validate(path: skillPath, current: "Already saved",
                                                  expected: "Old", content: "Already saved"))
        XCTAssertNoThrow(try AuthoredFile.validate(path: skillPath, current: nil, expected: "Old", content: nil))
        XCTAssertThrowsError(try AuthoredFile.validate(path: instructionsPath, current: nil,
                                                       expected: nil, content: " \n\t"))
        XCTAssertThrowsError(try AuthoredFile.validate(path: "demo/tasks.md", current: nil,
                                                       expected: nil, content: "Wrong editor"))
    }

    func testCreateKeepsInstructionsVerbatimAndSurvivesQueueReload() async throws {
        let (engine, store, _) = try await makeEngine(local: [:])
        let content = "---\ncustom: { nested: true }\n---\n\n# Rules\n<!-- keep this -->\nUse the project's scripts.\n"
        let op = PendingOp.saveAuthoredFile(path: instructionsPath, content: content, expectedContent: nil)
        try await engine.enqueue(op)
        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.instructions["demo"], content)
        let loaded = PendingOpsQueue.load(from: directory.appendingPathComponent("pending-ops.json"))
        XCTAssertNil(loaded.issue)
        XCTAssertEqual(loaded.queue.schemaVersion, PendingOpsQueue.currentSchemaVersion)
        XCTAssertEqual(loaded.queue.pending.map(\.op), [op])
    }

    func testRejectsSameSkillNameAcrossCaseAndFileShapes() async throws {
        let (engine, store, _) = try await makeEngine(local: ["demo/skills/Audit/SKILL.md": "Original"])
        do {
            try await engine.enqueue(.saveAuthoredFile(path: skillPath, content: "New", expectedContent: nil))
            XCTFail("Creation must not shadow the folder skill")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("already exists"))
        }
        let content = await store.read(skillPath)
        let pending = await engine.pendingOps()
        XCTAssertNil(content)
        XCTAssertTrue(pending.isEmpty)
        XCTAssertNil(AuthoredFile.conflictingSkillPath(for: skillPath, among: ["global/skills/audit.md"]))
    }

    func testMoveSkillCreatesBeforeDeletingAndCarriesItsSetting() async throws {
        let content = "---\nname: audit\ndescription: 'x'\n---\n\nRules\n"
        let preferences = "{\n  \"enabledSkills\" : {\n    \"demo:audit\" : false\n  },\n  \"schemaVersion\" : 1\n}\n"
        let (engine, store, client) = try await makeEngine(local: [skillPath: content, SkillPreferences.path: preferences])
        let skill = try XCTUnwrap(Skill.parse(path: skillPath, content: content))
        try await engine.moveSkill(skill, to: "other")

        let pending = await engine.pendingOps().map(\.op)
        XCTAssertEqual(pending, [
            .saveAuthoredFile(path: "other/skills/audit.md", content: content, expectedContent: nil),
            .deleteAuthoredFile(path: skillPath, expectedContent: content),
            .setSkillEnabled(scope: "other", name: "audit", enabled: false, expectedEnabled: nil),
        ])
        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.skills.map(\.path), ["other/skills/audit.md"])
        let moved = try SkillPreferences.parse(await store.read(SkillPreferences.path))
        XCTAssertEqual(moved.explicitSetting(scope: "other", name: "audit"), false)

        await engine.flushNow()
        let remote = await client.remoteContent("other/skills/audit.md")
        let old = await client.remoteContent(skillPath)
        XCTAssertEqual(remote, content)
        XCTAssertNil(old)
    }

    func testMoveSkillKeepsFolderShapeAndRefusesOccupiedDestination() async throws {
        let folderPath = "demo/skills/audit/SKILL.md"
        let (engine, store, _) = try await makeEngine(local: [folderPath: "Folder", "global/skills/Audit.md": "Taken"])
        let skill = try XCTUnwrap(Skill.parse(path: folderPath, content: "Folder"))
        do {
            try await engine.moveSkill(skill, to: "global")
            XCTFail("Must not shadow the existing global skill")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("already exists"))
        }
        let untouched = await store.read(folderPath)
        let pending = await engine.pendingOps()
        XCTAssertEqual(untouched, "Folder")
        XCTAssertTrue(pending.isEmpty)

        try await engine.moveSkill(skill, to: "other")
        let paths = await store.snapshot().skills.map(\.path).sorted()
        XCTAssertEqual(paths, ["global/skills/Audit.md", "other/skills/audit/SKILL.md"])
    }

    func testBackgroundPullPreservesPendingDraftAndOriginalSHA() async throws {
        let (engine, store, client) = try await makeEngine(local: [instructionsPath: "Opened"])
        let op = PendingOp.saveAuthoredFile(path: instructionsPath, content: "Phone", expectedContent: "Opened")
        try await engine.enqueue(op)
        await client.setRemote(instructionsPath, "Computer")
        await engine.pull(force: true)
        let local = await store.read(instructionsPath)
        let sha = await store.blobSha(for: instructionsPath)
        XCTAssertEqual(local, "Phone")
        XCTAssertEqual(sha, GitBlob.sha(of: "Opened"))

        await client.failNextPut(on: [instructionsPath])
        await engine.flushNow()
        let remote = await client.remoteContent(instructionsPath)
        let failed = await engine.failedOps()
        let current = await store.read(instructionsPath)
        XCTAssertEqual(remote, "Computer")
        XCTAssertEqual(current, "Computer")
        XCTAssertEqual(failed.map(\.op), [op])
        XCTAssertEqual(failed.first?.paths, [])
        let persisted = PendingOpsQueue.load(from: directory.appendingPathComponent("pending-ops.json"))
        XCTAssertEqual(persisted.queue.failed.map(\.op), [op], "The phone draft must remain recoverable after restart")
    }

    func testSequentialOfflineEditsCoalesce() async throws {
        let (engine, _, client) = try await makeEngine(local: [skillPath: "Opened"])
        try await engine.enqueue(.saveAuthoredFile(path: skillPath, content: "Draft one", expectedContent: "Opened"))
        try await engine.enqueue(.saveAuthoredFile(path: skillPath, content: "Draft two", expectedContent: "Draft one"))
        await engine.flushNow()
        let writes = await client.writes(to: skillPath)
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.content, "Draft two")
        let pending = await engine.pendingOps()
        XCTAssertTrue(pending.isEmpty)
    }

    func testDeleteDoesNotRemoveAConcurrentRemoteEdit() async throws {
        let (engine, _, client) = try await makeEngine(local: [skillPath: "Opened"])
        try await engine.enqueue(.deleteAuthoredFile(path: skillPath, expectedContent: "Opened"))
        await client.setRemote(skillPath, "Computer")
        await client.failNextPut(on: [skillPath])
        await engine.flushNow()
        let remote = await client.remoteContent(skillPath)
        let failed = await engine.failedOps()
        XCTAssertEqual(remote, "Computer")
        XCTAssertEqual(failed.count, 1)
    }

    func testConcurrentRemoteCreationIsNotOverwritten() async throws {
        let (engine, _, client) = try await makeEngine(local: [:])
        try await engine.enqueue(.saveAuthoredFile(path: skillPath, content: "Phone", expectedContent: nil))
        await client.setRemote(skillPath, "Computer")
        await client.failNextPut(on: [skillPath])
        await engine.flushNow()
        let remote = await client.remoteContent(skillPath)
        let failed = await engine.failedOps()
        XCTAssertEqual(remote, "Computer")
        XCTAssertEqual(failed.count, 1)
    }

    func testRemoteDeletionDoesNotResurrectAnEditedFile() async throws {
        let (engine, store, client) = try await makeEngine(local: [skillPath: "Opened"], remote: [:])
        try await engine.enqueue(.saveAuthoredFile(path: skillPath, content: "Phone", expectedContent: "Opened"))
        await client.failNextPut(on: [skillPath])
        await engine.flushNow()
        let remote = await client.remoteContent(skillPath)
        let local = await store.read(skillPath)
        let failed = await engine.failedOps()
        XCTAssertNil(remote)
        XCTAssertNil(local)
        XCTAssertEqual(failed.count, 1)
    }

    func testConflictStillAllowsUnrelatedTaskToSync() async throws {
        let (engine, _, client) = try await makeEngine(local: [skillPath: "Opened"])
        try await engine.enqueue(.saveAuthoredFile(path: skillPath, content: "Phone", expectedContent: "Opened"))
        try await engine.enqueue(.addTask(project: "other", text: "Review the app"))
        await client.setRemote(skillPath, "Computer")
        await client.failNextPut(on: [skillPath])
        await engine.flushNow()
        let remote = await client.remoteContent("other/tasks.md")
        let failed = await engine.failedOps()
        XCTAssertTrue(remote?.contains("Review the app") == true)
        XCTAssertEqual(failed.count, 1)
    }

    func testSkillDescriptionQuotesCannotBecomeYAMLFields() {
        let summary = "Use the agent's checks: build # first\nthen review"
        let content = SkillFile.template(name: "audit", description: summary, instructions: "# Audit\n\nRead the code.")
        let parsed = Skill.parse(path: skillPath, content: content)
        XCTAssertEqual(parsed?.summary, "Use the agent's checks: build # first then review")
        XCTAssertEqual(SkillFile.frontmatterWarnings(for: content), [])
    }
}
