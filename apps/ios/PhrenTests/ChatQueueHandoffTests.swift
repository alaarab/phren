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

    func testAttachmentOnlySteerIsAcknowledgedByItsImageTurn() throws {
        let model = AgentChatModel()
        let picture = QueuedMessage(text: "", attachments: [.init(attachment: AgentChatFixture.image)], submittedAfterLine: 0, submittedText: "")
        let words = QueuedMessage(text: "Look", attachments: [], submittedAfterLine: 0, submittedText: "Look")
        model.queue = [picture, words]
        let png = AgentChatFixture.image.data.base64EncodedString()
        model.accept(try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "claude",
            "totalLines": 2, "entries": [["line": 1, "raw": ["type": "user", "message": ["role": "user", "content": [
                ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": png]]]]]]]]), source: "claude"))
        XCTAssertEqual(model.queue.map(\.id), [words.id], "A picture with no words is matched by the landed image turn, and only that")
    }

    func testEveryHarnessDeliversMidTurnAndOnlyReadinessBlocksIt() throws {
        for source in AgentChatTarget.sources {
            let model = AgentChatModel()
            model.target = try AgentChatTarget(hostID: UUID(), workspaceID: "w", tabID: "w:t", paneID: "w:p",
                source: source, sessionID: source == "opencode" ? "ses_fixture" : "00000000-0000-0000-0000-000000000042")
            model.connected = true
            model.acceptActivity("working")
            XCTAssertTrue(model.isBusy, source)
            XCTAssertNil(model.pendingReason, "\(source) must send during a working turn")
            model.isCompacting = true
            XCTAssertNil(model.pendingReason, "Compaction does not create a phone queue for \(source)")
            model.connected = false
            XCTAssertEqual(model.pendingReason, "Disconnected", source)
            model.connected = true
            model.passwordPrompt = true
            XCTAssertEqual(model.pendingReason, "Holding a prompt", source)
            model.passwordPrompt = false
            model.needsAnswer = true
            XCTAssertNil(model.pendingReason, "A plain composer answer remains sendable for \(source)")
            model.acceptActivity("unknown")
            XCTAssertEqual(model.pendingReason, "Disconnected", source)
        }
    }

    func testQueuedCodexQuestionDoesNotHoldSteeringWhileTheHarnessWorks() throws {
        let model = AgentChatModel()
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w", tabID: "w:t", paneID: "w:p",
            source: "codex", sessionID: "test-session")
        model.target = target; model.connected = true; model.acceptActivity("working")
        let status = try XCTUnwrap(AgentInteractionStatus.read(Data(#"{"agentStatus":{"source":"codex","session":"test-session","status":"working","terminalPrompt":{"toolName":"Question","message":"Deploy?","queued":true}}}"#.utf8), target: target))
        model.terminalPrompt = try XCTUnwrap(status.terminalPrompt)
        XCTAssertNil(model.pendingReason)
        model.acceptActivity("waiting")
        XCTAssertEqual(model.pendingReason, "Holding a prompt")
    }

    func testStartingAllowsFirstPromptAndHoldsFollowUpUntilAttached() throws {
        let model = AgentChatModel(), host = UUID()
        model.target = try AgentChatTarget(hostID: host, workspaceID: "w", tabID: "w:t", paneID: "w:p",
            source: "codex", sessionID: "", startingToken: String(repeating: "a", count: 64))
        model.connected = true
        XCTAssertNil(model.pendingReason, "A verified starting pane needs the first prompt to create its transcript")
        model.queue = [QueuedMessage(text: "First", attachments: [], submittedAfterLine: -1, submittedText: "First"),
                       QueuedMessage(text: "Follow-up", attachments: [])]
        XCTAssertEqual(model.pendingReason, "Starting")
        XCTAssertEqual(model.localPendingMessages.map(\.text), ["Follow-up"], "Submitted receipts never appear in the strip")
        model.edit(model.localPendingMessages[0])
        XCTAssertEqual(model.draft, "Follow-up")
        XCTAssertTrue(model.localPendingMessages.isEmpty)
        model.attachStartingTarget(try AgentChatTarget(hostID: host, workspaceID: "w", tabID: "w:t", paneID: "w:p",
            source: "codex", sessionID: "first-session"))
        // Attaching releases the "Starting" hold, but the new binding has no
        // transcript stream yet, so follow-ups wait for it rather than being
        // sent against a conversation the phone cannot reconcile.
        XCTAssertEqual(model.pendingReason, "Disconnected")
        let firstTurn = try AgentChatTranscript.read(Data(#"{"type":"backlog","source":"codex","totalLines":1,"entries":[]}"#.utf8), source: "codex")
        model.accept(firstTurn)
        XCTAssertNil(model.pendingReason, "The attached transcript's stream releases the follow-up")
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
