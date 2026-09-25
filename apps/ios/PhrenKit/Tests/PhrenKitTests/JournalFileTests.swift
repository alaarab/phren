import XCTest
@testable import PhrenKit

/// The team-store journal is the one format the app both reads *and* writes
/// into a repo several people share, so the write side is pinned byte-for-byte
/// against files produced by the real `appendTeamJournal`
/// (`generate-fixtures.mjs` calling packages/cli/dist/finding/journal.js), and
/// the read side against the JSON `readTeamJournalEntries` returned for them.
final class JournalFileTests: XCTestCase {
    private let date = "2026-07-28"

    // MARK: - Filenames

    func testFileNameRoundTripsTheCLIFormat() {
        XCTAssertEqual(JournalFile.fileName(date: date, actor: "tester"), "2026-07-28-tester.md")
        XCTAssertEqual(JournalFile.path(project: "myproj", date: date, actor: "tester"),
                       "myproj/journal/2026-07-28-tester.md")

        let parsed = JournalFile.parseFileName("2026-07-28-other-actor.md")
        XCTAssertEqual(parsed?.date, "2026-07-28")
        // `(.+)` is greedy, so an actor containing hyphens survives whole.
        XCTAssertEqual(parsed?.actor, "other-actor")

        // Everything the CLI's own regex rejects (journal.ts:196).
        XCTAssertNil(JournalFile.parseFileName("2026-07-28.md"))
        XCTAssertNil(JournalFile.parseFileName("notes.md"))
        XCTAssertNil(JournalFile.parseFileName("26-07-28-tester.md"))
        XCTAssertNil(JournalFile.parseFileName("2026-07-28-tester.txt"))
    }

    /// The CLI's actor is `$USER`; the app's is a GitHub login, or a device
    /// name if there is somehow no login. Whatever it is, it has to stay one
    /// path component and still parse back out of the filename.
    func testActorIsSanitizedIntoAParseableFilename() {
        XCTAssertEqual(JournalFile.sanitizeActor("octocat"), "octocat")
        XCTAssertEqual(JournalFile.sanitizeActor("Ala's iPhone"), "Ala_s_iPhone")
        // Dots survive — the CLI's character class keeps them (journal.ts:37)
        // — but every separator is gone, which is what makes the result a
        // filename rather than a path.
        XCTAssertEqual(JournalFile.sanitizeActor("../../etc/passwd"), ".._.._etc_passwd")
        XCTAssertEqual(JournalFile.sanitizeActor("  "), "unknown")
        XCTAssertEqual(JournalFile.sanitizeActor(nil), "unknown")

        for raw in ["octocat", "Ala's iPhone", "../../etc/passwd", nil] {
            let actor = JournalFile.sanitizeActor(raw)
            let name = JournalFile.fileName(date: date, actor: actor)
            XCTAssertFalse(name.contains("/"), "\(name) must stay one path component")
            let path = JournalFile.path(project: "myproj", date: date, actor: actor)
            XCTAssertEqual(path.split(separator: "/").count, 3, "\(path) must not gain a path segment")
            XCTAssertEqual((path as NSString).standardizingPath, path, "\(path) must not escape upward")
            XCTAssertEqual(JournalFile.parseFileName(name)?.actor, actor)
            XCTAssertTrue(LocalStore.isWritablePath(path))
        }
    }

    // MARK: - Write (byte-identical to appendTeamJournal)

    func testAppendMatchesCLIByteForByte() throws {
        // CLI ran: appendTeamJournal(store, "myproj", <text>, "tester", "test-machine") twice.
        var file = JournalFile(date: date, actor: "tester")
        file.append("[decision] Team stores journal their findings instead of splicing FINDINGS.md",
                    machine: "test-machine")
        file.append("Second entry of the day appends to the same actor file", machine: "test-machine")

        assertSameContent(try XCTUnwrap(file.content),
                          try Fixtures.text("journal-2026-07-28-tester.md"),
                          "journal append")
    }

    /// No machine (the CLI passes `provenance.machine`, which can be absent):
    /// `buildSourceComment` drops the token rather than emitting an empty one.
    func testAppendWithoutMachineMatchesCLIByteForByte() throws {
        var file = JournalFile(date: date, actor: "other-actor")
        file.append("Entry written by a different actor on the same day")

        assertSameContent(try XCTUnwrap(file.content),
                          try Fixtures.text("journal-2026-07-28-other-actor.md"),
                          "journal append without machine")
    }

