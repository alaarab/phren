import XCTest
@testable import PhrenKit

/// Every fixture here was produced by the actual CLI (`generate-fixtures.mjs`
/// calling packages/cli/dist). Mutation tests assert byte-identical output:
/// PhrenKit editing a CLI-written file must produce exactly what the CLI
/// would have produced.
final class FindingsFileTests: XCTestCase {
    func testParseMatchesCLI() throws {
        let content = try Fixtures.text("findings-after-remove.md")
        let parsed = FindingsFile(content: content).parse()
        guard let expected = try Fixtures.json("findings-parsed.json") as? [[String: Any]] else {
            return XCTFail("bad findings-parsed.json")
        }

        XCTAssertEqual(parsed.count, expected.count)
        for (item, exp) in zip(parsed, expected) {
            XCTAssertEqual(item.id, exp["id"] as? String)
            XCTAssertEqual(item.stableId, exp["stableId"] as? String)
            XCTAssertEqual(item.date, exp["date"] as? String)
            XCTAssertEqual(item.text, exp["text"] as? String)
            XCTAssertEqual(item.status.rawValue, exp["status"] as? String)
            XCTAssertEqual(item.scope, exp["scope"] as? String)
            XCTAssertEqual(item.machine, exp["machine"] as? String)
            XCTAssertEqual(item.actor, exp["actor"] as? String)
            XCTAssertEqual(item.statusUpdated, exp["status_updated"] as? String)
            XCTAssertEqual(item.citationData?.createdAt,
                           (exp["citationData"] as? [String: Any])?["created_at"] as? String)
            XCTAssertEqual(item.archived, false)
        }
    }

    /// The stamp `autoArchiveToReference` leaves behind (archive.ts:236) is
    /// how the app knows an archive exists at all, from a file it already
    /// syncs. Matching mirrors the CLI's own (validate.ts:56).
    func testConsolidatedMarkerIsParsed() throws {
        let marked = """
        # myproj Findings

        <!-- consolidated: 2026-08-01 -->

        ## 2026-08-02

        - [decision] Keep JWT expiry at 15 minutes
        """
        XCTAssertEqual(FindingsFile(content: marked).consolidatedDate, "2026-08-01")

        // Indented, spaced, and with trailing text — all forms the CLI's own
        // regex accepts, since it neither anchors nor requires the close.
        XCTAssertEqual(FindingsFile(content: "  <!--   consolidated:   2025-12-31 more -->").consolidatedDate,
                       "2025-12-31")
        // Never consolidated is a different answer from consolidated-and-empty.
        XCTAssertNil(FindingsFile(content: try Fixtures.text("findings-after-remove.md")).consolidatedDate)
        XCTAssertNil(FindingsFile(content: "<!-- consolidated: soon -->").consolidatedDate)
    }

    func testEditMatchesCLIByteForByte() throws {
        // CLI ran: editFinding("Plain finding with no tag", "Edited finding text that replaced the plain one")
        var file = FindingsFile(content: try Fixtures.text("findings-after-add.md"))
        try file.edit(project: "myproj",
                      oldText: "Plain finding with no tag",
                      newText: "Edited finding text that replaced the plain one")
        assertSameContent(file.content, try Fixtures.text("findings-after-edit.md"), "edit")
    }

    func testRemoveMatchesCLIByteForByte() throws {
        // CLI ran: removeFinding("Chose SQLite FTS5 over embeddings")
        var file = FindingsFile(content: try Fixtures.text("findings-after-edit.md"))
        try file.remove(project: "myproj", match: "Chose SQLite FTS5 over embeddings")
        assertSameContent(file.content, try Fixtures.text("findings-after-remove.md"), "remove")
    }

    func testAddProducesCLICompatibleBullet() throws {
        var file = FindingsFile(content: try Fixtures.text("findings-after-remove.md"))
        let fid = try file.add(
            project: "myproj",
            text: "[pitfall] New finding from iOS",
            options: .init(provenance: FindingProvenance(
                source: "human", machine: "test-iphone", actor: "tester", tool: "phren-ios"
            ))
        )

        // The CLI must be able to read what the app wrote.
        let parsed = file.parse()
        guard let added = parsed.first(where: { $0.stableId == fid }) else {
            return XCTFail("added finding not found on re-parse")
        }
        XCTAssertEqual(added.text, "[pitfall] New finding from iOS")
        XCTAssertEqual(added.status, .active)
        XCTAssertEqual(added.machine, "test-iphone")
        XCTAssertEqual(added.actor, "tester")
        XCTAssertNotNil(added.citationData)

        // Structure: bullet inserted directly under today's date heading with
        // the citation line indented two spaces (learning.ts:244).
        let lines = file.content.components(separatedBy: "\n")
        guard let bulletIdx = lines.firstIndex(where: { $0.contains("fid:\(fid)") }) else {
            return XCTFail("bullet line missing")
        }
        XCTAssertTrue(isCitationLine(lines[bulletIdx + 1]))
        XCTAssertTrue(lines[bulletIdx + 1].hasPrefix("  <!-- phren:cite {\"created_at\":"))
    }

    func testAddRejectsSecrets() throws {
        var file = FindingsFile(content: "")
        XCTAssertThrowsError(try file.add(project: "myproj", text: "token ghp_" + String(repeating: "a", count: 36))) {
            guard case PhrenKitError.secretDetected = $0 else { return XCTFail("wrong error: \($0)") }
        }
    }

    func testAddSkipsExactDuplicate() throws {
        var file = FindingsFile(content: try Fixtures.text("findings-after-remove.md"))
        XCTAssertThrowsError(try file.add(project: "myproj",
                                          text: "[pattern] Always validate JWT expiry before refresh")) {
            guard case PhrenKitError.duplicate = $0 else { return XCTFail("wrong error: \($0)") }
        }
    }

    func testMatchByFid() throws {
        var file = FindingsFile(content: try Fixtures.text("findings-after-remove.md"))
        let target = file.parse().first!
        let removed = try file.remove(project: "myproj", match: "fid:\(target.stableId!)")
        XCTAssertTrue(removed.contains("fid:\(target.stableId!)"))
    }

    func testNormalizeFindingText() {
        XCTAssertEqual(
            normalizeFindingText("- [pattern] Always Validate  JWT <!-- fid:12345678 --> [confidence 0.9]"),
            "[pattern] always validate jwt"
        )
    }
}
