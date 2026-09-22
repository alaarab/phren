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

    func testOverviewDecode() throws {
        let tabs: [[String: Any]] = (0..<240).map { ["id": "w1:t\($0)", "label": "Build \($0)", "agent": "codex", "agentStatus": "working", "currentStep": "Reading sample.swift", "lastChangedAt": "2026-09-20T08:00:00Z", "contextUsedPercent": 42, "runningChildren": 2] }
        let data = try JSONSerialization.data(withJSONObject: ["kind": "herdr", "groups": [["id": "w1", "label": "Project", "children": tabs]], "phren": ["product": "phren-hook", "protocol": 1]])
        print("PHONE_SPEED overview bytes=\(data.count)")
        // Paired comparison keeps machine load from masquerading as a gain.
        // This is the previous gateway path versus the single-decode path.
        var previous = 0.0, current = 0.0
        for _ in 0..<30 {
            let start = CFAbsoluteTimeGetCurrent()
            let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            let hook = raw["phren"] as! [String: Any]
            XCTAssertEqual(hook["product"] as? String, "phren-hook")
            XCTAssertEqual(hook["protocol"] as? Int, 1)
            _ = try LiveWorkspaces.read(data)
            let middle = CFAbsoluteTimeGetCurrent()
            _ = try LiveWorkspaces.read(data, requiringHook: true)
            let end = CFAbsoluteTimeGetCurrent()
            previous += middle - start; current += end - middle
        }
        print("PHONE_SPEED overview paired mean previous=\(previous / 30 * 1000) current=\(current / 30 * 1000) ms")

        measure {
            _ = try! LiveWorkspaces.read(data, requiringHook: true)
        }
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

    func testMessageTextPreparationPerformance() throws {
        let text = String(repeating: "Build detail: file.swift:123 inspected dependency and diagnostic output.\n", count: 900)
        let data = try JSONSerialization.data(withJSONObject: ["text": text])
        let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let bridged = raw["text"] as! String
        measure { for _ in 0..<20 { _ = AgentChatTranscript.boundedMessageText(bridged) } }
    }

    func testUsageDecode() throws {
        let windows: [[String: Any]] = (0..<30).map { ["id": "window\($0)", "name": "Model \($0)", "usedPercent": 42.0, "limitUSD": 100, "resetsAt": "2026-09-22T08:00:00Z"] }
        let data = try JSONSerialization.data(withJSONObject: ["accounts": ["codex", "claude", "opencode", "opencode-go", "openrouter"].map { ["source": $0, "windows": windows, "updatedAt": "2026-09-20T08:00:00Z"] as [String: Any] }])
        print("PHONE_SPEED usage bytes=\(data.count)")
        measure { _ = try! AccountUsageSnapshot.read(data) }
    }

    func testLargestCheckedInTranscriptFixture() throws {
        let cases = try Fixtures.json("hook-events.json") as! [[String: Any]]
        let frames = try cases.map { fixture -> (String, Data) in
            let events = fixture["events"] as! [[String: Any]]
            let source = fixture["source"] as! String
            return (source, try JSONSerialization.data(withJSONObject: ["type": "backlog", "source": source, "entries": events.enumerated().map { ["line": $0.offset, "raw": $0.element] as [String: Any] }]))
        }
        measure { for (source, data) in frames { _ = try! AgentChatTranscript.read(data, source: source) } }
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
