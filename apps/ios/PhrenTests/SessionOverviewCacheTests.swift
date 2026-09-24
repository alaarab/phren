import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class SessionOverviewCacheTests: XCTestCase {
    func testForgetPurgesDiskAndRejectsInFlightSavesForThatComputer() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = SessionOverviewDiskCache(directory: directory)
        let host = try LiveHost(name: "Private Mac", address: "test.invalid", username: "test")
        let record = SessionOverviewDiskCache.Record(savedAt: .now, hosts: [.init(host: host, snapshot: nil, lastUpdated: nil)],
            screen: .init(groups: [], computers: [], projects: [:], pinned: []), preferences: nil)
        await cache.save(record)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        let attributes = try FileManager.default.attributesOfItem(atPath: XCTUnwrap(files.first).path)
        #if !targetEnvironment(simulator)
        XCTAssertEqual(attributes[.protectionKey] as? String, FileProtectionType.complete.rawValue)
        #endif
        try await cache.purge(forgetting: host.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        await cache.save(record, force: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path), "A queued save must not recreate forgotten data")
        let loaded = await cache.load(hosts: [host], preferences: nil, focusFilter: nil)
        XCTAssertNil(loaded)
    }

    func testDiskRoundTripRestoresTheWholeScreenAndAnOlderOneAsStale() async throws {
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
        let restored = await reader.load(hosts: [host], preferences: nil, focusFilter: nil, now: now.addingTimeInterval(59))
        XCTAssertEqual(restored?.screen, screen)
        XCTAssertEqual(restored?.hosts.first?.snapshot, snapshot)
        // Older than a minute: the last known list, but nothing reads as live.
        let older = await reader.load(hosts: [host], preferences: nil, focusFilter: nil, now: now.addingTimeInterval(600))
        XCTAssertEqual(older?.screen.groups.first?.sessions, [session])
        XCTAssertEqual(older?.screen.groups.first?.fresh, false)
        XCTAssertEqual(older?.screen.computers.first?.fresh, false)
        XCTAssertEqual(older?.screen.computers.first?.connecting, true)
        let expired = await reader.load(hosts: [host], preferences: nil, focusFilter: nil,
                                        now: now.addingTimeInterval(SessionOverviewDiskCache.lastKnownAge))
        XCTAssertNil(expired)
        var changed = host; changed.herdrSession = "other"
        let wrongHost = await reader.load(hosts: [changed], preferences: nil, focusFilter: nil, now: now)
        XCTAssertNil(wrongHost)

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
