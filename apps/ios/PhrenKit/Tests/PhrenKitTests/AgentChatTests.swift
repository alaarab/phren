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

    func testImagesInsideToolResultsAreAddressable() throws {
        let claude: [[String: Any]] = [
            ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": "t1", "name": "Read", "input": ["file_path": "/x.png"]]]]],
            ["type": "user", "message": ["role": "user", "content": [["type": "text", "text": "ok"], ["type": "tool_result", "tool_use_id": "t1", "content": [["type": "text", "text": "here"], ["type": "image"]]]]]],
        ]
        let transcript = try AgentChatTranscript.read(frame(claude, source: "claude"), source: "claude")
        let result = transcript.messages.first { $0.isToolResult }!
        XCTAssertEqual(result.resultImages, [.init(block: 1, inner: 1)])
        let codex: [[String: Any]] = [
            ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "c1", "output": [["type": "input_image", "image_url": "data:image/png;base64,"]]]],
        ]
        let out = try AgentChatTranscript.read(frame(codex, source: "codex"), source: "codex").messages[0]
        XCTAssertEqual(out.resultImages, [.init(block: 0, inner: nil)])
    }

    func testShellChangesAttachedByTheHookBecomePatchPartsUnderTheirCall() throws {
        let patch = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n"
        let rows: [[String: Any]] = [
            ["type": "response_item", "payload": ["type": "function_call", "name": "exec_command", "call_id": "c1", "arguments": "{\"cmd\":\"sed -i s/1/2/ src/a.ts\"}"]],
            ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "c1", "output": ""],
             "phren_changes": ["c1": [["root": "/work/app", "path": "src/a.ts", "status": "M", "added": 1, "removed": 1, "patch": patch],
                                      ["root": "/work/app", "path": "src/b.ts", "status": "A", "added": 1, "removed": 0, "patch": "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+export {};\n"],
                                      ["root": "/work/app", "path": "", "status": "M", "patch": "ignored"]]]],
            ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "c2", "output": "other"], "phren_changes": ["c1": [["path": "x", "patch": "@@\n+y"]]]],
        ]
        let transcript = try AgentChatTranscript.read(frame(rows, source: "codex"), source: "codex")
        XCTAssertEqual(transcript.messages.map(\.title), ["exec_command", "Tool result", "Changes", "Changes", "Tool result"])
        XCTAssertEqual(transcript.messages.map(\.isChange), [false, false, true, true, false])
        XCTAssertEqual(transcript.messages[2].text, "*** Update File: src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n")
        XCTAssertEqual(transcript.messages[3].text, "*** Add File: src/b.ts\n@@ -0,0 +1 @@\n+export {};\n")
        XCTAssertEqual(transcript.messages[2].toolCallID, "c1")
        XCTAssertEqual(Set(transcript.messages.map(\.id)).count, 5)
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

final class LocalCommandTests: XCTestCase {
    private func message(_ text: String) -> AgentChatMessage { .init(id: "1:0", line: 1, role: .user, title: nil, text: text) }
    func testSlashCommandReadsNameAndArguments() {
        let command = message("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>").localCommand
        XCTAssertEqual(command?.kind, .command); XCTAssertEqual(command?.text, "/model")
        XCTAssertEqual(message("<command-name>/review</command-name><command-message>review</command-message><command-args>ultra 12</command-args>").localCommand?.text, "/review ultra 12")
    }
    func testShellLineAndOutput() {
        XCTAssertEqual(message("<bash-input>pwd</bash-input>").localCommand, .init(kind: .shell, text: "pwd"))
        let output = message("<bash-stdout>/home/alaarab/Projects/hub</bash-stdout><bash-stderr></bash-stderr>").localCommand
        XCTAssertEqual(output?.kind, .output); XCTAssertEqual(output?.text, "/home/alaarab/Projects/hub")
        XCTAssertEqual(message("<bash-stdout></bash-stdout><bash-stderr></bash-stderr>").localCommand?.text, "")
        XCTAssertEqual(message("<local-command-stdout>Set model to Opus 5</local-command-stdout>").localCommand, .init(kind: .output, text: "Set model to Opus 5"))
    }
    func testOrdinaryMessagesAreNotCommands() {
        XCTAssertNil(message("Say \"go\" and I'll cut v0.11.27").localCommand)
        XCTAssertNil(message("look at <command-name> in the docs").localCommand)
        XCTAssertNil(AgentChatMessage(id: "1:0", line: 1, role: .assistant, title: nil, text: "<bash-input>pwd</bash-input>").localCommand)
    }
}

final class MergedUserTurnTests: XCTestCase {
    private func read(_ entries: [[String: Any]]) throws -> AgentChatTranscript {
        let frame: [String: Any] = ["type": "backlog", "source": "claude", "entries": entries]
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: "claude")
    }
    func testTextAndImageBlocksOfOneTurnBecomeOneBubble() throws {
        let raw: [String: Any] = ["type": "user", "message": ["role": "user", "content": [
            ["type": "text", "text": "[Image #3]Look at this\n\nAttached files on this computer:\n/tmp/shot.png"],
            ["type": "image", "source": ["type": "base64", "data": ""]],
            ["type": "image", "source": ["type": "base64", "data": ""]],
        ]]]
        let transcript = try read([["line": 4, "raw": raw]])
        XCTAssertEqual(transcript.messages.count, 1)
        let message = try XCTUnwrap(transcript.messages.first)
        XCTAssertEqual(message.id, "4:0")
        XCTAssertEqual(message.role, .user)
        XCTAssertEqual(message.imageBlocks, [1, 2])
        XCTAssertTrue(message.text.hasPrefix("[Image #3]Look at this"))
    }
    func testImageOnlyTurnKeepsItsPlaceholder() throws {
        let raw: [String: Any] = ["type": "user", "message": ["role": "user", "content": [
            ["type": "image", "source": ["type": "base64", "data": ""]],
            ["type": "image", "source": ["type": "base64", "data": ""]],
        ]]]
        let message = try XCTUnwrap(read([["line": 1, "raw": raw]]).messages.first)
        XCTAssertEqual(message.text, "[Image attachment]")
        XCTAssertEqual(message.imageBlocks, [0, 1])
    }
    func testToolResultsInTheSameRowStayApart() throws {
        let raw: [String: Any] = ["type": "user", "message": ["role": "user", "content": [
            ["type": "tool_result", "tool_use_id": "t1", "content": "done"],
            ["type": "text", "text": "and now this"],
        ]]]
        let messages = read_(raw)
        XCTAssertEqual(messages.map(\.role), [.tool, .user])
    }
    private func read_(_ raw: [String: Any]) -> [AgentChatMessage] {
        (try? read([["line": 1, "raw": raw]]).messages) ?? []
    }
}
