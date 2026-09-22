import Foundation
import XCTest
@testable import PhrenKit

/// phren-agent's event log as Phren Hook exports it — shapes from
/// experimental/agent/src/session/log.ts, reasoning already redacted.
final class PhrenAgentTranscriptTests: XCTestCase {
    private let session = "aaaaaaaa-1111-4111-8111-111111111111"

    private func frame(_ rows: [[String: Any]], kind: String = "backlog") throws -> AgentChatTranscript {
        let entries = rows.enumerated().map { ["line": $0.offset + 1, "raw": $0.element] as [String: Any] }
        let data = try JSONSerialization.data(withJSONObject: ["type": kind, "source": "phren", "entries": entries, "totalLines": rows.count + 1, "hasMore": false])
        return try AgentChatTranscript.read(data, source: "phren")
    }

    private func event(_ seq: Int, _ type: String, _ data: [String: Any]) -> [String: Any] {
        ["seq": seq, "time": "2026-09-12T20:0\(seq):00.000Z", "type": type, "data": data]
    }

    func testTargetAcceptsPhrenWithAUuidSession() throws {
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "phren", sessionID: session)
        XCTAssertEqual(target.providerName, "Phren")
        XCTAssertThrowsError(try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "phren", sessionID: "not-a-uuid"))
    }

    func testEventsBecomeUserAssistantAndToolMessages() throws {
        let value = try frame([
            event(1, "user/message", ["source": "user", "turn": 1, "message": ["role": "user", "content": "List the repo"]]),
            event(2, "assistant/message", ["turn": 1, "stop_reason": "tool_use", "usage": ["input_tokens": 120, "output_tokens": 40],
                                            "message": ["role": "assistant", "content": [["type": "redacted"], ["type": "text", "text": "Looking."],
                                                                                          ["type": "tool_use", "id": "call_1", "name": "bash", "input": ["cmd": "ls"]]]]]),
            event(3, "tool/results", ["turn": 1, "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "call_1", "content": "README.md\nsrc"]]]]),
            event(4, "assistant/message", ["turn": 1, "stop_reason": "end_turn", "usage": ["input_tokens": 200, "output_tokens": 12],
                                            "message": ["role": "assistant", "content": [["type": "text", "text": "Two entries."]]]]),
        ])
        XCTAssertEqual(value.messages.map(\.role), [.user, .assistant, .tool, .tool, .assistant])
        XCTAssertEqual(value.messages.map(\.text), ["List the repo", "Looking.", "{\n  \"cmd\" : \"ls\"\n}", "README.md\nsrc", "Two entries."])
        XCTAssertEqual(value.messages[2].title, "bash"); XCTAssertEqual(value.messages[2].toolCallID, "call_1")
        XCTAssertEqual(value.messages[3].title, "Tool result"); XCTAssertEqual(value.messages[3].toolCallID, "call_1")
        let grouped = ChatTimelineGrouping.pairs(value.messages)
        XCTAssertEqual(grouped, [["1:0"], ["2:1"], ["2:2", "3:0"], ["4:0"]])
        XCTAssertEqual(value.progressEvents.map(\.line), [1, 2, 4, 4])
        if case .started = value.progressEvents[0].value {} else { XCTFail("a user turn starts work") }
        if case .usage(let usage) = value.progressEvents[1].value { XCTAssertEqual(usage.input, 120); XCTAssertEqual(usage.output, 40) } else { XCTFail("usage rides the assistant message") }
        if case .usage(let usage) = value.progressEvents[2].value { XCTAssertEqual(usage.input, 200) } else { XCTFail("usage rides the assistant message") }
        if case .finished = value.progressEvents[3].value {} else { XCTFail("the final response also finishes the turn") }
        var progress = AgentChatProgress(); progress.receive(value)
        XCTAssertEqual(progress.phase, .finished)
        XCTAssertEqual(progress.elapsed(), 180)
        XCTAssertEqual(progress.usage?.input, 200)
    }

    func testEndOfTurnWithoutUsageFinishesAndBlanksAreDropped() throws {
        let value = try frame([
            event(1, "assistant/message", ["turn": 2, "stop_reason": "end_turn", "message": ["role": "assistant", "content": [["type": "text", "text": ""], ["type": "text", "text": "Done."]]]]),
            event(2, "user/message", ["source": "steer", "turn": 3, "message": ["role": "user", "content": [["type": "text", "text": "Also lint"], ["type": "image", "source": ["type": "base64"]]]]]),
        ])
        // The steer's words and picture are one bubble.
        XCTAssertEqual(value.messages.map(\.text), ["Done.", "Also lint"])
        XCTAssertEqual(value.messages[1].imageBlocks, [1])
        if case .finished = value.progressEvents[0].value {} else { XCTFail("end_turn without usage still finishes the turn") }
    }

    func testSlashCommandsForPhren() {
        XCTAssertEqual(AgentSlashCommand.suggestions(source: "phren", draft: "/p"), ["/provider", "/plan", "/permissions"])
        XCTAssertEqual(AgentSlashCommand.menu(source: "phren").first { $0.name == "/cost" }?.detail, "See this session's cost")
    }

    func testTargetAcceptsOpenCodeWithASesSession() throws {
        let session = "ses_f4a6b5c11ffe6nZrRlGZbXXNli"
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "opencode", sessionID: session)
        XCTAssertEqual(target.providerName, "opencode")
        XCTAssertThrowsError(try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "opencode", sessionID: "not-a-session"))
        XCTAssertTrue(AgentChatTarget.validSessionID(session))
        XCTAssertFalse(AgentChatTarget.validSessionID("ses_has spaces"))
    }

    func testOpenCodeTranscriptReadsTheSharedEventShape() throws {
        let entries = [["line": 1, "raw": event(1, "user/message", ["source": "user", "turn": 1, "message": ["role": "user", "content": "Hello"]])]]
        let data = try JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "opencode", "entries": entries, "totalLines": 2, "hasMore": false])
        let value = try AgentChatTranscript.read(data, source: "opencode")
        XCTAssertEqual(value.messages.map(\.text), ["Hello"])
    }
}

/// Test-only view of how the timeline pairs tool calls with their results.
private enum ChatTimelineGrouping {
    static func pairs(_ messages: [AgentChatMessage]) -> [[String]] {
        var groups: [[String]] = [], calls: [String: Int] = [:]
        for message in messages {
            if message.role == .tool, message.title == "Tool result", let key = message.toolCallID, let index = calls[key] {
                groups[index].append(message.id); continue
            }
            if message.role == .tool, let key = message.toolCallID { calls[key] = groups.count }
            groups.append([message.id])
        }
        return groups
    }
}
