import PhrenKit
import XCTest
@testable import Phren

final class ChatRenderCacheTests: XCTestCase {
    func testMessageCacheIncludesAttachmentVisibilityAndUpdatedText() throws {
        let message = try message("Fix this [Image #1]\n\nAttached files on this computer:\n/tmp/image.jpg")
        XCTAssertEqual(ChatMessageDisplayCache.text(for: message, imagePaths: [], hasImages: false, inlineImages: false), message.text)
        XCTAssertEqual(ChatMessageDisplayCache.text(for: message, imagePaths: ["/tmp/image.jpg"], hasImages: true, inlineImages: true), "Fix this")
        let edited = try self.message("Changed instruction")
        XCTAssertEqual(edited.id, message.id)
        XCTAssertEqual(ChatMessageDisplayCache.text(for: edited, imagePaths: [], hasImages: false, inlineImages: false), "Changed instruction")
    }

    /// A growing reply parses its settled paragraphs once; the blocks must
    /// be the ones the whole text parses to, at every length.
    func testStreamingDocumentMatchesTheWholeParseAtEveryLength() {
        let reply = "Intro with **bold**.\n\n- one\n- two\n\n```swift\nlet a = 1\n\nlet b = 2\n```\n\n## Heading\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nLast line."
        for length in 0...reply.count {
            let text = String(reply.prefix(length))
            let whole = ChatRichTextDocument(text), streamed = ChatRichTextDocumentCache.streaming(text)
            XCTAssertEqual(streamed.blocks.map(\.id), whole.blocks.map(\.id), text)
            XCTAssertEqual(streamed.blocks.map(\.text), whole.blocks.map(\.text), text)
            XCTAssertEqual(streamed.blocks.map(\.language), whole.blocks.map(\.language), text)
            XCTAssertEqual(streamed.blocks.map(\.attributed), whole.blocks.map(\.attributed), text)
            XCTAssertEqual(streamed.blocks.map(\.rows), whole.blocks.map(\.rows), text)
            XCTAssertEqual(streamed.accessibilityText, whole.accessibilityText, text)
        }
        XCTAssertEqual(ChatRichTextDocument.settledPrefix("One\n\nTwo"), "One\n")
        XCTAssertEqual(ChatRichTextDocument.settledPrefix("```\na\n\nb"), "")
    }

    func testDiffCacheSeparatesChangedPatches() {
        let a = "diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n-old\n+first\n"
        let b = a.replacingOccurrences(of: "+first", with: "+second")
        XCTAssertTrue(DiffDocumentCache.value(for: a).rows.contains { $0.text.contains("first") })
        XCTAssertTrue(DiffDocumentCache.value(for: b).rows.contains { $0.text.contains("second") })
        XCTAssertFalse(DiffDocumentCache.value(for: a).rows.contains { $0.text.contains("second") })
    }

    private func message(_ text: String) throws -> AgentChatMessage {
        let data: [String: Any] = ["type": "backlog", "source": "claude", "entries": [["line": 0,
            "raw": ["type": "user", "message": ["role": "user", "content": text]]]]]
        return try XCTUnwrap(AgentChatTranscript.read(JSONSerialization.data(withJSONObject: data), source: "claude").messages.first)
    }
}
