import XCTest
import PhrenKit
import PhrenLive
@testable import Phren

@MainActor
final class LiveSessionsModelTests: XCTestCase {
    private func host(_ name: String) throws -> LiveHost {
        try LiveHost(name: name, address: name.lowercased() + ".invalid", username: "sam")
    }

    /// The derived list is the host-to-monitor index: a second of freshness
    /// ticks must not rescan the computer list for every row.
    func testMonitorIndexResolvesOncePerComputerSet() throws {
        var index = LiveSessionsModel.MonitorIndex()
        let first = SessionOverviewMonitor.Computer(host: try host("Desk"), monitor: LiveHostMonitor())
        let second = SessionOverviewMonitor.Computer(host: try host("Linuxbox"), monitor: LiveHostMonitor())

        let resolved = index.resolve([first, second])
        XCTAssertEqual(index.computations, 1)
        XCTAssertTrue(resolved[first.id] === first.monitor)
        XCTAssertTrue(resolved[second.id] === second.monitor)

        _ = index.resolve([first, second])
        XCTAssertEqual(index.computations, 1, "The same computers must reuse the index")
        _ = index.resolve([second, first])
        XCTAssertEqual(index.computations, 1, "An order-only change must reuse the index")

        _ = index.resolve([first])
        XCTAssertEqual(index.computations, 2, "A different computer set rebuilds the index")
        XCTAssertNil(index.byHost[second.id])
    }

    func testSetupActionsFollowMemoryConnectionWithoutChangingSessionSearchOrComputers() throws {
        let model = LiveSessionsModel(overview: SessionOverviewMonitor())
        let computer = try host("Desk")
        let preferences = try LiveSessionPreferences.read(LiveSessionPreferences.saving(computer, in: Data()))
        model.setQuery("phone")
        model.update(preferences: preferences, projects: [], metadataReady: true, memoryConnected: false)
        XCTAssertEqual(model.setupActions, [.connectMemory])
        XCTAssertEqual(model.hosts.map(\.id), [computer.id])
        XCTAssertEqual(model.configuration.query, "phone")

        model.update(preferences: preferences, projects: [], metadataReady: true, memoryConnected: true)
        XCTAssertEqual(model.setupActions, [.skills, .instructions])
        XCTAssertEqual(model.hosts.map(\.id), [computer.id])
        XCTAssertEqual(model.configuration.query, "phone")

        model.update(preferences: preferences, projects: [], metadataReady: true, memoryConnected: false)
        XCTAssertEqual(model.setupActions, [.connectMemory], "Disconnecting must remove destinations that require memory")
    }

}