    /// The heading is written once, when the file is created; every later
    /// append is a bare bullet. Appending onto CLI-written content must
    /// therefore reproduce exactly what a third CLI append would have made.
    func testAppendOntoCLIWrittenFileAddsNoSecondHeading() throws {
        let existing = try Fixtures.text("journal-2026-07-28-tester.md")
        var file = JournalFile(date: date, actor: "tester", content: existing)
        file.append("A third entry, this one from the phone", machine: "test-machine")

        let expected = existing
            + "- A third entry, this one from the phone <!-- source:human machine:test-machine actor:tester -->\n"
        assertSameContent(try XCTUnwrap(file.content), expected, "append onto CLI file")
        XCTAssertEqual(try XCTUnwrap(file.content).components(separatedBy: "\n")
            .filter { $0.hasPrefix("## ") }.count, 1)
    }

    /// `applyFindingTypePrefix` (core/finding.ts:24) — the tag the CLI applies
    /// before it ever reaches `appendTeamJournal`.
    func testPreparedFindingAppliesTheTypePrefixLikeTheCLI() throws {
        XCTAssertEqual(try JournalFile.preparedFinding("Ship it", type: .decision), "[decision] Ship it")
        XCTAssertEqual(try JournalFile.preparedFinding("  Ship it  ", type: nil), "Ship it")
        // Already tagged — with anything at all, per `/^\s*\[[^\]]+\]\s*/`.
        XCTAssertEqual(try JournalFile.preparedFinding("[pitfall] Ship it", type: .decision), "[pitfall] Ship it")
        XCTAssertEqual(try JournalFile.preparedFinding("[whatever] Ship it", type: .decision), "[whatever] Ship it")

        XCTAssertThrowsError(try JournalFile.preparedFinding("   ", type: nil))
    }

    // MARK: - Read (readTeamJournalEntries)

    func testEntriesMatchTheCLIReader() throws {
        guard let expected = try Fixtures.json("journal-parsed.json") as? [[String: Any]] else {
            return XCTFail("bad journal-parsed.json")
        }
        XCTAssertEqual(expected.count, 2)

        for entry in expected {
            let fileName = try XCTUnwrap(entry["file"] as? String)
            let parsedName = try XCTUnwrap(JournalFile.parseFileName(fileName))
            // Date and actor come out of the filename on both sides.
            XCTAssertEqual(parsedName.date, entry["date"] as? String)
            XCTAssertEqual(parsedName.actor, entry["actor"] as? String)

            let file = JournalFile(date: parsedName.date, actor: parsedName.actor,
                                   content: try Fixtures.text("journal-\(fileName)"))
            XCTAssertEqual(file.entries, entry["entries"] as? [String])
        }
    }

    /// Findings for display: the date comes from the filename (the heading
    /// carries an actor suffix `extractDateHeading` rejects), the metadata
    /// comments come off the text, and the provenance survives.
    func testFindingsCarryTheFilenameDateAndProvenance() throws {
        let file = JournalFile(date: date, actor: "tester",
                               content: try Fixtures.text("journal-2026-07-28-tester.md"))
        let findings = file.findings()

        XCTAssertEqual(findings.count, 2)
        XCTAssertEqual(findings.map(\.date), [date, date])
        XCTAssertEqual(findings.map(\.id), ["J1", "J2"])
        XCTAssertEqual(findings[0].text,
                       "[decision] Team stores journal their findings instead of splicing FINDINGS.md")
        XCTAssertEqual(findings[0].typeTag, "decision")
        XCTAssertEqual(findings[0].actor, "tester")
        XCTAssertEqual(findings[0].machine, "test-machine")
        XCTAssertEqual(findings[0].journalFile, "2026-07-28-tester.md")
        XCTAssertTrue(findings.allSatisfy(\.isJournalEntry))
        XCTAssertTrue(findings.allSatisfy { !$0.archived })
        XCTAssertNil(findings[0].stableId, "the CLI stamps no fid on a journal entry")

        // Offsets keep ids unique when a project has several actor-day files.
        XCTAssertEqual(file.findings(idOffset: 5).map(\.id), ["J6", "J7"])
    }

    /// An actor whose entries carry no `<!-- source: -->` at all (a hand-added
    /// line, or a file written before provenance existed) still attributes,
    /// because the filename says who wrote it — same as the CLI's reader.
    func testFindingsFallBackToTheFilenameActor() {
        let file = JournalFile(date: date, actor: "hand-editor", content: """
        ## 2026-07-28 (hand-editor)

        - Someone appended this by hand
        """)
        XCTAssertEqual(file.findings().first?.actor, "hand-editor")
        XCTAssertEqual(file.entries, ["Someone appended this by hand"])
        // Folded from testEmptyFileHasNoEntries.
        do {
            XCTAssertTrue(JournalFile(date: date, actor: "tester").entries.isEmpty)
            XCTAssertTrue(JournalFile(date: date, actor: "tester").findings().isEmpty)
        }
    }
}
