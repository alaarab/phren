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

    private func user(_ line: Int, text: String = "Run tests", images: Bool = false, key: String? = nil) -> [String: Any] {
        var raw: [String: Any] = ["type": "user", "message": ["role": "user", "content": images
            ? [["type": "text", "text": text], ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": "aGVsbG8="]]] as Any : text as Any]]
        if let key { raw["phrenQueueKey"] = key }
        return ["line": line, "raw": raw]
    }

    func testRealImageTurnReplacesQueuedTwinAndCannotReappearOnReconnect() throws {
        let text = "[Image #83]Why does this wrap?\n\nAttached files on this computer:"
        var queued = enqueue(1)
        var raw = queued["raw"] as! [String: Any]
        raw["message"] = ["role": "user", "content": text]; queued["raw"] = raw
        let page = try frame("backlog", [queued, user(2, text: text, images: true)])
        var history = AgentChatHistory(); history.receive(page)
        XCTAssertEqual(history.messages.count, 1)
        XCTAssertEqual(history.messages[0].id, "2:0")
        XCTAssertEqual(history.messages[0].imageBlocks, [1])
        XCTAssertFalse(history.messages[0].isQueued)
        XCTAssertEqual(history.acknowledgementID(for: "2:0"), "1:0")
        history.receive(page)
        XCTAssertEqual(history.messages.map(\.id), ["2:0"])
    }

    func testRepeatedRealTurnsAreNotDeduplicatedAndLateRemovalCannotConsumeNextSend() throws {
        var history = AgentChatHistory()
        history.receive(try frame("backlog", [enqueue(1), user(2), enqueue(3)]))
        XCTAssertEqual(history.messages.map(\.id), ["2:0", "3:0"])
        history.receive(try frame("append", [["line": 4, "raw": ["type": "phren_queue_consumed", "key": key]]]))
        XCTAssertEqual(history.messages.map(\.isQueued), [false, true], "The removal belongs to the already replaced first enqueue")
        history.receive(try frame("append", [user(5), user(6)]))
        XCTAssertEqual(history.messages.map(\.id), ["2:0", "5:0", "6:0"])
    }

    func testRepeatedBacklogCannotUseOneRealTurnToReplaceTwoIdenticalEnqueues() throws {
        let page = try frame("backlog", [enqueue(1), enqueue(2), user(3)])
        var history = AgentChatHistory(); history.receive(page)
        XCTAssertEqual(history.messages.map(\.id), ["2:0", "3:0"])
        let unchanged = history
        history.receive(page)
        XCTAssertEqual(history, unchanged)
        XCTAssertTrue(history.messages[0].isQueued)
    }

    func testKeyTakesPriorityAndTextFallbackStaysWithinPage() throws {
        var history = AgentChatHistory()
        history.receive(try frame("backlog", [enqueue(1)]))
        history.receive(try frame("append", [user(2, text: "Run  tests\nnow", key: key)]))
        XCTAssertEqual(history.messages.map(\.id), ["2:0"], "The key matches even if the real message gained text")

        history = AgentChatHistory()
        history.receive(try frame("backlog", [user(5)]))
        history.receive(try frame("older", [enqueue(1)]))
        XCTAssertEqual(history.messages.count, 2, "Do not match text across unrelated history pages")

        history = AgentChatHistory()
        history.receive(try frame("backlog", [enqueue(1), user(2, key: String(repeating: "b", count: 64))]))
        XCTAssertEqual(history.messages.count, 2, "Conflicting keys must not fall back to text")
    }

    func testUnkeyedPendingRowLandsAfterNextRealUserButNotAnAssistantTurn() throws {
        var row = enqueue(1), raw = enqueue(1)["raw"] as! [String: Any]
        raw.removeValue(forKey: "phrenQueueKey"); row["raw"] = raw
        var history = AgentChatHistory()
        history.receive(try frame("backlog", [row, ["line": 2, "raw": ["type": "assistant", "message": ["role": "assistant", "content": "Still working"]]]]))
        XCTAssertTrue(history.messages[0].isQueued)
        history.receive(try frame("append", [user(3, text: "Another instruction")]))
        XCTAssertFalse(history.messages[0].isQueued)
        XCTAssertEqual(history.messages.count, 3)
    }
}
