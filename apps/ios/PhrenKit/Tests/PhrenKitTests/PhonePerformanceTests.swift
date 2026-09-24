import Foundation
import XCTest
@testable import PhrenKit

final class PhonePerformanceTests: XCTestCase {
    func testHeavyTranscriptDecode() throws {
        let data = try PortableHeavyFixture.data()
        print("PHONE_SPEED heavy bytes=\(data.count)")
        XCTAssertEqual(try AgentChatTranscript.read(data, source: "codex").messages.count, 80)
        measure { _ = try! AgentChatTranscript.read(data, source: "codex") }
    }

    func testMessagePreparationPreservesGraphemeBoundaries() throws {
        for text in ["short", String(repeating: "x", count: 64_001),
                     String(repeating: "e\u{301}👨‍👩‍👧‍👦", count: 32_001)] {
            let data = try JSONSerialization.data(withJSONObject: ["text": text])
            let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            let bridged = raw["text"] as! String
            XCTAssertEqual(AgentChatTranscript.boundedMessageText(bridged), String(bridged.prefix(64_000)))
        }
    }

}


/// Sixty transport entries, with large results, attached patches, and Markdown.
/// Shared by UI fixtures and the portable performance test; no real computer.
private enum PortableHeavyFixture {
    static func data(source: String = "codex", uneven: Bool = false) throws -> Data {
        if uneven { return try unevenData(source: source) }
        var entries: [[String: Any]] = []
        let output = String(repeating: "Build detail: file.swift:123 inspected dependency and diagnostic output.\n", count: 900)
        let patch = "--- a/file.swift\n+++ b/file.swift\n@@ -1,180 +1,180 @@\n" + (0..<180).map { "-let old\($0) = 1\n+let new\($0) = 2\n" }.joined()
        for index in 0..<20 {
            let id = "heavy-\(index)", command = index % 4 == 0 ? "cat file.swift" : "swift test --filter Case\(index)"
            let call: [String: Any] = source == "codex"
                ? ["type": "response_item", "payload": ["type": "function_call", "call_id": id, "name": "exec_command", "arguments": "{\"cmd\":\"\(command)\"}"]]
                : ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": id, "name": "Bash", "input": ["command": command]]]]]
            var result: [String: Any] = source == "codex"
                ? ["type": "response_item", "payload": ["type": "function_call_output", "call_id": id, "output": output]]
                : ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": id, "content": output]]]]
            result["phren_changes"] = [id: [["path": "file\(index).swift", "status": "M", "patch": patch]]]
            let text = "## Check \(index)\n" + String(repeating: "The **build** inspected `file.swift` and [reported its result](https://example.org/test). ", count: 24)
                + "\n```swift\nlet result = \(index)\n```\nHeavy fixture reply \(index)."
            let reply: [String: Any] = source == "codex"
                ? ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": [["type": "text", "text": text]]]]
                : ["type": "assistant", "message": ["role": "assistant", "content": text]]
            for raw in [call, result, reply] { entries.append(["line": entries.count, "raw": raw]) }
        }
        return try JSONSerialization.data(withJSONObject: ["type": "backlog", "source": source, "entries": entries,
                                                         "totalLines": 60, "startLine": 0, "hasMore": false])
    }

    /// Six very tall replies followed by two hundred one-liners. A lazy stack
    /// sizes what it has not laid out from what it has, so on open the
    /// transcript looks several screens taller than it is.
    static func unevenData(source: String) throws -> Data {
        var entries: [[String: Any]] = []
        for index in 0..<206 {
            let text = index < 6
                ? "## Survey \(index)\n" + String(repeating: "The **build** inspected `file.swift` and reported its result. ", count: 160) + "\nUneven fixture reply \(index)."
                : "Uneven fixture reply \(index)."
            let reply: [String: Any] = source == "codex"
                ? ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": [["type": "text", "text": text]]]]
                : ["type": "assistant", "message": ["role": "assistant", "content": text]]
            entries.append(["line": entries.count, "raw": reply])
        }
        return try JSONSerialization.data(withJSONObject: ["type": "backlog", "source": source, "entries": entries,
                                                         "totalLines": entries.count, "startLine": 0, "hasMore": false])
    }
}
