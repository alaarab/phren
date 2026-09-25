import XCTest
@testable import PhrenKit

final class ReviewFileTests: XCTestCase {
    func testParseMatchesCLI() throws {
        let content = try Fixtures.text("review-seeded.md")
        let parsed = ReviewFile(content: content).parse()
        guard let expected = try Fixtures.json("review-parsed.json") as? [[String: Any]] else {
            return XCTFail("bad review-parsed.json")
        }

        XCTAssertEqual(parsed.count, expected.count)
        for (item, exp) in zip(parsed, expected) {
            XCTAssertEqual(item.id, exp["id"] as? String)
            XCTAssertEqual(item.section.rawValue, exp["section"] as? String)
            XCTAssertEqual(item.date, exp["date"] as? String)
            XCTAssertEqual(item.text, exp["text"] as? String)
            XCTAssertEqual(item.line, exp["line"] as? String)
            XCTAssertEqual(item.confidence, exp["confidence"] as? Double)
            XCTAssertEqual(item.risky, exp["risky"] as? Bool)
        }
    }

    func testApproveMatchesCLIByteForByte() throws {
        var file = ReviewFile(content: try Fixtures.text("review-seeded.md"))
        let firstLine = file.parse()[0].line
        try file.approve(lineText: firstLine)
        assertSameContent(file.content, try Fixtures.text("review-after-approve.md"), "approve")
    }

    func testRejectMatchesCLIByteForByte() throws {
        var file = ReviewFile(content: try Fixtures.text("review-after-approve.md"))
        let firstLine = file.parse()[0].line
        try file.reject(lineText: firstLine)
        assertSameContent(file.content, try Fixtures.text("review-after-reject.md"), "reject")
    }

    func testEditMatchesCLIByteForByte() throws {
        var file = ReviewFile(content: try Fixtures.text("review-after-reject.md"))
        let staleLine = file.parse()[0].line
        try file.edit(lineText: staleLine, newText: "Edited stale entry text")
        assertSameContent(file.content, try Fixtures.text("review-after-edit.md"), "edit queue item")
    }

    func testQueueTextNormalization() {
        // governance/policy.ts:710 — comments stripped, escapes unwound,
        // whitespace collapsed.
        XCTAssertEqual(
            ReviewFile.cleanQueueEntryText("Some text <!-- source:agent --> with\\nescapes and  spaces"),
            "Some text with escapes and spaces"
        )
        let long = String(repeating: "a", count: 600)
        let normalized = ReviewFile.normalizeQueueEntryText(long)
        XCTAssertEqual(normalized.count, 500)
        XCTAssertTrue(normalized.hasSuffix("…"))
    }

    func testFindingsNeedleStripsConfidence() {
        let line = "- [2026-07-26] Some captured finding [confidence 0.85]"
        XCTAssertEqual(ReviewFile.findingsTextFor(lineText: line), "Some captured finding")
    }
}
