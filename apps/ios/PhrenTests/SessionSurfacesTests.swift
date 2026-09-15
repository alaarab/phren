import Foundation
import PhrenKit
import XCTest
@testable import Phren

final class SessionSurfacesTests: XCTestCase {
    private func sessions(_ children: [[String: Any]]) throws -> [LiveAgentSession] {
        let host = try LiveHost(name: "Mini", address: "mini.fixture.invalid", username: "fixture")
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

    func testWorkingActivityStartsUpdatesStopsAndTimesOut() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(SessionWorkingActivityPolicy.action(
            trackedSessionID: nil, incomingSessionID: "one", activity: "working",
            optedIn: true, startedAt: nil, now: start), .start)
        XCTAssertEqual(SessionWorkingActivityPolicy.action(
            trackedSessionID: nil, incomingSessionID: "one", activity: "working",
            optedIn: false, startedAt: nil, now: start), .none)
        XCTAssertEqual(SessionWorkingActivityPolicy.action(
            trackedSessionID: "one", incomingSessionID: "one", activity: "working",
            optedIn: false, startedAt: start, now: start.addingTimeInterval(30)), .update)
        for stopped in ["waiting", "done", "idle"] {
            XCTAssertEqual(SessionWorkingActivityPolicy.action(
                trackedSessionID: "one", incomingSessionID: "one", activity: stopped,
                optedIn: false, startedAt: start, now: start.addingTimeInterval(30)), .end)
        }
        XCTAssertEqual(SessionWorkingActivityPolicy.action(
            trackedSessionID: "one", incomingSessionID: "two", activity: "working",
            optedIn: true, startedAt: start, now: start.addingTimeInterval(30)), .start)
        XCTAssertEqual(SessionWorkingActivityPolicy.action(
            trackedSessionID: "one", incomingSessionID: "one", activity: "working",
            optedIn: false, startedAt: start,
            now: start.addingTimeInterval(SessionWorkingActivityPolicy.maximumDuration)), .end)
    }

    func testElapsedTimeFormatting() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(SessionElapsedTime.format(from: start, to: start.addingTimeInterval(5)), "0:05")
        XCTAssertEqual(SessionElapsedTime.format(from: start, to: start.addingTimeInterval(125)), "2:05")
        XCTAssertEqual(SessionElapsedTime.format(from: start, to: start.addingTimeInterval(3_723)), "1:02:03")
        XCTAssertEqual(SessionElapsedTime.format(from: start, to: start.addingTimeInterval(-4)), "0:00")
    }
}
