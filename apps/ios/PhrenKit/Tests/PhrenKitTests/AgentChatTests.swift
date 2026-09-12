import Foundation
import XCTest
@testable import PhrenKit

final class AgentChatTests: XCTestCase {
    func testAttachmentsUseGeneratedNamesAndRejectUnsafeOrOversizedData() throws {
        let item = try AgentAttachment(name: "../../a screenshot.PNG", data: Data([1, 2, 3]), isImage: true)
        XCTAssertTrue(item.uploadName.hasSuffix(".png"))
        XCTAssertFalse(item.uploadName.contains("/"))
        XCTAssertThrowsError(try AgentAttachment(name: "empty", data: Data()))
        XCTAssertThrowsError(try AgentAttachment(name: "huge", data: Data(repeating: 0, count: AgentAttachment.maximumBytes + 1)))
        XCTAssertEqual(try AgentAttachment.uploadedPath(from: Data(#"{"ok":true,"path":"/tmp/phren-upload-fixture/image.png"}"#.utf8)), "/tmp/phren-upload-fixture/image.png")
        XCTAssertThrowsError(try AgentAttachment.uploadedPath(from: Data(#"{"ok":true,"path":"/tmp/image\ncommand"}"#.utf8)))
    }

    func testUploadsAcceptOriginalPhrenHookResponseAndRejectExplicitFailures() throws {
        let path = "/Users/agent/.local/share/phren/bridge/uploads/session/image.png"
        XCTAssertEqual(try AgentAttachment.uploadedPath(from: JSONSerialization.data(withJSONObject: ["path": path])), path)
        let responses: [[String: Any]] = [
            ["ok": false, "path": path], ["ok": "true", "path": path], ["error": "Upload failed", "path": path],
            ["path": "relative/image.png"], ["path": "/tmp/image\ncommand"], ["ok": true],
        ]
        for response in responses {
            XCTAssertThrowsError(try AgentAttachment.uploadedPath(from: JSONSerialization.data(withJSONObject: response)))
        }
    }

    func testStreamMergesOlderPagesAndReconnectsWithoutDuplicates() throws {
        func page(_ kind: String, _ lines: [Int], total: Int = 12) throws -> AgentChatTranscript {
            let rows = lines.map { line in ["line": line, "raw": ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": "Message \(line)"]]] as [String: Any] }
            return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": "codex", "entries": rows, "startLine": lines.min() ?? 0, "totalLines": total, "hasMore": (lines.min() ?? 0) > 0]), source: "codex")
        }
        var history = AgentChatHistory()
        history.receive(try page("backlog", [8, 9]))
        history.receive(try page("append", [10, 11]))
        history.receive(try page("older", [0, 1, 2, 3]))
        history.receive(try page("backlog", [8, 9, 10, 11]))
        XCTAssertEqual(history.messages.map(\.line), [0, 1, 2, 3, 8, 9, 10, 11])
        XCTAssertEqual(history.startLine, 0)
        XCTAssertFalse(history.hasMore)
        let unchanged = history
        history.receive(try page("backlog", [8, 9, 10, 11]))
        XCTAssertEqual(history, unchanged, "Repeated snapshots must not invalidate the chat view")
        history.receive(try page("backlog", [0, 1], total: 2))
        XCTAssertNotEqual(history, unchanged)
        XCTAssertEqual(history.messages.map(\.line), [0, 1])
    }

    func testEmptyFinalHistoryPageClosesPaginationWithoutLosingMessages() throws {
        var history = AgentChatHistory()
        let recent = Data(#"{"type":"backlog","source":"codex","startLine":8,"totalLines":9,"hasMore":true,"entries":[{"line":8,"raw":{"type":"response_item","payload":{"type":"message","role":"assistant","content":"Recent message"}}}]}"#.utf8)
        history.receive(try AgentChatTranscript.read(recent, source: "codex"))
        history.receive(try AgentChatTranscript.read(Data(#"{"type":"older","source":"codex","totalLines":9,"hasMore":false,"entries":[]}"#.utf8), source: "codex"))
        XCTAssertFalse(history.hasMore)
        XCTAssertEqual(history.messages.map(\.text), ["Recent message"])
    }

    func testPaneIdentityRequiresTheExactAgentAndConversation() throws {
        let host = UUID()
        let list = try panes()
        let target = try list.panes[0].target(hostID: host, workspaceID: "w7", tabID: "w7:t1")
        XCTAssertEqual(try list.validate(target).id, "w7:p1")
        let replaced = try AgentChatTarget(hostID: host, workspaceID: "w7", tabID: "w7:t1", paneID: "w7:p1", source: "codex", sessionID: "different-session")
        XCTAssertThrowsError(try list.validate(replaced))
        let otherPane = try AgentChatTarget(hostID: host, workspaceID: "w7", tabID: "w7:t1", paneID: "w7:p2", source: "codex", sessionID: "session-one")
        XCTAssertThrowsError(try list.validate(otherPane))
        XCTAssertThrowsError(try panes(status: "blocked").validate(target, sending: true))
        XCTAssertThrowsError(try AgentChatTarget(hostID: host, workspaceID: "w7&tab=w8", tabID: "w7:t1", paneID: "w7:p1", source: "codex", sessionID: "session-one"))
    }

    func testHistoryWindowKeepsPagingPastItsMemoryLimitDuringLiveUpdates() throws {
        func page(_ lines: Range<Int>, kind: String = "backlog", total: Int = 5_000) throws -> AgentChatTranscript {
            let rows = lines.map { line in ["line": line, "raw": ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": "Message \(line)"]]] as [String: Any] }
            return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": "codex", "entries": rows, "startLine": lines.lowerBound, "totalLines": total, "hasMore": lines.lowerBound > 0]), source: "codex")
        }
        var history = AgentChatHistory()
        for start in stride(from: 0, to: 5_000, by: 1_000) { history.receive(try page(start..<(start + 1_000))) }
        XCTAssertEqual(history.messages.count, 4_000)
        XCTAssertTrue(history.hasMore)
        XCTAssertFalse(history.hasNewer)
        history.receive(try page(500..<1_000, kind: "older"))
        XCTAssertEqual(history.messages.first?.line, 500)
        XCTAssertEqual(history.messages.last?.line, 4_499)
        XCTAssertTrue(history.hasMore)
        XCTAssertTrue(history.hasNewer)
        history.receive(try page(5_000..<5_010, kind: "append", total: 5_010))
        history.receive(try page(4_900..<5_010, total: 5_010))
        XCTAssertEqual(history.messages.first?.line, 500, "Reconnect/live output must preserve the older window")
        XCTAssertEqual(history.messages.last?.line, 4_499)
        history.receive(try page(0..<500, kind: "older", total: 5_010))
        XCTAssertEqual(history.messages.first?.line, 0)
        XCTAssertEqual(history.messages.count, 4_000)
        XCTAssertFalse(history.hasMore)
        XCTAssertTrue(history.hasNewer)
        history.receive(try page(0..<2, total: 2))
        XCTAssertFalse(history.hasNewer, "A replaced/truncated transcript resets the window")
        XCTAssertEqual(history.messages.count, 2)
    }

    func testPaneListsRejectMismatchedLocationsAndDuplicateIDs() throws {
        let data = Data(#"{"kind":"herdr","groupId":"w7","childId":"w7:t1","panes":[{"id":"w7:p1","label":"1"},{"id":"w7:p1","label":"2"}]}"#.utf8)
        XCTAssertThrowsError(try AgentChatPanes.read(data, workspaceID: "w8", tabID: "w8:t1"))
        XCTAssertThrowsError(try AgentChatPanes.read(data, workspaceID: "w7", tabID: "w7:t1"))
    }

    func testSingleOversizedClaudeRowIsRejectedBeforeReplacingHistory() throws {
        let blocks = Array(repeating: ["type": "text", "text": "x"], count: 65_000)
        let oversized = try frame([["type": "assistant", "message": ["role": "assistant", "content": blocks]]], source: "claude")
        XCTAssertLessThan(oversized.count, 2 * 1_024 * 1_024, "A small byte payload can still expand into thousands of messages")
        var history = AgentChatHistory()
        let recent = try AgentChatTranscript.read(frame([["type": "assistant", "message": ["role": "assistant", "content": "Keep this conversation"]]], source: "claude"), source: "claude")
        history.receive(recent)
        XCTAssertThrowsError(try history.receive(AgentChatTranscript.read(oversized, source: "claude"))) {
            XCTAssertTrue($0 is AgentChatTranscript.LimitError)
        }
        XCTAssertEqual(history.messages, recent.messages)
    }

    func testClaudeMessageBudgetCoversMixedBlocksAcrossRows() throws {
        var blocks: [[String: Any]] = Array(repeating: ["type": "text", "text": "x"], count: 3_997)
        blocks += [["type": "thinking", "thinking": "Hidden"], ["type": "text", "text": ""],
                   ["type": "image"], ["type": "tool_use", "name": "Read", "id": "read-1", "input": [:]]]
        let first: [String: Any] = ["type": "assistant", "message": ["role": "assistant", "content": blocks]]
        let last: [String: Any] = ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "read-1", "content": "Result"]]]]
        let accepted = try AgentChatTranscript.read(frame([first, last], source: "claude"), source: "claude")
        XCTAssertEqual(accepted.messages.count, 4_000)
        XCTAssertEqual(accepted.messages.last?.text, "Result")
        XCTAssertThrowsError(try AgentChatTranscript.read(frame([first, last, last], source: "claude"), source: "claude")) {
            XCTAssertTrue($0 is AgentChatTranscript.LimitError)
        }
        let plain: [String: Any] = ["type": "assistant", "message": ["role": "assistant", "content": "One more"]]
        XCTAssertThrowsError(try AgentChatTranscript.read(frame([first, last, plain], source: "claude"), source: "claude"))
    }

    func testEmptyClaudeBlocksDoNotConsumeVisibleMessageBudget() throws {
        var blocks: [[String: Any]] = Array(repeating: ["type": "text", "text": ""], count: 65_000)
        blocks.append(["type": "text", "text": "Visible message"])
        let value = try AgentChatTranscript.read(frame([["type": "assistant", "message": ["role": "assistant", "content": blocks]]], source: "claude"), source: "claude")
        XCTAssertEqual(value.messages.map(\.text), ["Visible message"])
        XCTAssertEqual(value.messages.first?.id, "0:65000", "Discarding empty Parts must not shift the existing message identities")
    }

    func testCodexMessagesAndToolsExcludeSystemAndEncryptedReasoning() throws {
        let rows: [[String: Any]] = [
            ["type": "response_item", "payload": ["type": "message", "role": "system", "content": [["type": "text", "text": "private setup"]]]],
            ["type": "response_item", "payload": ["type": "reasoning", "encrypted_content": "private reasoning"]],
            ["type": "response_item", "payload": ["type": "message", "role": "user", "content": [["type": "input_text", "text": "Fix the screen"]]]],
            ["type": "response_item", "payload": ["type": "custom_tool_call", "name": "apply_patch", "input": "Edit the view"]],
            ["type": "response_item", "payload": ["type": "custom_tool_call_output", "output": "Applied"]],
            ["type": "event_msg", "payload": ["type": "agent_message", "message": "Done"]],
            ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": [["type": "output_text", "text": "Done"]]]],
        ]
        let transcript = try AgentChatTranscript.read(frame(rows, source: "codex"), source: "codex")
        XCTAssertEqual(transcript.messages.map(\.role), [.user, .tool, .tool, .assistant])
        XCTAssertEqual(transcript.messages.map(\.text), ["Fix the screen", "Edit the view", "Applied", "Done"])
        XCTAssertTrue(transcript.hasMore)
        XCTAssertThrowsError(try AgentChatTranscript.read(frame(rows, source: "codex"), source: "claude"))
    }

    func testClaudeBlocksSeparateVisibleTextToolCallsAndResults() throws {
        let rows: [[String: Any]] = [
            ["type": "user", "message": ["role": "user", "content": "Review this"]],
            ["type": "assistant", "message": ["role": "assistant", "content": [["type": "thinking", "thinking": "hidden"], ["type": "text", "text": "Checking"], ["type": "tool_use", "name": "Read", "input": ["path": "app.swift"]]]]],
            ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "content": [["type": "text", "text": "File contents"]]]]]],
            ["type": "user", "isMeta": true, "message": ["role": "user", "content": "hook metadata"]],
        ]
        let value = try AgentChatTranscript.read(frame(rows, source: "claude"), source: "claude")
        XCTAssertEqual(value.messages.map(\.role), [.user, .assistant, .tool, .tool])
        XCTAssertEqual(value.messages.last?.text, "File contents")
        XCTAssertFalse(value.messages.contains { $0.text.contains("hidden") || $0.text.contains("metadata") })
    }

    func testToolIDsAndEmptyResultsSurviveAllProviderParsers() throws {
        let sources: [(String, [[String: Any]])] = [
            ("codex", [
                ["type": "response_item", "payload": ["type": "function_call", "name": "test", "arguments": "", "call_id": "c1"]],
                ["type": "response_item", "payload": ["type": "function_call_output", "output": "", "call_id": "c1"]]
            ]),
            ("claude", [
                ["message": ["role": "assistant", "content": [["type": "tool_use", "name": "test", "id": "c1", "input": [:]]]]],
                ["message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "c1", "content": []]]]]
            ]),
            ("copilot", [
                ["type": "tool.execution_start", "data": ["toolName": "test", "toolCallId": "c1", "arguments": [:]]],
                ["type": "tool.execution_complete", "data": ["toolCallId": "c1", "result": ["content": ""]]]
            ])
        ]
        for (source, rows) in sources {
            let messages = try AgentChatTranscript.read(frame(rows, source: source), source: source).messages
            XCTAssertEqual(messages.map(\.toolCallID), ["c1", "c1"], source)
            XCTAssertEqual(messages.map(\.isToolResult), [false, true], source)
        }
        let oversized = [["type": "response_item", "payload": ["type": "function_call_output", "output": "Result remains readable", "call_id": String(repeating: "x", count: 513)]]]
        let message = try AgentChatTranscript.read(frame(oversized, source: "codex"), source: "codex").messages.first
        XCTAssertEqual(message?.text, "Result remains readable")
        XCTAssertNil(message?.toolCallID)
    }

    private func panes(status: String = "idle") throws -> AgentChatPanes {
        let body: [String: Any] = ["kind": "herdr", "groupId": "w7", "childId": "w7:t1", "panes": [
            ["id": "w7:p1", "label": "1", "agent": "codex", "agentStatus": status, "sessionId": "session-one"],
            ["id": "w7:p2", "label": "2", "agent": "claude", "sessionId": "session-two"],
        ]]
        return try AgentChatPanes.read(JSONSerialization.data(withJSONObject: body), workspaceID: "w7", tabID: "w7:t1")
    }
    private func frame(_ rows: [[String: Any]], source: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["type": "backlog", "source": source, "entries": rows.enumerated().map { ["line": $0.offset, "raw": $0.element] }, "hasMore": true, "totalLines": rows.count])
    }
}
