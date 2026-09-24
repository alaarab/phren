import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class ChatStreamingTests: XCTestCase {
    func testPreviewIsReplacedWithPreparedRealRowWithoutDuplicateOrRevealRestart() async throws {
        let model = AgentChatModel()
        model.accept(try frame("backlog", text: "History", line: 0))
        let preview = try AgentChatTranscript.read(Data(#"{"type":"preview","source":"codex","preview":{"turnStartedAt":"2026-09-22T10:00:00Z","text":"One two three"}}"#.utf8), source: "codex")
        model.accept(preview)
        XCTAssertEqual(model.replyPreview?.text, "One two three")
        XCTAssertFalse(model.messages.contains { $0.text == "One two three" })
        let real = try AgentChatTranscript.read(Data(#"{"type":"append","source":"codex","preview":null,"totalLines":2,"entries":[{"line":1,"raw":{"type":"response_item","payload":{"type":"message","role":"assistant","content":"One two three four"}}}]}"#.utf8), source: "codex")
        model.accept(real)
        XCTAssertFalse(model.reveal.isRevealing)
        for _ in 0..<200 {
            let realRows = model.timeline.flatMap(\.messages).filter { $0.text == "One two three four" }
            XCTAssertFalse(model.replyPreview != nil && !realRows.isEmpty, "No render frame can contain both rows")
            if !realRows.isEmpty { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNil(model.replyPreview)
        XCTAssertEqual(model.timeline.flatMap(\.messages).filter { $0.text == "One two three four" }.count, 1)
        XCTAssertTrue(model.reveal.visible.isEmpty)
    }

    /// Stream a Claude reply, land it, then reconnect with a resume backlog
    /// that repeats the landed row: the reply shows exactly once.
    func testStreamedReplyLandedThenResumedShowsOnce() async throws {
        let model = AgentChatModel()
        func claude(_ kind: String, _ entries: [[String: Any]], total: Int, extra: [String: Any] = [:]) throws -> AgentChatTranscript {
            var frame: [String: Any] = ["type": kind, "source": "claude", "totalLines": total, "entries": entries]
            frame.merge(extra) { $1 }
            return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: "claude")
        }
        let user: [String: Any] = ["line": 6, "raw": ["type": "user", "timestamp": "2026-09-24T08:16:46Z", "message": ["role": "user", "content": "How are they doing?"]]]
        let reply = "Six of the seven fixes are **combined** on one branch."
        let landed: [String: Any] = ["line": 26, "raw": ["type": "assistant", "timestamp": "2026-09-24T08:17:10Z",
            "message": ["role": "assistant", "stop_reason": "end_turn", "content": [["type": "text", "text": reply]]]]]
        model.accept(try claude("backlog", [user], total: 7))
        for length in [10, 30, reply.count] {
            model.accept(try claude("preview", [], total: 0, extra: ["preview": ["turnStartedAt": "2026-09-24T08:16:46Z", "text": String(reply.prefix(length))]]))
        }
        model.accept(try claude("append", [landed], total: 27, extra: ["preview": NSNull()]))
        model.accept(try claude("backlog", [landed], total: 27))
        for _ in 0..<200 where model.replyPreview != nil || !model.timeline.flatMap(\.messages).contains(where: { $0.text == reply }) {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNil(model.replyPreview)
        XCTAssertEqual(model.timeline.flatMap(\.messages).filter { $0.text == reply }.count, 1)
        XCTAssertEqual(Set(model.timeline.map(\.id)).count, model.timeline.count, "Timeline rows keep unique identities")
    }

    func testPreviewClearsWhenStoppedDisconnectedOrChangingConversation() throws {
        let model = AgentChatModel()
        let preview = try AgentChatTranscript.read(Data(#"{"type":"preview","source":"claude","preview":{"turnStartedAt":"2026-09-22T10:00:00Z","text":"Partial words"}}"#.utf8), source: "claude")
        model.accept(preview); model.acceptActivity("idle")
        XCTAssertNil(model.replyPreview)
        model.accept(preview); model.handleConnectionFailure(CancellationError())
        XCTAssertNil(model.replyPreview)
        model.accept(preview); model.chooseAnother()
        XCTAssertNil(model.replyPreview)
    }

    /// A message the Hook typed into the terminal may have arrived: putting it
    /// back in the composer sent it again with the next message.
    func testOnlyAnUntypedFailedDeliveryReturnsToTheComposer() {
        XCTAssertFalse(AgentChatModel.returnsToComposer(delivered: false, typed: true), "Unconfirmed after typing")
        XCTAssertTrue(AgentChatModel.returnsToComposer(delivered: false, typed: false), "Refused or never reached the computer")
        XCTAssertFalse(AgentChatModel.returnsToComposer(delivered: true, typed: true))
    }

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
