import XCTest
@testable import PhrenKit

/// The write half of team-store parity: a store whose registry role is `team`
/// must never line-splice `FINDINGS.md` from the phone. That is the race the
/// journal layout exists to prevent — two people capturing findings the same
/// afternoon writing adjacent lines in one shared file.
final class TeamStoreWriteTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-team-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeEngine(client: FakeGitHubClient,
                            usesTeamJournal: Bool) async throws -> (SyncEngine, LocalStore) {
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)
        await engine.setWriteContext(.init(actor: "octocat", machine: "Ala-iPhone",
                                           usesTeamJournal: usesTeamJournal))
        return (engine, store)
    }

    /// `new Date().toISOString().slice(0, 10)` (journal.ts:153) — UTC, not
    /// local, which is what the CLI stamps and therefore what the phone has to
    /// agree with when both write the same day.
    private var today: String {
        String(FindingsFile.isoTimestamp(Date()).prefix(10))
    }

    func testTeamStoreAddWritesTheJournalAndNotFindings() async throws {
        let client = FakeGitHubClient()
        let (engine, store) = try await makeEngine(client: client, usesTeamJournal: true)

        try await engine.enqueue(.addFinding(project: "arc", text: "Ship it", type: "decision"))
        await engine.flushNow()

        let path = "arc/journal/\(today)-octocat.md"
        let written = await store.read(path)
        let content = try XCTUnwrap(written)
        XCTAssertEqual(content, """
        ## \(today) (octocat)

        - [decision] Ship it <!-- source:human machine:Ala-iPhone actor:octocat -->

        """)
        let findingsFile = await store.read("arc/FINDINGS.md")
        XCTAssertNil(findingsFile, "FINDINGS.md must not be touched")

        // And that is what got pushed — one PUT, to the journal.
        let writes = await client.writes
        XCTAssertEqual(writes.map(\.path), [path])
        XCTAssertEqual(writes.first?.message, "phren: arc(findings) via ios")
    }

    /// The same store with journal routing off is the personal-store path,
    /// unchanged.
    func testPersonalStoreAddStillWritesFindings() async throws {
        let client = FakeGitHubClient()
        let (engine, store) = try await makeEngine(client: client, usesTeamJournal: false)

        try await engine.enqueue(.addFinding(project: "arc", text: "Ship it", type: "decision"))
        await engine.flushNow()

        let findingsFile = await store.read("arc/FINDINGS.md")
        XCTAssertTrue(try XCTUnwrap(findingsFile).contains("[decision] Ship it"))
        let journalFile = await store.read("arc/journal/\(today)-octocat.md")
        XCTAssertNil(journalFile)
        let writes = await client.writes
        XCTAssertEqual(writes.map(\.path), ["arc/FINDINGS.md"])
    }

    /// Two adds the same day append to one file with one heading, and coalesce
    /// into a single commit the way two FINDINGS.md adds do.
    func testSameDayAddsAppendToOneFileInOneCommit() async throws {
        let client = FakeGitHubClient()
        let (engine, store) = try await makeEngine(client: client, usesTeamJournal: true)

        try await engine.enqueue(.addFinding(project: "arc", text: "First", type: nil))
        try await engine.enqueue(.addFinding(project: "arc", text: "Second", type: nil))
        await engine.flushNow()

        let path = "arc/journal/\(today)-octocat.md"
        let written = await store.read(path)
        let content = try XCTUnwrap(written)
        XCTAssertEqual(content.components(separatedBy: "\n").filter { $0.hasPrefix("## ") }.count, 1)
        XCTAssertEqual(content.components(separatedBy: "\n").filter { $0.hasPrefix("- ") }.count, 2)

        let writes = await client.writes
        XCTAssertEqual(writes.count, 1, "consecutive adds ride one commit")
        XCTAssertEqual(writes.first?.message, "phren: arc(findings x2) via ios")

        // The round trip: what the phone wrote reads back as findings, dated
        // from the filename and attributed to the actor.
        let snapshot = await store.snapshot()
        let findings = try XCTUnwrap(snapshot.findings["arc"])
        XCTAssertEqual(findings.map(\.text), ["First", "Second"])
        XCTAssertTrue(findings.allSatisfy { $0.journalFile == "\(today)-octocat.md" })
        XCTAssertTrue(findings.allSatisfy { $0.actor == "octocat" })
    }

    /// The whole point of one file per actor per day: this device only ever
    /// appends to its own, so a teammate's file is never rewritten and the two
    /// merge in git rather than conflicting.
    func testAnotherActorsFileIsNeverTouched() async throws {
        let theirs = "arc/journal/\(today)-teammate.md"
        let client = FakeGitHubClient(remote: [
            theirs: "## \(today) (teammate)\n\n- Something they found <!-- source:human actor:teammate -->\n",
        ])
        let (engine, store) = try await makeEngine(client: client, usesTeamJournal: true)
        await engine.pull(force: true)

        try await engine.enqueue(.addFinding(project: "arc", text: "Something I found", type: nil))
        await engine.flushNow()

        let writes = await client.writes
        XCTAssertEqual(writes.map(\.path), ["arc/journal/\(today)-octocat.md"])
        XCTAssertFalse(writes.contains { $0.path == theirs })

        // Both sides show up in one list.
        let snapshot = await store.snapshot()
        let findings = try XCTUnwrap(snapshot.findings["arc"])
        XCTAssertEqual(Set(findings.map(\.text)), ["Something they found", "Something I found"])
    }

    /// A journal file that exists remotely but hasn't been pulled reads as
    /// absent, so the add writes a fresh heading and PUTs without a sha.
    /// GitHub answers 422 and the flush's refetch → re-apply lands the append
    /// on the real file, once.
    func testUnpulledJournalFileRecoversThroughTheConflictPath() async throws {
        let path = "arc/journal/\(today)-octocat.md"
        let existing = "## \(today) (octocat)\n\n- Written from my laptop <!-- source:human actor:octocat -->\n"
        let client = FakeGitHubClient(remote: [path: existing])
        let (engine, store) = try await makeEngine(client: client, usesTeamJournal: true)
        // Deliberately no pull: the phone has never seen this file.
        await client.failNextPut(on: [path])

        try await engine.enqueue(.addFinding(project: "arc", text: "Written from my phone", type: nil))
        await engine.flushNow()

        let remote = await client.remoteContent(path)
        let content = try XCTUnwrap(remote)
        XCTAssertEqual(content, existing
            + "- Written from my phone <!-- source:human machine:Ala-iPhone actor:octocat -->\n")
        XCTAssertEqual(content.components(separatedBy: "\n").filter { $0.hasPrefix("## ") }.count, 1)
        let cached = await store.read(path)
        XCTAssertEqual(try XCTUnwrap(cached), content)

        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0)
        XCTAssertEqual(status.failedCount, 0)
    }

    /// A promotion is a finding-add, so it takes the same route — and the note
    /// is still marked promoted.
    func testPromotedNoteGoesToTheJournal() async throws {
        let client = FakeGitHubClient()
        let (engine, store) = try await makeEngine(client: client, usesTeamJournal: true)

        let stamp = AppModelStamp.now()
        try await engine.enqueue(.addNote(project: "arc", date: stamp.date, time: stamp.time,
                                          text: "A thought worth keeping"))
        let beforeSnapshot = await store.snapshot()
        let notes = try XCTUnwrap(beforeSnapshot.notes["arc"])
        let stableId = try XCTUnwrap(notes.first?.stableId)

        try await engine.enqueue(.promoteNote(project: "arc", date: stamp.date,
                                              stableId: stableId, findingType: "pattern"))
        await engine.flushNow()

        let written = await store.read("arc/journal/\(today)-octocat.md")
        let journal = try XCTUnwrap(written)
        XCTAssertTrue(journal.contains("- [pattern] A thought worth keeping <!-- source:human machine:Ala-iPhone actor:octocat -->"))
        let findingsFile = await store.read("arc/FINDINGS.md")
        XCTAssertNil(findingsFile)
        let afterSnapshot = await store.snapshot()
        XCTAssertTrue(try XCTUnwrap(afterSnapshot.notes["arc"]).first?.promoted ?? false)
    }

    /// A secret is refused before anything is queued. Stricter than the CLI's
    /// team branch, which returns before `addFindingToFile` ever scans — a
    /// shared store is the last place a credential should land.
    func testSecretsAreRefusedOnTheJournalPathToo() async throws {
        let client = FakeGitHubClient()
        let (engine, store) = try await makeEngine(client: client, usesTeamJournal: true)

        do {
            try await engine.enqueue(.addFinding(project: "arc",
                                                 text: "use ghp_0123456789abcdefghijklmnopqrstuvwxyz",
                                                 type: nil))
            XCTFail("a secret must never reach a shared store")
        } catch let error as PhrenKitError {
            guard case .secretDetected = error else { return XCTFail("wrong error: \(error)") }
        }

        let journalFile = await store.read("arc/journal/\(today)-octocat.md")
        XCTAssertNil(journalFile)
        let status = await engine.currentStatus()
        XCTAssertEqual(status.pendingCount, 0)
    }

    /// No GitHub login (a store attached before the user record loaded) still
    /// produces a filename the CLI's reader can split.
    func testMissingActorFallsBackTheWayTheCLIDoes() async throws {
        let client = FakeGitHubClient()
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)
        await engine.setWriteContext(.init(actor: nil, machine: "Ala's iPhone", usesTeamJournal: true))

        try await engine.enqueue(.addFinding(project: "arc", text: "Anonymous", type: nil))

        // machine-identity.ts:41 — `getCurrentActor` falls back to "unknown".
        let path = "arc/journal/\(today)-unknown.md"
        let written = await store.read(path)
        XCTAssertNotNil(written)
        XCTAssertEqual(JournalFile.parseFileName("\(today)-unknown.md")?.actor, "unknown")
    }
}

/// The note timestamp the app stamps, duplicated here rather than reaching
/// into the app target (PhrenKit has no dependency on it). Mirrors
/// `AppModel.nowNoteTimestamp` (notes.ts:181).
private enum AppModelStamp {
    static func now() -> (date: String, time: String) {
        let iso = FindingsFile.isoTimestamp(Date())
        return (String(iso.prefix(10)), String(iso.dropFirst(11).prefix(8)))
    }
}
