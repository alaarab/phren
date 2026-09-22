import XCTest
import PhrenKit
import PhrenLive
@testable import Phren

@MainActor
final class LiveSessionsModelTests: XCTestCase {
    private func host(_ name: String) throws -> LiveHost {
        try LiveHost(name: name, address: name.lowercased() + ".invalid", username: "fixture")
    }

    /// The derived list is the host-to-monitor index: a second of freshness
    /// ticks must not rescan the computer list for every row.
    func testMonitorIndexResolvesOncePerComputerSet() throws {
        var index = LiveSessionsModel.MonitorIndex()
        let first = SessionOverviewMonitor.Computer(host: try host("Mac"), monitor: LiveHostMonitor())
        let second = SessionOverviewMonitor.Computer(host: try host("Linux"), monitor: LiveHostMonitor())

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
}
