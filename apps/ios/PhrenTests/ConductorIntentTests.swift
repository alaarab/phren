import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class ConductorIntentTests: XCTestCase {
    private func sessions(_ children: [[String: Any]], computer: String = "Desk") throws -> [LiveAgentSession] {
        let host = try LiveHost(name: computer, address: "\(computer.lowercased()).fixture.invalid", username: "fixture")
        let data = try JSONSerialization.data(withJSONObject: [
            "kind": "herdr", "groups": [["id": "w1", "label": "Workspace", "children": children]],
        ])
        return try LiveWorkspaces.read(data).sessions(on: host)
    }

    private func conductorTab(_ children: inout [[String: Any]], at index: Int, step: String? = nil) {
        children[index]["role"] = "conductor"
        if let step { children[index]["currentStep"] = step }
    }

    func testConductorLookupReturnsTheFirstConductorTab() throws {
        let live = try sessions([
            ["id": "w1:t1", "label": "1", "title": "Parser checks", "agent": "codex", "agentStatus": "working"],
            ["id": "w1:t2", "label": "2", "title": "Lead", "agent": "claude", "agentStatus": "working", "role": "conductor"],
            ["id": "w1:t3", "label": "3", "title": "Second lead", "agent": "codex", "agentStatus": "idle", "role": "conductor"],
        ])
        XCTAssertEqual(ConductorSession.find(in: live)?.tab.id, "w1:t2")
        XCTAssertNil(ConductorSession.find(in: try sessions([
            ["id": "w1:t1", "label": "1", "title": "Parser checks", "agent": "codex", "agentStatus": "working"],
        ])))
        XCTAssertNil(ConductorSession.find(in: []))
    }

    func testReplyExtractionSkipsEarlierLinesAndBoundsSpeech() throws {
        let frame: [String: Any] = [
            "type": "backlog", "source": "claude", "totalLines": 4,
            "entries": [
                ["line": 0, "raw": ["type": "assistant", "message": ["role": "assistant", "content": "Earlier dispatch line"]]],
                ["line": 1, "raw": ["type": "assistant", "message": ["role": "assistant", "content": "  Dispatched   the\nparser checks.  "]]],
                ["line": 2, "raw": ["type": "user", "message": ["role": "user", "content": "Run the tests"]]],
                ["line": 3, "raw": ["type": "assistant", "message": ["role": "assistant", "content": String(repeating: "a", count: 400)]]],
            ],
        ]
        let messages = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: "claude").messages
        XCTAssertEqual(ConductorReply.next(in: messages, after: 0), "Dispatched the parser checks.")
        XCTAssertNil(ConductorReply.next(in: messages, after: 3))
        let bounded = ConductorReply.next(in: messages, after: 2)
        XCTAssertEqual(bounded?.count, ConductorReply.spokenLimit)
    }

    func testOverviewCountsWorkingWaitingIdleAndConductorStep() throws {
        let live = try sessions([
            ["id": "w1:t1", "label": "1", "title": "Parser", "agent": "codex", "agentStatus": "working"],
            ["id": "w1:t2", "label": "2", "title": "Tests", "agent": "codex", "agentStatus": "working"],
            ["id": "w1:t3", "label": "3", "title": "Docs", "agent": "claude", "agentStatus": "blocked"],
            ["id": "w1:t4", "label": "4", "title": "Idle", "agent": "codex", "agentStatus": "idle"],
            ["id": "w1:t5", "label": "5", "title": "Lead", "agent": "claude", "agentStatus": "working",
             "role": "conductor", "currentStep": "Bash: swift build"],
        ])
        XCTAssertEqual(ConductorOverviewText.dialog(sessions: live),
                       "3 working, 1 waiting, 1 idle. Conductor: Bash: swift build.")
        XCTAssertEqual(ConductorOverviewText.dialog(sessions: []), "No agent sessions are running.")
    }
}