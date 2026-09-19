import XCTest
@testable import Phren

@MainActor
final class TerminalResizeTests: XCTestCase {
    func testAttachingUsesLatestBoundsAndInFlightUpdatesAreCoalescedInOrder() async throws {
        let resize = TerminalResizeCoordinator()
        var sent: [TerminalResizeCoordinator.Size] = []
        var release = false
        resize.update(columns: 80, rows: 24)
        resize.update(columns: 55, rows: 32)
        resize.attach { size in
            sent.append(size)
            while !release { try await Task.sleep(for: .milliseconds(1)) }
        }
        for _ in 0..<100 where sent.isEmpty { try await Task.sleep(for: .milliseconds(1)) }
        XCTAssertEqual(sent, [.init(columns: 55, rows: 32)])
        resize.update(columns: 110, rows: 20)
        resize.update(columns: 120, rows: 18)
        XCTAssertEqual(sent.count, 1, "No concurrent resize may race an earlier one")
        release = true
        for _ in 0..<600 where sent.count < 2 { try await Task.sleep(for: .milliseconds(1)) }
        XCTAssertEqual(sent, [.init(columns: 55, rows: 32), .init(columns: 120, rows: 18)])
        resize.detach()
        resize.update(columns: 0, rows: 0)
        resize.attach { sent.append($0) }
        for _ in 0..<600 where sent.count < 3 { try await Task.sleep(for: .milliseconds(1)) }
        XCTAssertEqual(sent.last, .init(columns: 120, rows: 18), "Reconnect resends the valid viewport")
        resize.detach()
    }
}
