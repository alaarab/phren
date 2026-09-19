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
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages)
        let revision = prepared.revision
        for _ in 0..<60 { prepared.update(frame.messages) }
        XCTAssertEqual(prepared.revision, revision)
        XCTAssertEqual(prepared.entries.count, 40)
        XCTAssertTrue(prepared.jobs.isEmpty, "Foreground output must not produce background jobs")
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
    }
}
