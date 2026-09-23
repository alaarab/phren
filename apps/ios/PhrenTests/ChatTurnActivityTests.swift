import Foundation
import PhrenKit
import XCTest
@testable import Phren

final class ChatTurnActivityTests: XCTestCase {
    func testPreparationOwnsEachTurnAndRestoresCompletedRowsOnReopen() throws {
        let frame = try transcript([
            message("user", "First"), event("task_started", at: 1000), message("assistant", "First reply"), event("task_complete", at: 1027),
            message("user", "Second"), event("task_started", at: 1100),
            ["type": "response_item", "payload": ["type": "function_call", "name": "exec_command", "call_id": "shell", "arguments": "{\"cmd\":\"pwd\"}"]]
        ])
        var progress = AgentChatProgress(); progress.receive(frame)
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages, activity: .init(turns: progress.turns, busy: true))
        let done = try XCTUnwrap(prepared.entries.first { $0.turnActivity?.isLive == false })
        XCTAssertEqual(done.turnActivity?.ownerID, "0:0")
        XCTAssertEqual(done.placeholderIdentifier, "chat-activity-done")
        XCTAssertEqual(done.placeholderLabel, "Thought for 27s")
        XCTAssertEqual(prepared.entries[1].id, done.id)
        XCTAssertEqual(prepared.entries[2].messages.first?.text, "First reply")
        let live = try XCTUnwrap(prepared.entries.last?.turnActivity)
        XCTAssertEqual(live.ownerID, "4:0")
        XCTAssertEqual(live.verb, "Running Shell")
        XCTAssertEqual(prepared.entries.filter { $0.turnActivity?.isLive == true }.count, 1)

