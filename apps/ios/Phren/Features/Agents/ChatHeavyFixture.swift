#if DEBUG
import Foundation
import PhrenKit

/// Sixty transport entries, with large results, attached patches, and Markdown.
/// Shared by UI fixtures and the portable performance test; no real computer.
enum ChatHeavyFixture {
    static func data(source: String = "codex") throws -> Data {
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
}
#endif
