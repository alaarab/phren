import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class ChatStreamingTests: XCTestCase {
    func testCancelledDeliveryExplainsUncertainReceiptWithoutSwiftJargon() {
        let message = AgentDeliveryMessage.sendFailure(CancellationError(), rejected: false)
        XCTAssertEqual(message, "The connection closed before Phren received confirmation. Check the conversation before sending again. Phren did not retry.")
        XCTAssertFalse(message.contains("CancellationError"))
    }

    @MainActor
    func testRejectedTranscriptDoesNotRetryAfterPanePollingFailure() throws {
        let model = AgentChatModel()
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "claude", sessionID: "fixture")
        model.target = target
        model.accept(try frame("backlog", text: "Keep the loaded conversation", line: 0))
        model.handleStreamFailure(AgentChatTranscript.LimitError.tooManyMessages, target: target)
        XCTAssertFalse(model.shouldBeginStream(target))
        XCTAssertTrue(model.automaticReconnectSuspended)
        let explanation = model.error
        model.handleConnectionFailure(PhrenKitError.validation("Temporary computer connection failure"))
        XCTAssertFalse(model.shouldBeginStream(target), "Host recovery must not reload the same rejected backlog")
        XCTAssertEqual(model.error, explanation)
        XCTAssertEqual(model.messages.map(\.text), ["Keep the loaded conversation"])
        model.chooseAnother()
        XCTAssertTrue(model.shouldBeginStream(target), "Explicit session selection permits a new attempt")
        XCTAssertFalse(model.automaticReconnectSuspended)
    }

    func testCurrentActivityOverridesHistoricalWorkingWithoutReplayingOldFrames() throws {
        let model = AgentChatModel()
        let started = try AgentChatTranscript.read(Data(#"{"type":"backlog","source":"codex","totalLines":2,"entries":[{"line":1,"raw":{"type":"event_msg","payload":{"type":"task_started"}}}]}"#.utf8), source: "codex")
        model.accept(started)
        XCTAssertEqual(model.activityPhase, .working)
        model.acceptActivity("idle")
        XCTAssertNil(model.activityPhase)
        model.accept(started)
        XCTAssertNil(model.activityPhase, "Reconnects must not revive stale working state")
        model.acceptActivity("working")
        let done = try AgentChatTranscript.read(Data(#"{"type":"append","source":"codex","totalLines":3,"entries":[{"line":2,"raw":{"type":"event_msg","payload":{"type":"task_completed"}}}]}"#.utf8), source: "codex")
        model.accept(done)
        XCTAssertEqual(model.activityPhase, .finished)
    }
    func testRepeatedWorkingStatusCannotReviveCompletedTurnAfterAnswering() throws {
        let model = AgentChatModel()
        model.acceptActivity("waiting")
        model.acceptActivity("working")
        model.accept(try lifecycle("task_started", kind: "append", line: 1))
        XCTAssertTrue(model.isBusy)
        model.accept(try lifecycle("task_completed", kind: "append", line: 2))
        XCTAssertFalse(model.isBusy)
        model.acceptActivity("working")
        XCTAssertEqual(model.activityPhase, .finished)
        XCTAssertFalse(model.isBusy, "A stale status tick must not leave follow-ups queued after completion")
        model.acceptActivity("idle")
        model.acceptActivity("working")
        XCTAssertTrue(model.isBusy, "A real new turn still queues follow-ups")
    }

    func testHistoricalStartDoesNotOverrideCurrentIdleStatus() throws {
        let model = AgentChatModel()
        model.acceptActivity("idle")
        model.accept(try lifecycle("task_started", kind: "backlog", line: 1))
        model.acceptActivity("idle")
        XCTAssertFalse(model.isBusy)
        model.accept(try lifecycle("task_started", kind: "append", line: 2))
        XCTAssertTrue(model.isBusy, "A fresh lifecycle event still starts a new turn")
    }

    func testReopeningDiscoversCompletionWhileTerminalStillSaysWorking() throws {
        let model = AgentChatModel()
        model.acceptActivity("working")
        model.accept(try lifecycle("task_started", kind: "backlog", line: 1))
        XCTAssertTrue(model.isBusy)
        model.accept(try lifecycle("task_completed", kind: "backlog", line: 2))
        model.acceptActivity("working")
        XCTAssertFalse(model.isBusy)
    }

    private func lifecycle(_ type: String, kind: String, line: Int) throws -> AgentChatTranscript {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": "codex", "totalLines": line + 1,
            "entries": [["line": line, "raw": ["type": "event_msg", "payload": ["type": type]]]]]), source: "codex")
    }

    func testNewTextAppearsProgressivelyAndAdditionalTextKeepsItsVisiblePrefix() throws {
        let model = AgentChatModel()
        model.accept(try frame("backlog", text: "History", line: 0))
        XCTAssertFalse(model.reveal.isRevealing)
        model.accept(try frame("append", text: "One two three four five six", line: 1))
        XCTAssertEqual(model.reveal.visible["1:0"], "")
        model.reveal.advance()
        XCTAssertEqual(model.reveal.visible["1:0"], "One ")
        model.accept(try frame("append", text: "One two three four five six seven eight", line: 1))
        XCTAssertEqual(model.reveal.visible["1:0"], "One ")
        for _ in 0..<12 { model.reveal.advance() }
        XCTAssertFalse(model.reveal.isRevealing)
        XCTAssertEqual(model.messages.last?.text, "One two three four five six seven eight")
        model.accept(try frame("append", text: "One two three four five six seven eight", line: 1))
        XCTAssertFalse(model.reveal.isRevealing, "Duplicate entries must never replay the animation")
    }

    func testReconnectAccessibilityAndHistoryAppearImmediately() throws {
        let model = AgentChatModel()
        model.accept(try frame("backlog", text: "History", line: 0))
        model.accept(try frame("append", text: "New incoming words", line: 1))
        XCTAssertTrue(model.reveal.isRevealing)
        model.accept(try frame("backlog", text: "New incoming words", line: 1))
        XCTAssertFalse(model.reveal.isRevealing)
        model.animateReplies = false
        model.accept(try frame("append", text: "Read this immediately", line: 2))
        XCTAssertFalse(model.reveal.isRevealing)
        XCTAssertEqual(model.messages.last?.text, "Read this immediately")
    }

    func testLongUnicodeReplyCatchesUpWithoutCorruptingText() throws {
        let model = AgentChatModel()
        model.accept(try frame("backlog", text: "History", line: 0))
        let reply = String(repeating: "Hello 👩🏽‍💻 世界 مرحبًا e\u{301} \n", count: 500)
        model.accept(try frame("append", text: reply, line: 1))
        for _ in 0..<75 {
            model.reveal.advance()
            if let visible = model.reveal.visible["1:0"] { XCTAssertTrue(reply.hasPrefix(visible)) }
        }
        XCTAssertFalse(model.reveal.isRevealing)
        XCTAssertEqual(model.messages.last?.text, reply)
    }

    private func frame(_ kind: String, text: String, line: Int) throws -> AgentChatTranscript {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": "codex", "totalLines": line + 1,
            "entries": [["line": line, "raw": ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": text]]]]]), source: "codex")
    }
}
