import XCTest
@testable import PhrenKit

final class AgentWorkHistoryTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func worker(_ id: String, state: String, age: TimeInterval? = nil, children: [AgentChild] = []) throws -> AgentChild {
        var value: [String: Any] = ["id": id, "provider": "codex", "path": id, "callId": id, "state": state,
                                    "children": try JSONSerialization.jsonObject(with: JSONEncoder().encode(children))]
        if let age { value["finishedAt"] = now.addingTimeInterval(-age).formatted(.iso8601) }
        if state == "failed" { value["state"] = "completed"; value["failed"] = true }
        return try JSONDecoder().decode(AgentChild.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func testRunningFirstOnlyRecentFailuresAndPersistentDismissal() throws {
        let recent = try worker("recent", state: "failed", age: 120)
        let running = try worker("running", state: "running")
        let old = try worker("old", state: "failed", age: 3_600, children: [running])
        let done = try worker("done", state: "completed", age: 10)
        var history = AgentWorkHistory()
        let agents = [recent, old, done]
        history.observe(agents, scope: "session", now: now)
        XCTAssertEqual(history.rows(agents, scope: "session", now: now).map(\.agent.id), ["running", "recent"])
        XCTAssertEqual(history.rows(agents, scope: "session", now: now).map(\.depth), [0, 0])
        XCTAssertEqual(history.age(recent, scope: "session", now: now), "2m ago")
        XCTAssertEqual(history.age(old, scope: "session", now: now.addingTimeInterval(3_600)), "2h ago")
        history.dismissed.insert("session/" + recent.navigationID)
        let restored = try JSONDecoder().decode(AgentWorkHistory.self, from: JSONEncoder().encode(history))
        XCTAssertEqual(restored.rows(agents, scope: "session", now: now).map(\.agent.id), ["running"])
        XCTAssertEqual(restored.rows(agents, scope: "another", now: now).map(\.agent.id), ["running", "recent"])
    }

    func testRunningDescendantsArePromotedAboveARecentFailedParent() throws {
        let child = try worker("child", state: "running")
        let parent = try worker("parent", state: "failed", age: 60, children: [child])
        let rows = AgentWorkHistory().rows([parent], scope: "session", now: now)
        XCTAssertEqual(rows.map(\.agent.id), ["child", "parent"])
        XCTAssertEqual(rows.map(\.depth), [0, 0])
    }

    func testOlderHooksUsePersistedFirstSeenInsteadOfResettingAgeOnRefresh() throws {
        let failure = try worker("legacy", state: "failed")
        var history = AgentWorkHistory()
        history.observe([failure], scope: "session", now: now)
        history.observe([failure], scope: "session", now: now.addingTimeInterval(3_600))
        XCTAssertTrue(history.rows([failure], scope: "session", now: now.addingTimeInterval(3_600)).isEmpty)
    }
}