        let finish = try transcript([message("assistant", "Second reply"), event("task_complete", at: 1172)], firstLine: 7, kind: "append")
        progress.receive(finish)
        let messages = frame.messages + finish.messages
        prepared.update(messages, activity: .init(turns: progress.turns))
        let summaries = prepared.entries.compactMap(\.turnActivity)
        XCTAssertEqual(summaries.map(\.ownerID), ["0:0", "4:0"])
        XCTAssertEqual(summaries.map { $0.label(at: .distantFuture) }, ["Thought for 27s", "Worked for 1m 12s"])
        XCTAssertEqual(prepared.entries.suffix(2).first?.turnActivity?.ownerID, "4:0")
        XCTAssertEqual(prepared.entries.last?.messages.first?.text, "Second reply")
        var reopened = ChatTranscriptPreparation()
        reopened.update(messages, activity: .init(turns: progress.turns))
        XCTAssertEqual(reopened.entries, prepared.entries)
    }

    /// A sent message the transcript has not echoed is prepared together
    /// with the submit's live line, and above it.
    func testPendingEchoLandsWithTheLiveLineAndAboveIt() throws {
        let frame = try transcript([message("assistant", "Ready")])
        let echo = ChatPendingEcho(id: UUID(), text: "Fix the header", images: [])
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages, activity: .init(submittedAt: .now, submittedAfterLine: 0, busy: true, pendingEchoes: [echo]))
        let ids = prepared.entries.map(\.id)
        XCTAssertEqual(prepared.entries.last?.turnActivity?.isLive, true)
        XCTAssertEqual(ids.suffix(2).first, "pending:\(echo.id)")
        prepared.update(frame.messages, activity: .init(submittedAt: .now, submittedAfterLine: 0, busy: true))
        XCTAssertFalse(prepared.entries.contains { $0.pendingEcho != nil }, "An acknowledged receipt leaves no bubble")
    }

    func testProgressOnlyCompletionInvalidatesPreparationAndWaitingHidesLiveRow() throws {
        let frame = try transcript([event("task_started", at: 1000), message("user", "Hello")])
        var progress = AgentChatProgress(); progress.receive(frame)
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages, activity: .init(turns: progress.turns, busy: true))
        XCTAssertEqual(prepared.entries.last?.turnActivity?.ownerID, "1:0", "A start can precede its user row")
        XCTAssertEqual(prepared.entries.last?.turnActivity?.verb, "Thinking")
        prepared.update(frame.messages, activity: .init(turns: progress.turns, busy: true, waiting: true))
        XCTAssertFalse(prepared.entries.contains { $0.turnActivity != nil })
        progress.receive(try transcript([event("turn_aborted", at: 1012)], firstLine: 2, kind: "append"))
        prepared.update(frame.messages, activity: .init(turns: progress.turns))
        XCTAssertEqual(prepared.entries.last?.placeholderLabel, "Stopped after 12s")
        XCTAssertEqual(prepared.entries.last?.placeholderIdentifier, "chat-activity-done")
        let revision = prepared.revision
        prepared.update(frame.messages, activity: .init(turns: progress.turns), at: .distantFuture)
        XCTAssertEqual(prepared.revision, revision, "Clock ticks do not reprepare the transcript")
    }

    func testMissingStartAndUnrelatedEarlierToolsDoNotLeakIntoCurrentTurn() throws {
        let frame = try transcript([
            message("user", "Earlier"),
            ["type": "response_item", "payload": ["type": "function_call", "name": "Read", "call_id": "old", "arguments": "{}"]],
            message("assistant", "Earlier reply"), message("user", "Current"), event("task_started", at: 1000)
        ])
        var progress = AgentChatProgress(); progress.receive(frame)
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages, activity: .init(turns: progress.turns, busy: true))
        XCTAssertEqual(prepared.entries.last?.turnActivity?.verb, "Thinking")
        let missing = try transcript([message("user", "No clock"), ["type": "event_msg", "payload": ["type": "task_started"]], event("task_complete", at: 1200)])
        progress = .init(); progress.receive(missing)
        prepared.update(missing.messages, activity: .init(turns: progress.turns))
        XCTAssertFalse(prepared.entries.contains { $0.turnActivity != nil })
    }

    func testQueuedInputCannotStealTheActiveTurnAndTextChangesItsVerb() throws {
        let frame = try transcript([message("user", "Current"), event("task_started", at: 1000), message("assistant", "Writing the reply")])
        var progress = AgentChatProgress(); progress.receive(frame)
        var queued = try XCTUnwrap(transcript([message("user", "Next")], firstLine: 3).messages.first)
        queued.isQueued = true
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages + [queued], activity: .init(turns: progress.turns,
            submittedAt: Date(timeIntervalSince1970: 1020), submittedAfterLine: 2, busy: true))
        XCTAssertEqual(prepared.entries.last?.turnActivity?.ownerID, "0:0")
        XCTAssertEqual(prepared.entries.last?.turnActivity?.verb, "Responding")
        XCTAssertEqual(prepared.entries.last?.turnActivity?.startedAt, Date(timeIntervalSince1970: 1000))
        XCTAssertEqual(prepared.entries.filter { $0.turnActivity != nil }.count, 1)
    }

    func testSubmitFallbackAndToolVerbsUseCardTitles() throws {
        var prepared = ChatTranscriptPreparation()
        prepared.update([], activity: .init(submittedAt: Date(timeIntervalSince1970: 1000), busy: true))
        XCTAssertEqual(prepared.entries.last?.turnActivity?.verb, "Thinking")
        XCTAssertEqual(ToolPresentation(title: "functions.exec_command", text: "{}").activityVerb, "Running Shell")
        XCTAssertEqual(ToolPresentation(title: "Read", text: "{}").activityVerb, "Reading")
        XCTAssertEqual(ToolPresentation(title: "functions.apply_patch", text: "{}").activityVerb, "Editing")
        XCTAssertEqual(ChatTurnActivity.duration(59), "59s")
        XCTAssertEqual(ChatTurnActivity.duration(64), "1m 04s")
    }

    private func message(_ role: String, _ text: String) -> [String: Any] {
        ["type": "response_item", "payload": ["type": "message", "role": role, "content": text]]
    }
    private func event(_ type: String, at seconds: Double) -> [String: Any] {
        ["type": "event_msg", "timestamp": Date(timeIntervalSince1970: seconds).ISO8601Format(),
         "payload": ["type": type, "started_at": seconds, "completed_at": seconds]]
    }
    private func transcript(_ raws: [[String: Any]], firstLine: Int = 0, kind: String = "backlog") throws -> AgentChatTranscript {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": "codex", "totalLines": firstLine + raws.count,
            "entries": raws.enumerated().map { ["line": firstLine + $0.offset, "raw": $0.element] }]), source: "codex")
    }
}
