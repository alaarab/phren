import Foundation
import XCTest
@testable import PhrenKit

final class CopilotChatTests: XCTestCase {
    func testVisibleCopilotEventsExcludePrivateAndBackgroundContent() throws {
        let rows: [[String: Any]] = [
            ["type": "session.start", "data": ["systemMessage": "private system"]],
            ["type": "user.message", "data": ["content": "Review this", "transformedContent": "private augmentation"]],
            ["type": "assistant.message", "data": ["content": "Checking", "reasoningText": "private reasoning", "encryptedContent": "secret"]],
            ["type": "assistant.message", "agentId": "child", "data": ["content": "background"]],
            ["type": "user.message", "data": ["source": "skill-secret", "content": "hidden skill"]],
            ["type": "tool.execution_start", "data": ["toolName": "view", "arguments": ["path": "app.swift"]]],
            ["type": "tool.execution_complete", "data": ["result": ["content": "Visible file content"]]],
            ["type": "assistant.message_delta", "ephemeral": true, "data": ["deltaContent": "duplicate"]],
        ]
        let frame = try read(rows)
        XCTAssertEqual(frame.messages.map(\.role), [.user, .assistant, .tool, .tool])
        XCTAssertEqual(frame.messages.last?.text, "Visible file content")
        let text = frame.messages.map(\.text).joined()
        for hidden in ["private", "secret", "background", "hidden skill", "duplicate"] { XCTAssertFalse(text.contains(hidden)) }
    }

    func testCopilotLifecycleAndReportedUsage() throws {
        var progress = AgentChatProgress()
        progress.receive(try read([
            ["type": "user.message", "timestamp": "2026-09-09T12:00:00Z", "data": ["content": "Go"]],
            ["type": "assistant.turn_start", "timestamp": "2026-09-09T12:00:00Z", "data": [:]],
            ["type": "assistant.usage", "data": ["inputTokens": 120, "outputTokens": 30, "cacheReadTokens": 50]],
            ["type": "session.idle", "data": ["aborted": false]],
        ]))
        XCTAssertEqual(progress.phase, .finished)
        XCTAssertEqual(progress.usage?.input, 120)
        XCTAssertEqual(progress.usage?.output, 30)
        XCTAssertEqual(progress.usage?.cachedInput, 50)
        XCTAssertNotNil(progress.startedAt)
    }

    func testCopilotTargetsAndCustomCommandsKeepTheirIdentity() throws {
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "copilot", sessionID: UUID().uuidString.lowercased())
        XCTAssertEqual(target.providerName, "Copilot")
        XCTAssertTrue(AgentSlashCommand.isCommand("/my-plugin/review file.swift --strict"))
        XCTAssertFalse(AgentSlashCommand.isCommand("Explain /model"))
        XCTAssertEqual(AgentSlashCommand.suggestions(source: "copilot", draft: "/mo"), ["/model"])
        XCTAssertTrue(AgentSlashCommand.suggestions(source: "copilot", draft: "/model args").isEmpty)
    }

    /// The Hook's backlog frame for a real Copilot 1.0.87 session (sanitized;
    /// written by packages/cli's transcript-copilot.test.ts): three prompts,
    /// ten model calls, twelve tool runs and no session.idle.
    func testCopilot1087SessionShowsEveryTurnAndFinishesThem() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "copilot-1.0.87-backlog", withExtension: "json", subdirectory: "Fixtures"))
        let frame = try AgentChatTranscript.read(Data(contentsOf: url), source: "copilot", session: "00000000-0000-4000-8000-000000000187")
        XCTAssertEqual(frame.messages.filter { $0.role == .user }.map(\.text), ["Sample prompt 1.", "Sample prompt 2.", "Sample prompt 3."])
        XCTAssertEqual(frame.messages.filter { $0.role == .assistant }.map(\.text), ["Sample reply 1.", "Sample reply 2.", "Sample reply 3."])
        XCTAssertEqual(frame.messages.filter { $0.role == .tool }.count, 24)
        XCTAssertFalse(frame.messages.contains { $0.isToolError })
        var progress = AgentChatProgress()
        progress.receive(frame)
        XCTAssertEqual(progress.phase, .finished)
        XCTAssertEqual(progress.turns.map(\.startLine), [6, 24, 83])
        XCTAssertEqual(progress.turns.map(\.endLine), [19, 67, 126])
        XCTAssertTrue(progress.turns.allSatisfy { $0.phase == .finished && $0.finishedAt != nil })
    }

    func testFailedCopilotToolRunIsMarked() throws {
        let frame = try read([
            ["type": "tool.execution_start", "data": ["toolName": "bash", "toolCallId": "call_1", "arguments": ["command": "false"]]],
            ["type": "tool.execution_complete", "data": ["toolCallId": "call_1", "success": false, "result": ["content": "exit 1"]]],
        ])
        XCTAssertEqual(frame.messages.map(\.isToolError), [false, true])
    }

    private func read(_ rows: [[String: Any]]) throws -> AgentChatTranscript {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "copilot",
            "entries": rows.enumerated().map { ["line": $0.offset, "raw": $0.element] as [String: Any] }, "totalLines": rows.count]), source: "copilot")
    }
}
