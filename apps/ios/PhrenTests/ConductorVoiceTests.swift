import PhrenKit
import XCTest
@testable import Phren

/// Pause all agents, talk mode in the background, and the seam an on-device
/// summarizer fills for what talk mode reads aloud.
@MainActor
final class ConductorVoiceTests: XCTestCase {
    private func sessions(_ children: [[String: Any]], computer: String = "Desk") throws -> [LiveAgentSession] {
        let host = try LiveHost(name: computer, address: "\(computer.lowercased()).fixture.invalid", username: "fixture")
        let data = try JSONSerialization.data(withJSONObject: [
            "kind": "herdr", "groups": [["id": "w1", "label": "Workspace", "children": children]],
        ])
        return try LiveWorkspaces.read(data).sessions(on: host)
    }

    private func target(_ session: LiveAgentSession, pane: String) throws -> AgentChatTarget {
        try AgentChatTarget(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id,
                            paneID: pane, source: session.tab.agent ?? "codex", sessionID: "s-\(pane)", muxID: session.host.muxID)
    }

    func testPauseStopsEveryWorkingPaneAndSkipsIdleSessions() async throws {
        let live = try sessions([
            ["id": "w1:t1", "label": "1", "title": "Parser checks", "agent": "codex", "agentStatus": "working"],
            ["id": "w1:t2", "label": "2", "title": "Release notes", "agent": "claude", "agentStatus": "idle"],
            ["id": "w1:t3", "label": "3", "title": "Widget fix", "agent": "claude", "agentStatus": "working"],
            ["id": "w1:t4", "label": "4", "title": "Shell"],
        ])
        XCTAssertEqual(AgentFleetPause.candidates(live).map(\.tab.id), ["w1:t1", "w1:t3"])
        var asked: [String] = []
        var stopped: [String] = []
        let outcome = await AgentFleetPause.pause(live, panes: { session in
            asked.append(session.tab.id)
            // The parser tab runs two working agents side by side.
            return session.tab.id == "w1:t1"
                ? [try self.target(session, pane: "p1"), try self.target(session, pane: "p2")]
                : [try self.target(session, pane: "p1")]
        }, stop: { _, target in stopped.append("\(target.tabID)/\(target.paneID)") })
        XCTAssertEqual(asked, ["w1:t1", "w1:t3"], "Idle and agentless tabs are never touched")
        XCTAssertEqual(stopped, ["w1:t1/p1", "w1:t1/p2", "w1:t3/p1"])
        XCTAssertEqual(outcome, .init(paused: 3, failed: []))
        XCTAssertEqual(outcome.summary, "Paused 3 agents.")
    }

    func testPauseReportsWhatCouldNotBeReached() async throws {
        let live = try sessions([
            ["id": "w1:t1", "label": "1", "title": "Parser checks", "agent": "codex", "agentStatus": "working"],
            ["id": "w1:t2", "label": "2", "title": "Widget fix", "agent": "claude", "agentStatus": "working"],
        ])
        struct Offline: Error {}
        let outcome = await AgentFleetPause.pause(live, panes: { session in
            if session.tab.id == "w1:t2" { throw Offline() }
            return [try self.target(session, pane: "p1")]
        }, stop: { _, _ in })
        XCTAssertEqual(outcome.paused, 1)
        XCTAssertEqual(outcome.failed, ["Widget fix"])
        XCTAssertEqual(outcome.summary, "Paused 1 agent; 1 couldn't be reached: Widget fix.")
        XCTAssertEqual(AgentFleetPause.Outcome().summary, "No agent was working.")
    }

    func testOnlyWorkingPanesBecomeStopTargets() throws {
        let session = try XCTUnwrap(sessions([
            ["id": "w1:t1", "label": "1", "title": "Parser checks", "agent": "codex", "agentStatus": "working"],
        ]).first)
        let data = try JSONSerialization.data(withJSONObject: ["kind": "herdr", "groupId": "w1", "childId": "w1:t1", "panes": [
            ["id": "w1:p1", "label": "1", "agent": "codex", "agentStatus": "working", "sessionId": "a"],
            ["id": "w1:p2", "label": "2", "agent": "claude", "agentStatus": "idle", "sessionId": "b"],
            ["id": "w1:p3", "label": "3", "agent": "codex", "agentStatus": "blocked", "sessionId": "c"],
        ]])
        let panes = try AgentChatPanes.read(data, workspaceID: "w1", tabID: "w1:t1")
        XCTAssertEqual(AgentFleetPause.workingTargets(panes, session: session).map(\.paneID), ["w1:p1"])
    }

    func testConfirmationNamesTheWorkingAgents() throws {
        let live = try sessions([
            ["id": "w1:t1", "label": "1", "title": "Parser checks", "agent": "codex", "agentStatus": "working"],
        ])
        XCTAssertEqual(PauseAllAgentsFlow.message(live),
                       "Interrupts Parser checks on Desk. They stay open and wait for your next message.")
        XCTAssertEqual(PauseAllAgentsFlow.message([]), "Nothing to pause on your computers right now.")
    }

    func testTalkKeepsGoingInTheBackgroundOnlyWhenOnAndDeclared() {
        XCTAssertTrue(TalkBackground.continues(true, declared: true))
        XCTAssertFalse(TalkBackground.continues(false, declared: true))
        XCTAssertFalse(TalkBackground.continues(true, declared: false))
        XCTAssertTrue(TalkBackground.declared, "The app declares the audio background mode")
    }

    func testTalkSpeaksWhatTheSummarizerReturns() async throws {
        let recognizer = TalkModeControllerTests.FakeRecognizer()
        let voice = TalkModeControllerTests.FakeVoice()
        var clock: TimeInterval = 0
        var reply: String?
        let talk = TalkModeController()
        var environment = TalkModeController.Environment(
            makeRecognizer: { recognizer }, makeVoice: { _ in voice }, permissions: { true },
            lastLine: { 0 }, send: { _ in true }, reply: { _ in reply },
            now: { clock }, pause: .quick, tick: .milliseconds(10))
        environment.spoken = { text in "Short: " + text.prefix(12) }
        talk.start(environment)
        let deadline = Date.now.addingTimeInterval(5)
        func wait(_ condition: () -> Bool) async throws {
            while !condition() {
                guard Date.now < deadline else { return XCTFail("timed out") }
                try await Task.sleep(for: .milliseconds(20))
            }
        }
        try await wait { talk.phase == .listening }
        recognizer.say("How did the build go")
        clock += 2
        try await wait { talk.phase == .thinking }
        reply = "The build passed on both computers and the phone tests are green."
        try await wait { talk.phase == .speaking }
        XCTAssertEqual(voice.spoken, ["Short: The build pa"])
        talk.stop()
    }
}
