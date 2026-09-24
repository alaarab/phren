import XCTest
@testable import PhrenKit

/// Approve must promote, not discard.
///
/// `phren extract` queues every candidate scoring below `autoAcceptThreshold`
/// into review.md without writing it to FINDINGS.md, so for those the queue
/// line is the only copy (`approveQueueItemDetailed` in data/access.ts). The
/// port used to remove the line and write nothing, and the Review tab makes
/// approving a swipe, so triage could delete extracted findings.
final class ReviewApproveTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-approve-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeEngine(usesTeamJournal: Bool = false) async throws -> (SyncEngine, LocalStore) {
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        let engine = SyncEngine(client: FakeGitHubClient(), store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)
        await engine.setWriteContext(.init(actor: "octocat", machine: "Ala-iPhone",
                                           usesTeamJournal: usesTeamJournal))
        return (engine, store)
    }

    private let queueLine = "- [2026-07-26] [pitfall] Session hooks fire twice when both modes are enabled [confidence 0.60] <!-- source:extract machine:laptop actor:codex -->"

    private func seedQueue(_ store: LocalStore, line: String? = nil) async throws {
        try await store.write("proj/review.md", content: """
        # proj Review Queue

        ## Review

        \(line ?? queueLine)

        ## Stale

        ## Conflicts

        """, blobSha: nil)
    }

    func testApprovingAnExtractionCandidateWritesTheFinding() async throws {
        let (engine, store) = try await makeEngine()
        try await seedQueue(store)
        // No FINDINGS.md at all: the queue line is the only copy of this text.

        try await engine.enqueue(.approveQueue(project: "proj", line: queueLine))
        await engine.flushNow()

        let findingsRaw = await store.read("proj/FINDINGS.md")
        let findings = try XCTUnwrap(findingsRaw,
                                     "approve must create FINDINGS.md, not discard the candidate")
        XCTAssertTrue(findings.contains("- [pitfall] Session hooks fire twice when both modes are enabled"))
        // Written today, but the day it was queued is kept, as the CLI does.
        XCTAssertTrue(findings.contains(#"<!-- phren:queued "2026-07-26" -->"#))
        // The observation's own provenance, not the device that approved it.
        XCTAssertTrue(findings.contains("<!-- source:extract machine:laptop actor:codex -->"))
        XCTAssertFalse(findings.contains("Ala-iPhone"))
        // The confidence marker is queue bookkeeping.
        XCTAssertFalse(findings.contains("confidence"))

        let reviewRaw = await store.read("proj/review.md")
        let review = try XCTUnwrap(reviewRaw)
        XCTAssertFalse(review.contains("Session hooks fire twice"), "the line should be dequeued")
    }

    func testApprovingAnItemAlreadyInFindingsDoesNotDuplicateIt() async throws {
        let (engine, store) = try await makeEngine()
        try await seedQueue(store)
        try await store.write("proj/FINDINGS.md", content: """
        # proj Findings

        ## 2026-07-20

        - [pitfall] Session hooks fire twice when both modes are enabled <!-- fid:11112222 -->

        """, blobSha: nil)

        try await engine.enqueue(.approveQueue(project: "proj", line: queueLine))
        await engine.flushNow()

        let findingsRaw = await store.read("proj/FINDINGS.md")
        let findings = try XCTUnwrap(findingsRaw)
        XCTAssertEqual(findings.components(separatedBy: "Session hooks fire twice").count - 1, 1,
                       "the existing finding should be kept as-is, not duplicated")
        XCTAssertTrue(findings.contains("fid:11112222"))

        let reviewRaw = await store.read("proj/review.md")
        let review = try XCTUnwrap(reviewRaw)
        XCTAssertFalse(review.contains("Session hooks fire twice"))
    }

    func testApprovingIntoATeamStoreWritesTheJournal() async throws {
        let (engine, store) = try await makeEngine(usesTeamJournal: true)
        try await seedQueue(store)

        try await engine.enqueue(.approveQueue(project: "proj", line: queueLine))
        await engine.flushNow()

        let today = String(FindingsFile.isoTimestamp(Date()).prefix(10))
        let journalRaw = await store.read("proj/journal/\(today)-octocat.md")
        let journal = try XCTUnwrap(journalRaw,
                                    "a team-store approve belongs in the journal")
        XCTAssertTrue(journal.contains("Session hooks fire twice when both modes are enabled"))
        let findings = await store.read("proj/FINDINGS.md")
        XCTAssertNil(findings, "team stores never line-splice FINDINGS.md")
        let reviewRaw = await store.read("proj/review.md")
        let review = try XCTUnwrap(reviewRaw)
        XCTAssertFalse(review.contains("Session hooks fire twice"))
    }

    func testApproveKeepsTheQueueLineWhenPromotionFails() async throws {
        let (engine, store) = try await makeEngine()
        let secretLine = "- [2026-07-26] deploy key is sk-ant-api03-" + String(repeating: "A", count: 90)
        try await seedQueue(store, line: secretLine)

        // enqueue applies locally first, so a domain error surfaces here and
        // nothing is queued or written.
        do {
            try await engine.enqueue(.approveQueue(project: "proj", line: secretLine))
            XCTFail("approving a line containing a credential should fail")
        } catch {
            XCTAssertTrue(error is PhrenKitError, "expected a domain error, got \(error)")
        }
        await engine.flushNow()

        let reviewRaw = await store.read("proj/review.md")
        let review = try XCTUnwrap(reviewRaw)
        XCTAssertTrue(review.contains("sk-ant-api03"), "the queue line must survive a failed promotion")
        let findingsAfter = await store.read("proj/FINDINGS.md")
        XCTAssertNil(findingsAfter)
    }

    func testApprovingAnItemOnlyInAnArchiveBlockDequeuesWithoutWriting() async throws {
        let (engine, store) = try await makeEngine()
        try await seedQueue(store)
        let archived = """
        # proj Findings

        <details>
        <summary>Archived 2026-07-01</summary>

        - [pitfall] Session hooks fire twice when both modes are enabled <!-- fid:33334444 -->

        </details>

        """
        try await store.write("proj/FINDINGS.md", content: archived, blobSha: nil)

        try await engine.enqueue(.approveQueue(project: "proj", line: queueLine))
        await engine.flushNow()

        // The CLI's already_archived outcome: the archive is left untouched.
        let findings = await store.read("proj/FINDINGS.md")
        XCTAssertEqual(findings, archived)
        let reviewRaw = await store.read("proj/review.md")
        let review = try XCTUnwrap(reviewRaw)
        XCTAssertFalse(review.contains("Session hooks fire twice"))
    }

    /// The promoted bullet has the CLI's shape: the queued date after any
    /// source comment and before the lifecycle comments, and no confidence.
    func testPromotedBulletMatchesTheCLIFixture() throws {
        let cliLines = try Fixtures.text("findings-after-approve.md").components(separatedBy: "\n")
        let cliIndex = try XCTUnwrap(cliLines.firstIndex { $0.contains("Session hooks fire twice") })

        let line = "- [2026-07-26] [pitfall] Session hooks fire twice when both MCP and hooks mode are enabled [confidence 0.60]"
        var file = FindingsFile(content: "")
        try file.add(project: "myproj", text: ReviewFile.findingsTextFor(lineText: line), options: .init(
            provenance: ReviewFile.capturedProvenanceFor(lineText: line),
            queuedDate: ReviewFile.queuedDateFor(lineText: line),
            now: try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-26T13:00:00Z"))
        ))
        let lines = file.content.components(separatedBy: "\n")
        let index = try XCTUnwrap(lines.firstIndex { $0.contains("Session hooks fire twice") })
        let withoutFid = { (s: String) in JSRegex(#"fid:[0-9a-f]{8}"#).replaceAll(s, with: "fid:X") }
        XCTAssertEqual(withoutFid(lines[index]), withoutFid(cliLines[cliIndex]))
        XCTAssertEqual(lines[index + 1], cliLines[cliIndex + 1])
    }

    /// `findings-after-approve.md` is snapshotted from the CLI's own
    /// `approveQueueItem`, so the fixtures now pin the FINDINGS.md write, not
    /// only the review.md removal.
    func testCLIFixtureShowsApproveWritesTheFinding() throws {
        let cliFindings = try Fixtures.text("findings-after-approve.md")
        let cliReview = try Fixtures.text("review-after-approve.md")

        XCTAssertTrue(cliFindings.contains("Session hooks fire twice when both MCP and hooks mode are enabled"),
                      "the CLI promotes the approved candidate into FINDINGS.md")
        XCTAssertTrue(cliFindings.contains(#"<!-- phren:queued "2026-07-26" -->"#))
        XCTAssertFalse(cliFindings.contains("confidence"))
        XCTAssertFalse(cliReview.contains("Session hooks fire twice"))
    }
}
