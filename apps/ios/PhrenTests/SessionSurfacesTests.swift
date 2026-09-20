import Foundation
import PhrenKit
import XCTest
@testable import Phren

final class SessionSurfacesTests: XCTestCase {
    func testUnmappedSessionUsesCwdFolderInsteadOfWorkspaceLabel() throws {
        let sessions = try sessions([["id": "t", "label": "Agent", "cwd": "/home/sam/Projects/phren", "agent": "codex"]])
        XCTAssertEqual(sessions[0].folderName, "phren")
        XCTAssertEqual(sessions[0].projectDisplayName(nil), "phren")
        XCTAssertTrue(sessions[0].usesFolderFallback(mappedProject: nil))
        XCTAssertEqual(sessions[0].projectDisplayName("iOS App"), "iOS App")
        XCTAssertFalse(sessions[0].usesFolderFallback(mappedProject: "iOS App"))
    }
    private func sessions(_ children: [[String: Any]]) throws -> [LiveAgentSession] {
        let host = try LiveHost(name: "Desk", address: "mini.fixture.invalid", username: "fixture")
        let data = try JSONSerialization.data(withJSONObject: [
            "kind": "herdr", "groups": [["id": "w1", "label": "phren", "children": children]],
        ])
        return try LiveWorkspaces.read(data).sessions(on: host)
    }

    private func child(_ id: String, status: String, changed: Int, approval: Bool = false) -> [String: Any] {
        ["id": "w1:\(id)", "label": id, "title": id, "agent": "codex",
         "agentStatus": status, "approvalPending": approval, "changedSeq": changed,
         "cwd": "/work/\(id)"]
    }

    func testAttentionSelectionPrefersApprovalThenWaitingThenRecentWorking() throws {
        let values = try sessions([
            child("working-new", status: "working", changed: 50),
            child("waiting-new", status: "waiting", changed: 40),
            child("approval-old", status: "waiting", changed: 1, approval: true),
            child("idle", status: "idle", changed: 100),
        ])
        XCTAssertEqual(SessionAttentionSelector.select(values)?.tab.label, "approval-old")

        let noApproval = values.filter { $0.tab.label != "approval-old" }
        XCTAssertEqual(SessionAttentionSelector.select(noApproval)?.tab.label, "waiting-new")

        let working = values.filter { $0.tab.activity == .working }
            + (try sessions([child("working-old", status: "working", changed: 2)]))
        XCTAssertEqual(SessionAttentionSelector.select(working)?.tab.label, "working-new")
        XCTAssertNil(SessionAttentionSelector.select(values.filter { $0.tab.activity == .idle }))
    }

    func testAggregateActivityCountsOldestStartAndRowCap() {
        let now = Date(timeIntervalSince1970: 1000)
        let sessions = (0..<7).map { index in
            SessionWorkingActivityBuilder.Session(
                entry: .init(id: "s\(index)", project: "p\(index)", provider: "codex", tool: "Read", computer: "Desk"),
                state: index < 5 ? "working" : "waiting", startedAt: now.addingTimeInterval(Double(index * -10)))
        }
        let state = SessionWorkingActivityBuilder.build(sessions + [sessions[0]], pinnedID: "s6", now: now)
        XCTAssertEqual(state.working, 5)
        XCTAssertEqual(state.waiting, 2)
        XCTAssertEqual(state.entries.count, 5)
        XCTAssertEqual(state.more, 2)
        XCTAssertEqual(state.entries.first?.id, "s6")
        XCTAssertEqual(state.startedAt, now.addingTimeInterval(-40))
        XCTAssertEqual(SessionWorkingActivityBuilder.build([], now: now).working, 0)
    }

