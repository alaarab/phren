import Foundation
import XCTest
import PhrenKit
@testable import Phren

@MainActor final class StartingChatTests: XCTestCase {
    func testAttachingKeepsComposerAndPendingBubbleUntilRealTurnArrives() throws {
        let host = UUID()
        let model = AgentChatModel()
        let starting = try AgentChatTarget(hostID: host, workspaceID: "w", tabID: "w:t", paneID: "w:p", source: "codex", sessionID: "", startingToken: String(repeating: "a", count: 64))
        let attached = try AgentChatTarget(hostID: host, workspaceID: "w", tabID: "w:t", paneID: "w:p", source: "codex", sessionID: "first-session")
        model.target = starting
        model.draft = "A follow-up I'm still writing"
        let pending = QueuedMessage(text: "First prompt", attachments: [], submittedAfterLine: -1, submittedText: "First prompt")
        model.queue = [pending]
        XCTAssertFalse(model.shouldBeginStream(starting))
        model.attachStartingTarget(attached)
        XCTAssertEqual(model.target, attached)
        XCTAssertEqual(model.draft, "A follow-up I'm still writing")
        XCTAssertEqual(model.queue.map(\.id), [pending.id])
        XCTAssertNil(AgentChatQueues.items[starting.id])
        XCTAssertTrue(model.shouldBeginStream(attached))
        let frame = try AgentChatTranscript.read(Data(#"{"type":"backlog","source":"codex","totalLines":1,"entries":[{"line":0,"raw":{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"First prompt"}]}}}]}"#.utf8), source: "codex")
        model.accept(frame)
        XCTAssertTrue(model.queue.isEmpty)
        XCTAssertEqual(model.messages.map(\.text), ["First prompt"])
    }
}
