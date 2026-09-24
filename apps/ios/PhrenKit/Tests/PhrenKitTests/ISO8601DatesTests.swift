import XCTest
@testable import PhrenKit

final class ISO8601DatesTests: XCTestCase {
    func testParsesEveryShapeTheCLIWrites() throws {
        let whole = try XCTUnwrap(ISO8601Dates.parse("2026-09-10T12:00:00Z"))
        XCTAssertEqual(whole, Date(timeIntervalSince1970: 1_789_041_600))
        XCTAssertEqual(ISO8601Dates.parse("2026-09-10T13:00:00+01:00"), whole)
        XCTAssertEqual(try XCTUnwrap(ISO8601Dates.parse("2026-09-10T12:00:00.123Z")).timeIntervalSince(whole), 0.123, accuracy: 0.001)
        XCTAssertEqual(ISO8601Dates.parse("2026-09-10"), Date(timeIntervalSince1970: 1_788_998_400))
    }

    func testRejectsEverythingElse() {
        XCTAssertNil(ISO8601Dates.parse(nil))
        XCTAssertNil(ISO8601Dates.parse(""))
        XCTAssertNil(ISO8601Dates.parse("not a date"))
        XCTAssertNil(ISO8601Dates.parse("2026-09-10T"))
        XCTAssertNil(ISO8601Dates.parse("20260910"))
    }
}
