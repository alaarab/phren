import XCTest
@testable import PhrenKit

final class StoreAndSearchTests: XCTestCase {
    func testWritablePathWhitelist() {
        XCTAssertTrue(LocalStore.isWritablePath("myproj/FINDINGS.md"))
        XCTAssertTrue(LocalStore.isWritablePath("myproj/tasks.md"))
        XCTAssertTrue(LocalStore.isWritablePath("myproj/review.md"))
        XCTAssertTrue(LocalStore.isWritablePath("myproj/notes/2026-07-26.md"))
        // A team store's finding-adds land here instead of in FINDINGS.md
        // (tools/finding.ts:186), so the phone has to be able to push it.
        XCTAssertTrue(LocalStore.isWritablePath("myproj/journal/2026-07-26-actor.md"))

        XCTAssertFalse(LocalStore.isWritablePath("phren.root.yaml"))
        XCTAssertFalse(LocalStore.isWritablePath("stores.yaml"))
        XCTAssertFalse(LocalStore.isWritablePath(".phren-team.yaml"))
        XCTAssertTrue(LocalStore.isWritablePath("myproj/AGENTS.md"))
        XCTAssertFalse(LocalStore.isWritablePath("myproj/summary.md"))
        XCTAssertFalse(LocalStore.isWritablePath("myproj/truths.md"))
        XCTAssertFalse(LocalStore.isWritablePath("myproj/reference/topic.md"))
        // Only the CLI's own filename shape, and only one level down.
        XCTAssertFalse(LocalStore.isWritablePath("myproj/journal/notes.md"))
        XCTAssertFalse(LocalStore.isWritablePath("myproj/journal/2026-07-26.md"))
        XCTAssertFalse(LocalStore.isWritablePath("myproj/journal/nested/2026-07-26-actor.md"))
        XCTAssertFalse(LocalStore.isWritablePath(".config/access-control.json"))
        XCTAssertFalse(LocalStore.isWritablePath("myproj.archived/FINDINGS.md"))

        // `global` became *readable* (it holds the consolidate skill's
        // cross-project findings) without becoming writable. These are the
        // assertions that fail the moment someone "simplifies" the split by
        // relaxing isProjectDirName, which isWritablePath delegates to.
        XCTAssertFalse(LocalStore.isWritablePath("global/FINDINGS.md"))
        XCTAssertTrue(LocalStore.isWritablePath("global/AGENTS.md"))
        XCTAssertFalse(LocalStore.isWritablePath("global/tasks.md"))
        XCTAssertFalse(LocalStore.isWritablePath("global/review.md"))
        XCTAssertFalse(LocalStore.isWritablePath("global/notes/2026-07-26.md"))
        // Journal routing is store-wide, so this is the assertion that keeps a
        // team store from making the cross-project tier writable by the back
        // door: `journal/` is gated on the same isProjectDirName as everything
        // else here.
        XCTAssertFalse(LocalStore.isWritablePath("global/journal/2026-07-26-actor.md"))

        // The cold tier is read-only everywhere, at every depth.
        for path in [
            "myproj/reference/topics/architecture.md",
            "myproj/reference/topics/general.md",
            "myproj/reference/index.md",
            "global/reference/topics/general.md",
        ] {
            XCTAssertFalse(LocalStore.isWritablePath(path), "\(path) must never be writable")
        }
    }

