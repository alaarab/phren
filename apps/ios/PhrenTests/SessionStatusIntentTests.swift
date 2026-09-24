import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class SessionStatusIntentTests: XCTestCase {
    private func report(state: SessionStatusReport.State, project: String? = "phren", computer: String = "Mini",
                        agent: String? = "codex", line: String? = nil, approval: Bool = false) throws -> SessionStatusReport {
        let host = try LiveHost(name: computer, address: "\(computer.lowercased()).fixture.invalid", username: "fixture")
        let rawState: String
        switch state {
        case .working: rawState = "working"
        case .waiting: rawState = "waiting"
        case .idle: rawState = "idle"
        case .done: rawState = "done"
        case .error: rawState = "error"
        case .unknown: rawState = "unknown"
        }
        var child: [String: Any] = [
            "id": "w1:t1", "label": "1", "title": "Status check", "agentStatus": rawState,
            "cwd": "/work/\(project ?? "scratch")", "branch": "feature/siri",
        ]
        if let agent { child["agent"] = agent }
        let data = try JSONSerialization.data(withJSONObject: [
            "kind": "herdr", "groups": [["id": "w1", "label": "Workspace", "children": [child]]],
        ])
        var entity = AgentSessionEntity(try LiveWorkspaces.read(data).sessions(on: host)[0])
        entity.project = project
        return SessionStatusReport(entity: entity, state: state, lastAssistantLine: line,
                                   approvalRequestID: approval ? UUID().uuidString : nil,
                                   approvalTitle: approval ? "Run the focused tests" : nil)
    }

    func testStatusDialogFormatsWorkingWaitingIdleAndDone() throws {
        XCTAssertEqual(SessionStatusText.dialog(for: try report(state: .working)),
                       "Codex on phren at Mini is working.")
        XCTAssertEqual(SessionStatusText.dialog(for: try report(state: .waiting)),
                       "Codex on phren at Mini is waiting for input.")
        XCTAssertEqual(SessionStatusText.dialog(for: try report(state: .waiting, approval: true)),
                       "Codex on phren at Mini is waiting for your approval.")
        var question = try report(state: .waiting, agent: "claude", approval: true)
        question.approvalIsQuestion = true
        XCTAssertEqual(SessionStatusText.dialog(for: question), "Claude on phren at Mini has a question for you.")
        XCTAssertEqual(SessionStatusText.dialog(for: try report(state: .idle)),
                       "Codex on phren at Mini is idle.")
        XCTAssertEqual(SessionStatusText.dialog(for: try report(state: .done)),
                       "Codex on phren at Mini is done.")
    }

    func testTypedStatusMapsEveryShortcutField() throws {
        let report = try report(state: .waiting, project: "phren", computer: "Mini", agent: "codex", line: "Tests need approval.")
        let value = SessionStatusEntity(report: report)
        XCTAssertEqual(value.id, report.entity.id)
        XCTAssertEqual(value.state, "waiting")
        XCTAssertEqual(value.project, "phren")
        XCTAssertEqual(value.computer, "Mini")
        XCTAssertEqual(value.harness, "Codex")
        XCTAssertEqual(value.lastLine, "Tests need approval.")
        XCTAssertEqual(value.branch, "feature/siri")
    }

    func testTranscriptTailBoundsCountToolOutputAndTotalText() throws {
        var payloads: [[String: Any]] = (0..<205).map { index in
            ["type": "message", "role": "assistant", "content": "line-\(index)"]
        }
        payloads.append(["type": "function_call_output", "output": String(repeating: "x", count: 2_000)])
        let data = try JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "codex", "entries": payloads.enumerated().map {
            ["line": $0.offset, "raw": ["type": "response_item", "payload": $0.element]]
        }])
        let messages = try AgentChatTranscript.read(data, source: "codex").messages
        let text = SessionTranscriptText.tail(messages, lines: 500)
        XCTAssertFalse(text.contains("line-5\n"))
        XCTAssertTrue(text.contains("line-6"))
        XCTAssertTrue(text.contains("tool (Tool result): " + String(repeating: "x", count: SessionSummaryPrompt.maximumToolCharacters) + "…"))
        XCTAssertLessThanOrEqual(text.count, SessionSummaryPrompt.maximumPromptCharacters)
    }

    func testMessageWaitLoopTimesOutWithFakeTranscriptSource() async {
        actor FakeSource {
            var polls = 0
            func reply() -> String? { polls += 1; return nil }
        }
        let fake = FakeSource()
        do {
            _ = try await AgentReplyWaiter.wait(timeout: .milliseconds(25), pollInterval: .milliseconds(5)) {
                await fake.reply()
            }
            XCTFail("Wait returned without a reply")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("timed out"))
            let polls = await fake.polls
            XCTAssertGreaterThan(polls, 1)
        }
    }

    func testShortAssistantLineIsSpokenAndLongOrMissingLineIsNot() throws {
        let short = try report(state: .done, line: "  Tests passed.\n Ready to merge.  ")
        XCTAssertEqual(SessionStatusText.dialog(for: short),
                       "Codex on phren at Mini is done. Last update: Tests passed. Ready to merge.")
        let long = try report(state: .working, line: String(repeating: "A", count: SessionStatusText.spokenLineLimit + 1))
        XCTAssertEqual(SessionStatusText.dialog(for: long), "Codex on phren at Mini is working.")
        // A long reply of several sentences speaks the first ones that fit.
        let sentences = "Merged the sync fix. " + String(repeating: "Then I checked every other file carefully. ", count: 6)
        XCTAssertEqual(SessionStatusText.dialog(for: try report(state: .done, line: sentences)),
                       "Codex on phren at Mini is done. Last update: Merged the sync fix. Then I checked every other file carefully.")
        // Unmapped: the folder the agent sits in, not the Herdr workspace label.
        XCTAssertEqual(SessionStatusText.dialog(for: try report(state: .unknown, project: nil, agent: nil)),
                       "Agent on scratch at Mini has no current status.")
    }

    func testFreshAwaySummaryEnrichesStatusInsteadOfAssistantLine() throws {
        var value = try report(state: .working, line: "Older assistant update")
        value.awaySummary = AwaySummary(summary: "The focused tests pass and the branch is ready.",
                                        currentState: "done", blockers: [], suggestedNextStep: "Review the diff.")
        XCTAssertEqual(SessionStatusText.dialog(for: value),
                       "Codex on phren at Mini is working. Last update: Away summary: The focused tests pass and the branch is ready.")
    }

    func testWaitingFilterAndSpokenListUseOnlyWaitingSessions() throws {
        let reports = [
            try report(state: .working, project: "one"),
            try report(state: .waiting, project: "two"),
            try report(state: .done, project: "three"),
            try report(state: .waiting, project: "four", computer: "Studio", agent: "claude"),
        ]
        XCTAssertEqual(SessionStatusText.waiting(reports).map(\.projectName), ["two", "four"])
        XCTAssertEqual(SessionStatusText.waitingDialog(reports),
                       "2 sessions are waiting: Codex on two at Mini, Claude on four at Studio.")
        XCTAssertEqual(SessionStatusText.waitingDialog([reports[0], reports[2]]),
                       "No sessions are waiting for input or approval.")
    }

    func testMostRelevantPrefersWaitingThenWorking() throws {
        let done = try report(state: .done, project: "done")
        let working = try report(state: .working, project: "working")
        let waiting = try report(state: .waiting, project: "waiting")
        XCTAssertEqual(SessionStatusService.mostRelevant([done, working, waiting])?.projectName, "waiting")
        XCTAssertEqual(SessionStatusService.mostRelevant([done, working])?.projectName, "working")
        XCTAssertNil(SessionStatusService.mostRelevant([]))
    }

    func testRankCanResolveHarnessAndComputerStatusPhrase() throws {
        let mini = try report(state: .done).entity
        let studio = try report(state: .done, computer: "Studio").entity
        XCTAssertEqual(AgentSessionEntityQuery.rank("is codex done on mini", among: [studio, mini]).map(\.id), [mini.id])
    }

    func testApproveAndRejectConsumeExactSavedRequestAndForwardDecision() async throws {
        actor Decisions {
            var values: [(String, Bool)] = []
            func append(_ action: String, _ approve: Bool) { values.append((action, approve)) }
        }
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ApprovalRequestStore(url: root.appending(path: "requests.json"))
        let host = try LiveHost(name: "Mini", address: "mini.fixture.invalid", username: "fixture")
        let target = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1",
                                         source: "codex", sessionID: "conversation")
        let preferences = try LiveSessionPreferences.read(LiveSessionPreferences.saving(host, in: Data()))
        let decisions = Decisions()

        for approve in [true, false] {
            let id = UUID().uuidString
            _ = try await store.save(.init(id: id, actionID: approve ? "approve-action" : "reject-action",
                                           host: host, target: target, expiresAt: Date().addingTimeInterval(55)))
            try await SessionApprovalAction.answer(requestID: id, approve: approve, store: store, preferences: preferences) { record, decision in
                await decisions.append(record.actionID, decision)
            }
            do {
                try await SessionApprovalAction.answer(requestID: id, approve: approve, store: store,
                                                       preferences: preferences) { _, _ in }
                XCTFail("Approval replayed")
            } catch { }
        }
        let values = await decisions.values
        XCTAssertEqual(values.map(\.0), ["approve-action", "reject-action"])
        XCTAssertEqual(values.map(\.1), [true, false])
        // A saved question survives the round trip through disk with its flag.
        let id = UUID().uuidString
        _ = try await store.save(.init(id: id, actionID: "ask-action", host: host, target: target, expiresAt: Date().addingTimeInterval(55), question: true))
        let claimed = try await ApprovalRequestStore(url: root.appending(path: "requests.json")).claim(id, preferences: preferences)
        XCTAssertEqual(claimed.question, true)
    }
}
