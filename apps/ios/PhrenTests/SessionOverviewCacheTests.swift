import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class SessionOverviewCacheTests: XCTestCase {
    func testDiskRoundTripRestoresTheWholeScreenAndExpiresAtSixtySeconds() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = SessionOverviewDiskCache(directory: directory)
        let host = try LiveHost(name: "Mac", address: "test.invalid", username: "test")
        let snapshot = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w","label":"Workspace","children":[{"id":"t","label":"Build","agent":"codex","agentStatus":"working","lastChangedAt":"2026-09-15T10:00:00.123Z","contextUsedPercent":37}]}]}"#.utf8))
        let session = snapshot.sessions(on: host)[0], now = Date.now
        let screen = SessionOverviewMonitor.Screen(groups: [.init(id: "working", title: "Working", sessions: [session], fresh: true)],
            computers: [.init(host: host, connecting: false, fresh: true, message: nil, needsVerification: false)],
            projects: [session.id: "Project"], pinned: [session.id])
        await cache.save(.init(savedAt: now, hosts: [.init(host: host, snapshot: snapshot, lastUpdated: now)], screen: screen, preferences: nil))
        // A separate instance exercises disk decoding, not an in-memory hit.
        let reader = SessionOverviewDiskCache(directory: directory)
        let restored = await reader.load(hosts: [host], preferences: nil, query: "", focusFilter: nil, now: now.addingTimeInterval(59))
        XCTAssertEqual(restored?.screen, screen)
        XCTAssertEqual(restored?.hosts.first?.snapshot, snapshot)
        let expired = await reader.load(hosts: [host], preferences: nil, query: "", focusFilter: nil, now: now.addingTimeInterval(60))
        XCTAssertNil(expired)
        var changed = host; changed.herdrSession = "other"
        let wrongHost = await reader.load(hosts: [changed], preferences: nil, query: "", focusFilter: nil, now: now)
        let wrongQuery = await reader.load(hosts: [host], preferences: nil, query: "different", focusFilter: nil, now: now)
        XCTAssertNil(wrongHost); XCTAssertNil(wrongQuery)

        let model = SessionOverviewMonitor(diskCache: reader) {
            LiveHostMonitor { _, _ in try await Task.sleep(for: .seconds(30)); return snapshot }
        }
        let run = Task { await model.run(hosts: [host]) }
        for _ in 0..<100 where !model.ready { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(model.ready, "Cache is visible before any host answers")
        XCTAssertEqual(model.screen, screen)
        XCTAssertEqual(model.computers.first?.monitor.snapshot, snapshot, "The drawer reads the same restored host snapshot")
        run.cancel(); await run.value
    }

    func testFreshnessSurvivesPollingStoppingAndExpiresOnlyAfterGrace() {
        let monitor = LiveHostMonitor(), now = Date.now
        monitor.lastUpdated = now
        monitor.polling = false
        monitor.message = "Connection interrupted"
        XCTAssertTrue(monitor.isFresh(at: now.addingTimeInterval(89)))
        XCTAssertFalse(monitor.isFresh(at: now.addingTimeInterval(90)))
        monitor.lastUpdated = nil
        XCTAssertFalse(monitor.isFresh(at: now))
    }
}