    /// The reserved-directory set mirrors the CLI's `RESERVED_PROJECT_DIR_NAMES`
    /// (phren-core.ts:32) plus `scripts` (link.ts:202). Nothing under any of
    /// them is a project, so nothing under any of them syncs or writes.
    func testReservedDirectoriesAreNeitherSyncedNorWritable() {
        for reserved in ["profiles", "templates", "scripts", ".config", ".runtime", ".sessions"] {
            for leaf in ["FINDINGS.md", "tasks.md", "review.md", "summary.md", "AGENTS.md", "truths.md"] {
                let path = "\(reserved)/\(leaf)"
                XCTAssertFalse(LocalStore.isSyncedPath(path), "\(path) must not sync")
                XCTAssertFalse(LocalStore.isWritablePath(path), "\(path) must not be writable")
            }
            for nested in ["notes/2026-07-26.md", "journal/2026-07-26-actor.md"] {
                let path = "\(reserved)/\(nested)"
                XCTAssertFalse(LocalStore.isSyncedPath(path), "\(path) must not sync")
                XCTAssertFalse(LocalStore.isWritablePath(path), "\(path) must not be writable")
            }
            XCTAssertFalse(LocalStore.isReadableProjectDirName(reserved), "\(reserved) is not a project")
        }
    }

    func testGlobalSyncsAsAReadOnlyProject() {
        XCTAssertTrue(LocalStore.isSyncedPath("global/FINDINGS.md"))
        XCTAssertTrue(LocalStore.isSyncedPath("global/AGENTS.md"))
        // Only those two: `global`'s tasks/review/notes are CLI machinery with
        // no phone surface, and paying for them would be paying for nothing.
        XCTAssertFalse(LocalStore.isSyncedPath("global/tasks.md"))
        XCTAssertFalse(LocalStore.isSyncedPath("global/review.md"))
        XCTAssertFalse(LocalStore.isSyncedPath("global/summary.md"))
        XCTAssertFalse(LocalStore.isSyncedPath("global/notes/2026-07-26.md"))
        XCTAssertFalse(LocalStore.isSyncedPath("global/journal/2026-07-26-actor.md"))
        XCTAssertFalse(LocalStore.isSyncedPath("global/reference/topics/general.md"))

        XCTAssertTrue(LocalStore.isReadableProjectDirName("global"))
        XCTAssertTrue(LocalStore.isReadOnlyProject("global"))
        XCTAssertFalse(LocalStore.isReadOnlyProject("myproj"))
        // A name that isn't a project at all is not "a read-only project".
        XCTAssertFalse(LocalStore.isReadOnlyProject("profiles"))
    }

