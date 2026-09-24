import Foundation
import XCTest
@testable import PhrenKit

final class AgentChatPreviewTests: XCTestCase {
    func testPreviewDecodesSeparatelyFromHistoryAndActions() throws {
        let frame = try AgentChatTranscript.read(Data(#"{"type":"preview","source":"claude","session":"preview-session","preview":{"turnStartedAt":"2026-09-22T10:00:00.000Z","text":"The reply is growing"}}"#.utf8), source: "claude", session: "preview-session")
        XCTAssertEqual(frame.kind, .preview)
        XCTAssertTrue(frame.updatesPreview)
        XCTAssertEqual(frame.preview?.text, "The reply is growing")
        XCTAssertEqual(frame.preview?.turnStartedAt, ISO8601Dates.parse("2026-09-22T10:00:00Z"))
        XCTAssertTrue(frame.messages.isEmpty)
        XCTAssertTrue(frame.questionEvents.isEmpty)
        XCTAssertTrue(frame.progressEvents.isEmpty)
        var history = AgentChatHistory()
        let before = history
        history.receive(frame)
        XCTAssertEqual(history, before)
    }

    func testClaudeSpinnerVerbRidesBesideFramesAndRejectsAnythingElse() throws {
        let frame = try AgentChatTranscript.read(Data(#"{"type":"append","source":"claude","activityVerb":"Pondering","entries":[]}"#.utf8), source: "claude")
        XCTAssertEqual(frame.activityVerb, "Pondering")
        let odd = try AgentChatTranscript.read(Data(#"{"type":"append","source":"claude","activityVerb":"rm -rf /","entries":[]}"#.utf8), source: "claude")
        XCTAssertNil(odd.activityVerb)
    }

    func testRealEntryClearsPreviewInItsOwnFrame() throws {
        let frame = try AgentChatTranscript.read(Data(#"{"type":"append","source":"claude","preview":null,"entries":[{"line":1,"raw":{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Finished reply"}]}}}]}"#.utf8), source: "claude")
        XCTAssertTrue(frame.updatesPreview)
        XCTAssertNil(frame.preview)
        XCTAssertEqual(frame.messages.map(\.text), ["Finished reply"])
    }

    func testPreviewCannotSmuggleMessagesAndOlderPagesCannotResurrectIt() throws {
        XCTAssertThrowsError(try AgentChatTranscript.read(Data(#"{"type":"preview","source":"claude","preview":null,"entries":[{"line":1,"raw":{}}]}"#.utf8), source: "claude"))
        let older = try AgentChatTranscript.read(Data(#"{"type":"older","source":"claude","preview":{"turnStartedAt":"2026-09-22T10:00:00Z","text":"Stale"}}"#.utf8), source: "claude")
        XCTAssertFalse(older.updatesPreview)
        XCTAssertNil(older.preview)
        XCTAssertThrowsError(try AgentChatTranscript.read(Data(#"{"type":"preview","source":"claude","preview":{"turnStartedAt":"bad date","text":"Words"}}"#.utf8), source: "claude"))
    }
}
