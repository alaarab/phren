import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class ChatQueueHandoffTests: XCTestCase {
    func testObservedQueueTurnReconcilesOnlyOneSubmittedCopyAndLeavesUnsentDraftsAlone() throws {
        let model = AgentChatModel()
        let first = QueuedMessage(text: "Run tests", attachments: [], submittedAfterLine: 1, submittedText: "Run tests")
        let second = QueuedMessage(text: "Run tests", attachments: [], submittedAfterLine: 1, submittedText: "Run tests")
        let unsent = QueuedMessage(text: "Run tests", attachments: [])
        model.queue = [first, second, unsent]
        model.accept(try frame(line: 1))
        XCTAssertEqual(model.queue.map(\.id), [first.id, second.id, unsent.id], "An older identical bubble is not an acknowledgement")
        model.accept(try frame(line: 2))
        XCTAssertEqual(model.queue.map(\.id), [second.id, unsent.id])
        model.accept(try frame(line: 2))
        XCTAssertEqual(model.queue.map(\.id), [second.id, unsent.id], "Repeating a backlog must not acknowledge a second prompt")
        model.remove(second)
        model.edit(second)
        XCTAssertEqual(model.queue.map(\.id), [second.id, unsent.id], "No edit/remove RPC exists for a handed-off prompt")
        model.remove(unsent)
        XCTAssertEqual(model.queue.map(\.id), [second.id])
    }

    private func frame(line: Int) throws -> AgentChatTranscript {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "claude",
            "totalLines": line + 1, "entries": [["line": line, "raw": ["type": "user", "phrenQueued": true,
            "phrenQueueKey": String(repeating: "a", count: 64), "message": ["role": "user", "content": "Run tests"]]]]]), source: "claude")
    }

    func testRealTurnDoesNotAcknowledgeASecondLocalCopyAfterItsQueuedTwin() throws {
        let model = AgentChatModel()
        let first = QueuedMessage(text: "Run tests", attachments: [], submittedAfterLine: 0, submittedText: "Run tests")
        let second = QueuedMessage(text: "Run tests", attachments: [], submittedAfterLine: 0, submittedText: "Run tests")
        model.queue = [first, second]
        model.accept(try frame(line: 1))
        XCTAssertEqual(model.queue.map(\.id), [second.id])
        let real = try AgentChatTranscript.read(Data(#"{"type":"append","source":"claude","totalLines":3,"entries":[{"line":2,"raw":{"type":"user","message":{"role":"user","content":"Run tests"}}}]}"#.utf8), source: "claude")
        model.accept(real)
        XCTAssertEqual(model.queue.map(\.id), [second.id])
        XCTAssertEqual(model.messages.map(\.id), ["2:0"])
    }
}
