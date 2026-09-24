import Foundation
import PhrenKit
import XCTest
@testable import Phren

final class ChatTranscriptPerformanceTests: XCTestCase {
    func testHeavyPagePreparationIsReusedAcrossUnchangedFrames() throws {
        let data = try ChatHeavyFixture.data()
        let frame = try AgentChatTranscript.read(data, source: "codex")
        XCTAssertEqual(frame.totalLines, 60)
        XCTAssertTrue(frame.messages.contains { $0.textByteCount > 60_000 })
        let changes = frame.messages.filter(\.isChange)
        XCTAssertEqual(changes.count, 20)
        XCTAssertTrue(changes.allSatisfy {
            DiffDocumentSummaryCache.value(for: $0.text, key: $0.renderKey).rowCount > 120
        }, "Heavy folded patches use the bounded accessibility path")
        let replies = frame.messages.filter { $0.text.contains("Heavy fixture reply") }
        XCTAssertEqual(replies.count, 20)
        XCTAssertTrue(replies.allSatisfy {
            ChatRichTextDocumentCache.value($0.text, key: $0.renderKey).condensesAccessibility
        }, "Heavy replies use the bounded accessibility path")
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages)
        let revision = prepared.revision
        for _ in 0..<60 { prepared.update(frame.messages) }
        XCTAssertEqual(prepared.revision, revision)
        XCTAssertEqual(prepared.entries.count, 40)
        XCTAssertTrue(prepared.jobs.isEmpty, "Foreground output must not produce background jobs")
    }

    func testPreparedRowsCarryPlaceholderIdentityAndLargeChangeFlag() throws {
        let data = try ChatHeavyFixture.data()
        let frame = try AgentChatTranscript.read(data, source: "codex")
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages)
        XCTAssertFalse(prepared.entries.isEmpty)
        for entry in prepared.entries {
            XCTAssertFalse(entry.placeholderIdentifier.isEmpty, "every row keeps an identifier when folded off screen")
            XCTAssertFalse(entry.placeholderLabel.isEmpty, "every row keeps a label when folded off screen")
        }
        let withChanges = prepared.entries.filter { $0.messages.contains(where: \.isChange) }
        XCTAssertFalse(withChanges.isEmpty)
        XCTAssertTrue(withChanges.allSatisfy(\.hasLargeCollapsedChange),
                      "the heavy fixture's folded patches use the bounded path")
    }

    func testContentKeyChangesForEqualLengthEditsAndMarkdownKeepsLinksAndTables() throws {
        func message(_ text: String) throws -> AgentChatMessage {
            let data = try JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "claude", "entries": [
                ["line": 1, "raw": ["type": "user", "message": ["role": "user", "content": text]]]]])
            return try XCTUnwrap(AgentChatTranscript.read(data, source: "claude").messages.first)
        }
        let first = try message("first"), second = try message("other")
        XCTAssertEqual(first.id, second.id)
        XCTAssertNotEqual(first.renderKey, second.renderKey)
        let doc = ChatRichTextDocumentCache.value("[Read](https://example.org)\n\n| State |\n| --- |\n| **Ready** |", key: "markdown-test")
        XCTAssertTrue(doc.blocks[0].attributed.runs.contains { $0.link != nil })
        XCTAssertEqual(String(doc.blocks[1].attributedRows[1][0].characters), "Ready")
        XCTAssertFalse(doc.condensesAccessibility, "Ordinary replies keep each link interactive")
        let linked = String(repeating: "[result](https://example.org) ", count: 24)
        let dense = ChatRichTextDocumentCache.value(linked, key: "markdown-accessibility-test")
        XCTAssertTrue(dense.condensesAccessibility, "Generated link runs use one bounded accessibility element")
        XCTAssertEqual(dense.accessibilityText.split(separator: " ").count, 24)
    }

    func testFoldedDiffSummaryMatchesTheFullDocument() {
        let patch = "*** Update File: Sample.swift\n@@ -1,2 +1,2 @@\n-let old = 1\n+let new = 2\n unchanged"
        let summary = DiffDocumentSummaryCache.value(for: patch, key: "folded-summary-test")
        let document = DiffDocumentCache.value(for: patch, key: "folded-document-test")
        XCTAssertEqual(summary.header, document.rows.first { $0.kind == .header }?.text)
        XCTAssertEqual(summary.added, document.added)
        XCTAssertEqual(summary.removed, document.removed)
        XCTAssertEqual(summary.truncated, document.truncated)
        XCTAssertEqual(summary.rowCount, document.rows.count)
    }
}
