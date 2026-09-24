import Foundation
import XCTest
@testable import PhrenKit

final class AgentSessionContextTests: XCTestCase {
    private func frame(_ rows: [[String: Any]], source: String) throws -> AgentChatTranscript {
        let entries = rows.enumerated().map { ["line": $0.offset, "raw": $0.element] as [String: Any] }
        let data = try JSONSerialization.data(withJSONObject: ["type": "backlog", "source": source, "entries": entries, "totalLines": rows.count, "hasMore": false])
        return try AgentChatTranscript.read(data, source: source)
    }

    func testClaudeRowsCarryModelAndBranchFromTheNewestRow() throws {
        let value = try frame([
            ["type": "user", "gitBranch": "main", "message": ["role": "user", "content": "Hello"]],
            ["type": "assistant", "gitBranch": "main", "message": ["role": "assistant", "model": "claude-opus-5", "content": "Hi"]],
            ["type": "user", "gitBranch": "feat/ios-app", "message": ["role": "user", "content": "Switch branch"]],
        ], source: "claude")
        XCTAssertEqual(value.context.modelName, "claude-opus-5")
        XCTAssertEqual(value.context.branch, "feat/ios-app")
        XCTAssertEqual(value.context.line, 2)
    }

    func testCodexTurnContextNamesTheModelWithoutBecomingAMessage() throws {
        let value = try frame([
            ["type": "turn_context", "payload": ["model": "gpt-6-astra"]],
            ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": "Done"]],
        ], source: "codex")
        XCTAssertEqual(value.context.modelName, "gpt-6-astra")
        XCTAssertNil(value.context.branch)
        XCTAssertEqual(value.messages.map(\.text), ["Done"])
    }

    func testOlderPagesNeverOverrideNewerContextAndBlanksNeverClear() throws {
        var context = AgentSessionContext(modelName: "claude-opus-5", branch: "main", line: 40)
        context.merge(AgentSessionContext(modelName: "claude-sonnet-5", branch: nil, line: 3))
        XCTAssertEqual(context.modelName, "claude-opus-5")
        context.merge(AgentSessionContext.read(["type": "user", "gitBranch": "  ", "message": ["role": "user"]], source: "claude", line: 41))
        XCTAssertEqual(context.branch, "main")
        XCTAssertEqual(context.line, 40)
        context.merge(AgentSessionContext(modelName: nil, branch: "release", line: 41))
        XCTAssertEqual(context.modelName, "claude-opus-5")
        XCTAssertEqual(context.branch, "release")
        XCTAssertEqual(context.line, 41)
    }

    func testStatusFrameCarriesBranchAndIgnoresEmptyOnes() throws {
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "codex", sessionID: "s1")
        let status = try XCTUnwrap(AgentInteractionStatus.read(Data(#"{"agentStatus":{"source":"codex","session":"s1","status":"working","branch":"trunk"}}"#.utf8), target: target))
        XCTAssertEqual(status.branch, "trunk")
        let blank = try XCTUnwrap(AgentInteractionStatus.read(Data(#"{"agentStatus":{"source":"codex","session":"s1","status":"idle","branch":""}}"#.utf8), target: target))
        XCTAssertNil(blank.branch)
    }
}
