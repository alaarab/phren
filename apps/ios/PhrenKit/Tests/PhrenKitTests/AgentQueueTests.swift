import XCTest
@testable import PhrenKit

final class AgentQueueTests: XCTestCase {
    private let key = String(repeating: "a", count: 64)
    private func frame(_ kind: String, _ entries: [[String: Any]]) throws -> AgentChatTranscript {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": "claude", "entries": entries,
            "totalLines": 10, "startLine": 0, "hasMore": false]), source: "claude")
    }
    private func enqueue(_ line: Int) -> [String: Any] {
        ["line": line, "raw": ["type": "user", "phrenQueued": true, "phrenQueueKey": key,
                              "message": ["role": "user", "content": "Run tests"]]]
    }
    func testRepeatedPromptsRemainDistinctAndConsumptionOnlyChangesTheFirstBubble() throws {
        var history = AgentChatHistory()
        history.receive(try frame("backlog", [enqueue(1), enqueue(2)]))
        XCTAssertEqual(history.messages.map(\.isQueued), [true, true])
        let consumed = try frame("append", [["line": 3, "raw": ["type": "phren_queue_consumed", "key": key]]])
        XCTAssertTrue(consumed.messages.isEmpty)
        history.receive(consumed)
        XCTAssertEqual(history.messages.map(\.isQueued), [false, true])
        history.receive(consumed)
        history.receive(try frame("backlog", [enqueue(1), enqueue(2)]))
        XCTAssertEqual(history.messages.map(\.isQueued), [false, true], "Reconnect cannot consume twice or resurrect the queued tag")
        XCTAssertEqual(history.messages.map(\.text), ["Run tests", "Run tests"])
    }
    func testHistoryRetentionCannotConsumeTheNextIdenticalPrompt() throws {
        var history = AgentChatHistory()
        history.receive(try frame("backlog", [enqueue(1), enqueue(2),
            ["line": 3, "raw": ["type": "phren_queue_consumed", "key": key]]]))
        let filler = (4..<4_003).map {
            AgentChatMessage(id: "\($0):0", line: $0, role: .assistant, title: nil, text: "reply")
        }
        history.receive(.init(kind: .append, messages: filler, hasMore: false, totalLines: 4_003, startLine: 4))
        XCTAssertFalse(history.messages.contains { $0.line == 1 })
        history.receive(.init(kind: .append, messages: [], hasMore: false, totalLines: 4_003, startLine: nil))
        XCTAssertTrue(try XCTUnwrap(history.messages.first { $0.line == 2 }).isQueued)
    }

    func testConsumptionCanArriveBeforeItsOlderPageWithoutLeakingABubble() throws {
        var history = AgentChatHistory()
        history.receive(try frame("backlog", [["line": 3, "raw": ["type": "phren_queue_consumed", "key": key]]]))
        history.receive(try frame("older", [enqueue(1)]))
        XCTAssertEqual(history.messages.map(\.isQueued), [false])
        XCTAssertTrue(history.messages[0].wasQueued)
    }
}
