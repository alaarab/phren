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

    func testDiffCacheSeparatesChangedPatches() {
        let a = "diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n-old\n+first\n"
        let b = a.replacingOccurrences(of: "+first", with: "+second")
        XCTAssertTrue(DiffDocumentCache.value(for: a).rows.contains { $0.text.contains("first") })
        XCTAssertTrue(DiffDocumentCache.value(for: b).rows.contains { $0.text.contains("second") })
        XCTAssertFalse(DiffDocumentCache.value(for: a).rows.contains { $0.text.contains("second") })
    }

    func testRepeatedDiffPreparationReportsColdAndWarmTimes() {
        let patch = "diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1,200 +1,200 @@\n"
            + (0..<200).map { "-let old\($0) = 1\n+let new\($0) = 2\n" }.joined()
        let started = CFAbsoluteTimeGetCurrent()
        let cold = DiffDocumentCache.value(for: patch)
        let first = CFAbsoluteTimeGetCurrent() - started
        let repeated = CFAbsoluteTimeGetCurrent()
        for _ in 0..<100 { XCTAssertEqual(DiffDocumentCache.value(for: patch).rows.count, cold.rows.count) }
        let warm = (CFAbsoluteTimeGetCurrent() - repeated) / 100
        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
            print("[PhrenPerformance] diff cold=\(first * 1_000)ms warm=\(warm * 1_000)ms (100 repeats)")
        }
    }

    private func message(_ text: String) throws -> AgentChatMessage {
        let data: [String: Any] = ["type": "backlog", "source": "claude", "entries": [["line": 0,
            "raw": ["type": "user", "message": ["role": "user", "content": text]]]]]
        return try XCTUnwrap(AgentChatTranscript.read(JSONSerialization.data(withJSONObject: data), source: "claude").messages.first)
    }
}
