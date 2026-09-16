import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class DictateToSessionIntentTests: XCTestCase {
    private func sessions(_ tabs: [(id: String, status: String, changed: String?)]) throws -> [LiveAgentSession] {
        let host = try LiveHost(name: "Mini", address: "mini.fixture.invalid", username: "fixture")
        let children: [[String: Any]] = tabs.map { tab in
            var child: [String: Any] = ["id": tab.id, "label": "1", "title": "Tab \(tab.id)", "agent": "codex", "agentStatus": tab.status, "cwd": "/work/phren"]
            if let changed = tab.changed { child["lastChangedAt"] = changed }
            return child
        }
        let data = try JSONSerialization.data(withJSONObject: ["kind": "herdr", "groups": [["id": "w1", "label": "Workspace", "children": children]]])
        return try LiveWorkspaces.read(data).sessions(on: host)
    }

    func testMostRecentlyChangedSessionIsTheDefault() throws {
        let live = try sessions([("w1:t1", "idle", "2026-09-15T10:00:00Z"), ("w1:t2", "working", "2026-09-15T12:00:00Z"), ("w1:t3", "idle", "2026-09-15T11:00:00Z")])
        XCTAssertEqual(DictateToSessionIntent.lastUsed(live)?.tab.id, "w1:t2")
    }

    func testASessionWaitingOnYouOutranksRecency() throws {
        let live = try sessions([("w1:t1", "blocked", "2026-09-15T10:00:00Z"), ("w1:t2", "working", "2026-09-15T12:00:00Z")])
        XCTAssertEqual(DictateToSessionIntent.lastUsed(live)?.tab.id, "w1:t1")
        XCTAssertNil(DictateToSessionIntent.lastUsed([]))
    }
}
