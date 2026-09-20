import XCTest
@testable import PhrenKit

final class SessionElapsedTimeTests: XCTestCase {
    func testElapsedTimeFormatting() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(SessionElapsedTime.format(from: start, to: start.addingTimeInterval(5)), "0:05")
        XCTAssertEqual(SessionElapsedTime.format(from: start, to: start.addingTimeInterval(125)), "2:05")
        XCTAssertEqual(SessionElapsedTime.format(from: start, to: start.addingTimeInterval(3_723)), "1:02:03")
        XCTAssertEqual(SessionElapsedTime.format(from: start, to: start.addingTimeInterval(-4)), "0:00")
    }
}