    func testAgentInstructionsPreferAgentsAndRetainLegacyFallbackPath() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-instructions-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: "r", branch: "main")

        try await store.write("legacy/CLAUDE.md", content: "# Legacy", blobSha: nil)
        var snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.instructions["legacy"], "# Legacy")
        XCTAssertEqual(snapshot.instructionPaths["legacy"], "legacy/CLAUDE.md")

        try await store.write("legacy/AGENTS.md", content: "# Canonical", blobSha: nil)
        snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.instructions["legacy"], "# Canonical")
        XCTAssertEqual(snapshot.instructionPaths["legacy"], "legacy/AGENTS.md")
        let retainedLegacy = await store.read("legacy/CLAUDE.md")
        XCTAssertEqual(retainedLegacy, "# Legacy")
    }

    /// The bug this branch exists for: `journal/` used to be excluded from the
    /// hot tier, so a project in a team store — where the CLI puts *every*
    /// added finding — rendered as empty on the phone.
    func testJournalIsInTheHotTier() {
        XCTAssertTrue(LocalStore.isSyncedPath("myproj/journal/2026-07-26-actor.md"))
        XCTAssertTrue(LocalStore.isSyncedPath(".phren-team.yaml"))

        XCTAssertFalse(LocalStore.isSyncedPath("myproj/journal/README.md"))
        XCTAssertFalse(LocalStore.isSyncedPath("myproj/journal/nested/2026-07-26-actor.md"))
        // Still not the cold tier, and still not the runtime journal.
        XCTAssertFalse(LocalStore.isSyncedPath(".runtime/finding-journal/myproj/session.jsonl"))
    }

    func testJournalFindingsMergeIntoTheProjectsFindings() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: "r", branch: "main")

        try await store.write("myproj/FINDINGS.md",
                              content: try Fixtures.text("findings-after-remove.md"), blobSha: "sha1")
        try await store.write("myproj/journal/2026-07-28-tester.md",
                              content: try Fixtures.text("journal-2026-07-28-tester.md"), blobSha: "sha2")
        try await store.write("myproj/journal/2026-07-28-other-actor.md",
                              content: try Fixtures.text("journal-2026-07-28-other-actor.md"), blobSha: "sha3")

        let snapshot = await store.snapshot()
        let findings = try XCTUnwrap(snapshot.findings["myproj"])
        XCTAssertEqual(findings.count, 5, "2 from FINDINGS.md + 3 from two journal files")
        XCTAssertEqual(snapshot.projects.first?.findingCount, 5)

        // FINDINGS.md first, then journal files newest-actor-day first
        // (journal.ts:184 sorts filenames and reverses).
        XCTAssertEqual(findings.map(\.journalFile), [
            nil, nil,
            "2026-07-28-tester.md", "2026-07-28-tester.md",
            "2026-07-28-other-actor.md",
        ])
        // Ids stay unique across both sources, which is what SearchIndex keys
        // an fid-less finding by.
        XCTAssertEqual(Set(findings.map(\.id)).count, findings.count)
        XCTAssertEqual(findings.suffix(3).map(\.id), ["J1", "J2", "J3"])

        // Journal findings are live knowledge, so they are searchable — the
        // opposite of the cold tier.
        let index = SearchIndex(snapshot: snapshot)
        let hit = try XCTUnwrap(index.search("splicing").first)
        XCTAssertEqual(hit.kind, .finding)
        XCTAssertEqual(hit.date, "2026-07-28")
        XCTAssertEqual(hit.typeTag, "decision")
    }

    /// A project that exists *only* as a journal still shows up — the real
    /// shape of a project in a shared store that nobody has consolidated yet.
    func testJournalOnlyProjectIsNotEmpty() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: "r", branch: "main")

        try await store.write("arc/journal/2026-07-28-tester.md",
                              content: try Fixtures.text("journal-2026-07-28-tester.md"), blobSha: "sha1")

        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.projects.map(\.name), ["arc"])
        XCTAssertEqual(snapshot.findings["arc"]?.count, 2)
        XCTAssertNil(snapshot.consolidated["arc"])
    }

    func testGlobalFindingsAppearInTheSnapshot() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: "r", branch: "main")

        try await store.write("global/FINDINGS.md",
                              content: try Fixtures.text("findings-after-remove.md"), blobSha: "sha1")
        try await store.write("myproj/FINDINGS.md",
                              content: try Fixtures.text("findings-after-remove.md"), blobSha: "sha2")

        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.projects.map(\.name), ["global", "myproj"])
        XCTAssertEqual(snapshot.findings["global"]?.count, 2)
    }

    /// The engine refuses a write to a read-only tier *before* applying it
    /// locally, so the edit is never shown as accepted and then parked.
    func testEnqueueRefusesReadOnlyProject() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: "r", branch: "main")
        try await store.write("global/FINDINGS.md",
                              content: try Fixtures.text("findings-after-remove.md"), blobSha: "sha1")
        let engine = SyncEngine(client: FakeGitHubClient(), store: store, stateDirectory: dir)
        await engine.setAutoFlush(false)

        do {
            try await engine.enqueue(.addFinding(project: "global", text: "from the phone", type: nil))
            XCTFail("global must refuse writes")
        } catch let error as PhrenKitError {
            XCTAssertEqual(error, .validation("\"global\" is read-only in the app — edit it with the phren CLI."))
        }

        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0, "a refused op must not be queued")
        let content = await store.read("global/FINDINGS.md")
        XCTAssertFalse(content?.contains("from the phone") ?? true, "and must not touch the local cache")
    }

    func testSnapshotParsesFixtureStore() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: "r", branch: "main")

        try await store.write("myproj/FINDINGS.md",
                              content: try Fixtures.text("findings-after-remove.md"), blobSha: "sha1")
        try await store.write("myproj/tasks.md",
                              content: try Fixtures.text("tasks-after-update.md"), blobSha: "sha2")
        try await store.write("myproj/review.md",
                              content: try Fixtures.text("review-seeded.md"), blobSha: "sha3")
        try await store.write("myproj/notes/2026-07-25.md",
                              content: try Fixtures.text("notes-after-edit-promote.md"), blobSha: "sha4")

        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.projects.map(\.name), ["myproj"])
        XCTAssertEqual(snapshot.findings["myproj"]?.count, 2)
        XCTAssertEqual(snapshot.tasks["myproj"]?.active.count, 1)
        XCTAssertEqual(snapshot.notes["myproj"]?.count, 2)
        XCTAssertEqual(snapshot.reviewQueue.count, 3)
        // Review section sorts before Stale (access.ts:797).
        XCTAssertEqual(snapshot.reviewQueue.first?.item.section, .review)
        XCTAssertEqual(snapshot.reviewQueue.last?.item.section, .stale)
        // Manifest sha bookkeeping survives.
        let sha = await store.blobSha(for: "myproj/FINDINGS.md")
        XCTAssertEqual(sha, "sha1")
    }

    /// `truths.md` has been downloaded since the first release and parsed into
    /// nothing. Shape is `upsertCanonical`'s (learning.ts:269).
    func testTruthsAreParsedAndSearchable() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: "r", branch: "main")

        try await store.write("myproj/truths.md", content: """
        # myproj Truths

        ## Truths

        - Postgres is the only datastore; no Redis _(added 2026-07-30)_
        - Every deploy goes through the staging gate _(added 2026-01-04)_
        - A truth someone hand-wrote without the added stamp
        """, blobSha: "sha1")

        let snapshot = await store.snapshot()
        let truths = try XCTUnwrap(snapshot.truths["myproj"])
        XCTAssertEqual(truths.count, 3)
        XCTAssertEqual(truths[0].text, "Postgres is the only datastore; no Redis")
        XCTAssertEqual(truths[0].addedDate, "2026-07-30")
        // The stamp is phren's bookkeeping, not part of the pinned text.
        XCTAssertFalse(truths[0].text.contains("added"))
        XCTAssertNil(truths[2].addedDate)
        XCTAssertEqual(truths[2].text, "A truth someone hand-wrote without the added stamp")

        // Truths are the *most* live knowledge in a store, so unlike archived
        // findings they belong in the index.
        let index = SearchIndex(snapshot: snapshot)
        let hits = index.search("postgres")
        XCTAssertEqual(hits.first?.kind, .truth)
        XCTAssertEqual(hits.first?.date, "2026-07-30")
        XCTAssertTrue(index.search("staging gate", kind: .truth).count == 1)
        XCTAssertTrue(index.search("staging gate", kind: .finding).isEmpty)
    }

    func testSearchIndex() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: "r", branch: "main")
        try await store.write("myproj/FINDINGS.md",
                              content: try Fixtures.text("findings-after-remove.md"), blobSha: nil)
        try await store.write("myproj/tasks.md",
                              content: try Fixtures.text("tasks-after-update.md"), blobSha: nil)

        let index = SearchIndex(snapshot: await store.snapshot())
        let jwt = index.search("jwt expiry")
        XCTAssertEqual(jwt.first?.kind, .finding)
        XCTAssertTrue(jwt.first?.text.contains("JWT expiry") ?? false)

        // Prefix match on the trailing token while typing.
        XCTAssertFalse(index.search("valida").isEmpty)

        // Kind + project filters.
        XCTAssertTrue(index.search("flaky", kind: .task).allSatisfy { $0.kind == .task })
        XCTAssertTrue(index.search("jwt", project: "other-project").isEmpty)
    }
}
