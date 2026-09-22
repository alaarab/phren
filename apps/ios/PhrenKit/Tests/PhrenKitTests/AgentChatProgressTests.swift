import Foundation
import XCTest
@testable import PhrenKit

final class AgentChatProgressTests: XCTestCase {
    func testSharedHookLifecycleAndUsageContract() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "hook-events", withExtension: "json", subdirectory: "Fixtures"))
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        for fixture in cases {
            let source = try XCTUnwrap(fixture["source"] as? String)
            let events = try XCTUnwrap(fixture["events"] as? [[String: Any]])
            let rows = events.enumerated().map { ["line": $0.offset, "raw": $0.element] as [String: Any] }
            var progress = AgentChatProgress()
            progress.receive(try frame("backlog", rows, total: rows.count, source: source))
            XCTAssertEqual(progress.usage?.input, fixture["input"] as? Int)
            XCTAssertEqual(progress.usage?.output, fixture["output"] as? Int)
            let phase = progress.phase.map { String(describing: $0) }
            XCTAssertEqual(phase, fixture["phase"] as? String)
        }
    }
    func testNewConversationCanHaveAnEmptyBacklogWithoutEntries() throws {
        let frame = try AgentChatTranscript.read(Data(#"{"source":"codex","type":"backlog","totalLines":1}"#.utf8), source: "codex")
        XCTAssertTrue(frame.messages.isEmpty); XCTAssertTrue(frame.progressEvents.isEmpty)
        for entries in ["null", "true", "{}"] {
            XCTAssertThrowsError(try AgentChatTranscript.read(Data("{\"source\":\"codex\",\"type\":\"backlog\",\"entries\":\(entries)}".utf8), source: "codex"))
        }
    }
    func testCodexPublishesTurnStateAndActualUsageWithoutExposingReasoning() throws {
        let frame = try frame("backlog", [
            row(2, "task_started", ["started_at": 1_700_000_000]),
            row(3, "agent_reasoning", ["text": "private reasoning"]),
            row(4, "token_count", ["info": ["last_token_usage": ["input_tokens": 1500, "cached_input_tokens": 1200, "output_tokens": 83]]]),
        ], total: 5)
        XCTAssertTrue(frame.messages.isEmpty)
        var progress = AgentChatProgress(); progress.receive(frame)
        XCTAssertEqual(progress.phase, .working)
        XCTAssertEqual(progress.startedAt, Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(progress.usage?.input, 1500)
        XCTAssertEqual(progress.usage?.output, 83)
        XCTAssertEqual(progress.usage?.cachedInput, 1200)
        progress.receive(try self.frame("append", [row(5, "task_complete", ["completed_at": 1_700_000_020])], total: 6))
        XCTAssertEqual(progress.phase, .finished)
        XCTAssertEqual(progress.finishedAt, Date(timeIntervalSince1970: 1_700_000_020))
    }

    func testOlderAndRepeatedFramesDoNotReplayProgressAndTruncationClearsIt() throws {
        var progress = AgentChatProgress()
        let begin = try frame("backlog", [row(8, "task_started", ["started_at": 1000]),
                                              row(9, "token_count", ["info": ["last_token_usage": ["input_tokens": 30, "output_tokens": 12]]])], total: 10)
        progress.receive(begin)
        progress.receive(try frame("append", [row(10, "turn_aborted")], total: 11))
        progress.receive(try frame("backlog", [row(8, "task_started", ["started_at": 1000])], total: 11))
        progress.receive(try frame("older", [row(2, "task_started")], total: 11))
        XCTAssertEqual(progress.phase, .stopped)
        progress.receive(try frame("append", [row(11, "task_started", ["started_at": 2000])], total: 12))
        XCTAssertNil(progress.usage)
        XCTAssertEqual(progress.startedAt, Date(timeIntervalSince1970: 2000))
        progress.receive(try frame("backlog", [], total: 1, reset: true))
        XCTAssertNil(progress.phase); XCTAssertNil(progress.usage); XCTAssertNil(progress.startedAt)
    }

    func testReconnectKeepsProgressUntilAnExplicitReplacement() throws {
        var progress = AgentChatProgress()
        progress.receive(try frame("append", [row(19, "task_started", ["started_at": 2000])], total: 20))
        progress.receive(try frame("backlog", [row(2, "task_complete")], total: 3))
        XCTAssertEqual(progress.phase, .working)
        XCTAssertEqual(progress.startedAt, Date(timeIntervalSince1970: 2000))
        progress.receive(try frame("backlog", [], total: 0, reset: true))
        XCTAssertEqual(progress.phase, .working)
        progress.receive(try frame("backlog", [row(0, "task_complete")], total: 20, reset: true))
        XCTAssertEqual(progress.phase, .finished)
        XCTAssertNil(progress.startedAt)
    }

    func testCodexCachedInputIsIncludedAndCompletionAliasFinishes() throws {
        var progress = AgentChatProgress()
        progress.receive(try frame("backlog", [row(0, "task_started"), row(1, "token_count", ["info": [
            "last_token_usage": ["input_tokens": 227163, "cached_input_tokens": 224640, "output_tokens": 231, "reasoning_output_tokens": 37],
            "total_token_usage": ["input_tokens": 900000, "output_tokens": 8000]
        ]]), row(2, "task_completed")], total: 3))
        XCTAssertEqual(progress.usage?.uncachedInput, 2523)
        XCTAssertEqual(progress.usage?.output, 231)
        XCTAssertEqual(progress.usage?.reasoningOutput, 37)
        XCTAssertEqual(progress.phase, .finished)
        XCTAssertNil(AgentTokenUsage.read(["input_tokens": 10, "cached_input_tokens": 20, "output_tokens": 2]))
    }

    func testClaudeUsageSkipsSidechainsAndMalformedCounters() throws {
        func claude(_ line: Int, usage: [String: Any], sidechain: Bool = false) -> [String: Any] {
            ["line": line, "raw": ["type": "assistant", "isSidechain": sidechain,
                "message": ["role": "assistant", "content": [], "usage": usage]]]
        }
        let valid: [String: Any] = ["input_tokens": 40, "cache_read_input_tokens": 25, "cache_creation_input_tokens": 15, "output_tokens": 9]
        let frames = try frame("backlog", [claude(0, usage: valid), claude(1, usage: valid, sidechain: true),
            claude(2, usage: ["input_tokens": -1, "output_tokens": 9]), claude(3, usage: ["input_tokens": true, "output_tokens": 2]),
            claude(4, usage: ["input_tokens": 1.5, "output_tokens": 9])], total: 5, source: "claude")
        XCTAssertEqual(frames.progressEvents.count, 1)
        var progress = AgentChatProgress(); progress.receive(frames)
        XCTAssertEqual(progress.usage?.output, 9); XCTAssertEqual(progress.usage?.cachedInput, 25)
        XCTAssertEqual(progress.usage?.input, 80); XCTAssertEqual(progress.usage?.uncachedInput, 55)
        XCTAssertNil(progress.phase)
    }

    func testLiveStatusIncludesActivityAndModelOnlyForChosenConversation() throws {
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "codex", sessionID: "session")
        let data = Data(#"{"agentStatus":{"source":"codex","session":"session","status":"working","modelName":"Example model"}}"#.utf8)
        let status = try AgentInteractionStatus.read(data, target: target)
        XCTAssertEqual(status?.activity, "working"); XCTAssertEqual(status?.modelName, "Example model")
    }

    private func row(_ line: Int, _ type: String, _ fields: [String: Any] = [:]) -> [String: Any] {
        var payload = fields; payload["type"] = type
        return ["line": line, "raw": ["type": "event_msg", "payload": payload]]
    }
    private func frame(_ kind: String, _ rows: [[String: Any]], total: Int, source: String = "codex", reset: Bool = false) throws -> AgentChatTranscript {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": source, "entries": rows, "totalLines": total, "reset": reset]), source: source)
    }
}