    func testRunningAgentsAcrossComputersListWaitingFirst() {
        let now = Date(timeIntervalSince1970: 1000)
        func session(_ id: String, state: String, computer: String, started: TimeInterval) -> SessionWorkingActivityBuilder.Session {
            .init(entry: .init(id: id, project: id, provider: "codex", tool: nil, computer: computer),
                  state: state, startedAt: now.addingTimeInterval(started))
        }
        let state = SessionWorkingActivityBuilder.build([
            session("working-old", state: "working", computer: "Desk", started: -30),
            session("waiting", state: "waiting", computer: "Linuxbox", started: -10),
            session("working-new", state: "working", computer: "Desk", started: -20),
        ], now: now)
        XCTAssertEqual(state.entries.map(\.id), ["waiting", "working-old", "working-new"])
        XCTAssertEqual(state.computers, 2)
        XCTAssertEqual(state.more, 0)
    }

    func testSevenAgentsProduceFiveRowsAndCountTheRest() {
        let now = Date(timeIntervalSince1970: 1000)
        let sessions = (0..<7).map { index in
            SessionWorkingActivityBuilder.Session(
                entry: .init(id: "s\(index)", project: "p\(index)", provider: "claude", tool: nil, computer: "Desk"),
                state: "working", startedAt: now.addingTimeInterval(Double(-index)))
        }
        let state = SessionWorkingActivityBuilder.build(sessions, now: now)
        XCTAssertEqual(state.entries.count, 5)
        XCTAssertEqual(state.more, 2)
    }

    func testUnchangedSnapshotsDoNotProduceNewActivityContent() {
        let start = Date(timeIntervalSince1970: 1000)
        let working = SessionWorkingActivityBuilder.Session(entry: .init(id: "one", project: "App", provider: "claude", tool: nil, computer: "Desk"), state: "working", startedAt: start)
        let waiting = SessionWorkingActivityBuilder.Session(entry: .init(id: "two", project: "CLI", provider: "codex", tool: nil, computer: "Linuxbox"), state: "waiting", startedAt: start)
        XCTAssertEqual(SessionWorkingActivityBuilder.build([working, waiting], now: start),
                       SessionWorkingActivityBuilder.build([waiting, working], now: start.addingTimeInterval(2)))
        XCTAssertEqual(SessionWorkingActivityPolicy.updateInterval, 2)
    }

    func testLegacyActivityCanBeReconciledAfterUpgrade() throws {
        let content = try JSONDecoder().decode(SessionWorkingActivityAttributes.ContentState.self,
            from: Data(#"{"provider":"codex","project":"old","state":"Working","startedAt":1000,"expiresAt":8200}"#.utf8))
        XCTAssertEqual(content.working, 1)
        XCTAssertTrue(content.entries.isEmpty)
    }

    func testEntryFromBeforeStepAndSubagentsStillDecodes() throws {
        let content = try JSONDecoder().decode(SessionWorkingActivityAttributes.ContentState.self,
            from: Data(#"{"working":1,"waiting":0,"startedAt":1000,"entries":[{"id":"s1","project":"App","provider":"codex","computer":"Desk"}]}"#.utf8))
        XCTAssertNil(content.entries.first?.step)
        XCTAssertEqual(content.entries.first?.subagents, 0)
        XCTAssertNil(content.entries.first?.state)
        XCTAssertEqual(content.primary?.project, "App")
    }

    func testActivityQuietGraceOnlyEndsAfterThirtySecondsWithNoWorkingAgents() {
        let start = Date(timeIntervalSince1970: 1000)
        XCTAssertFalse(SessionWorkingActivityPolicy.shouldEnd(working: 0, quietSince: start, now: start.addingTimeInterval(29)))
        XCTAssertTrue(SessionWorkingActivityPolicy.shouldEnd(working: 0, quietSince: start, now: start.addingTimeInterval(30)))
        XCTAssertFalse(SessionWorkingActivityPolicy.shouldEnd(working: 1, quietSince: start, now: start.addingTimeInterval(31)))
        XCTAssertFalse(SessionWorkingActivityPolicy.shouldEnd(working: 0, quietSince: nil, now: start))
    }
}
