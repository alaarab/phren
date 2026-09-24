import XCTest
@testable import PhrenKit

final class AccountUsageMemoryCacheTests: XCTestCase {
    func testTTLRetainsLastReportAndIsolatesConnections() throws {
        let host = try LiveHost(name: "Mac", address: "mac.invalid", username: "test")
        let other = try LiveHost(name: "Other", address: "other.invalid", username: "test")
        let value = try AccountUsageSnapshot.read(Data(#"{"accounts":[]}"#.utf8)), now = Date.now
        var cache = AccountUsageMemoryCache()
        XCTAssertTrue(cache.needsRefresh(host, at: now))
        cache.insert(value, for: host, at: now)
        XCTAssertFalse(cache.needsRefresh(host, at: now.addingTimeInterval(59.9)))
        XCTAssertTrue(cache.needsRefresh(host, at: now.addingTimeInterval(60)))
        XCTAssertEqual(cache.snapshot(for: host), value, "Expired data remains available while a background refresh runs")
        XCTAssertNil(cache.snapshot(for: other))
        var changed = host; changed.herdrSession = "other"
        XCTAssertNil(cache.snapshot(for: changed))
        XCTAssertTrue(cache.needsRefresh(changed, at: now))
        XCTAssertTrue(cache.needsRefresh(host, at: now.addingTimeInterval(-1)), "Clock rollback must not extend TTL")
    }

    func testRecentSessionsOrderAcrossComputersWithUnknownDatesLast() throws {
        let first = try LiveHost(name: "A", address: "a.invalid", username: "test")
        let second = try LiveHost(name: "Z", address: "z.invalid", username: "test")
        func session(_ host: LiveHost, _ stamp: String) throws -> LiveAgentSession {
            try LiveWorkspaces.read(Data("""
            {"kind":"herdr","groups":[{"id":"w","label":"Work","children":[{"id":"t","label":"Build","lastChangedAt":\(stamp)}]}]}
            """.utf8)).sessions(on: host)[0]
        }
        let older = try session(first, "\"2026-09-15T10:00:00Z\""), newer = try session(second, "\"2026-09-15T11:00:00Z\"")
        XCTAssertEqual(SessionRecency.ordered([older, newer]).map(\.host.id), [second.id, first.id])
        XCTAssertEqual(SessionRecency.ordered([try session(first, "null"), newer]).first?.host.id, second.id)
    }

    func testMissingCountersDoNotDestabilizeRecentOrdering() throws {
        let host = try LiveHost(name: "Mac", address: "mac.invalid", username: "test")
        let workspaces = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w","label":"Work","children":[{"id":"a","label":"Unknown"},{"id":"b","label":"Older","changedSeq":1},{"id":"c","label":"Newer","changedSeq":2}]}]}"#.utf8))
        let sessions = workspaces.sessions(on: host)
        for input in [sessions, Array(sessions.reversed()), [sessions[1], sessions[0], sessions[2]]] {
            XCTAssertEqual(SessionRecency.ordered(input).map(\.tab.id), ["c", "b", "a"])
        }
    }
}
