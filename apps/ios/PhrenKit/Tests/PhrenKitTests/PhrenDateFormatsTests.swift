import XCTest
@testable import PhrenKit

final class PhrenDateFormatsTests: XCTestCase {
    private let instant = Date(timeIntervalSince1970: 1_789_992_000.456) // 2026-09-21T12:00:00.456Z

    func testISOStringRoundTripsWithAndWithoutFractionalSeconds() throws {
        XCTAssertEqual(ISO8601Dates.string(from: instant, fractionalSeconds: true), "2026-09-21T12:00:00.456Z")
        XCTAssertEqual(ISO8601Dates.string(from: instant), "2026-09-21T12:00:00Z")
        let fractional = try XCTUnwrap(ISO8601Dates.parse(ISO8601Dates.string(from: instant, fractionalSeconds: true)))
        XCTAssertEqual(fractional.timeIntervalSince1970, instant.timeIntervalSince1970, accuracy: 0.001)
        let whole = try XCTUnwrap(ISO8601Dates.parse(ISO8601Dates.string(from: instant)))
        XCTAssertEqual(whole.timeIntervalSince1970, 1_789_992_000)
    }

    func testFixedFormatterIsCachedPerFormatAndZone() {
        let first = PhrenDateFormats.utc("yyyy-MM-dd")
        XCTAssertTrue(first === PhrenDateFormats.utc("yyyy-MM-dd"), "One formatter per format and zone")
        XCTAssertFalse(first === PhrenDateFormats.utc("yyyyMMdd'T'HHmmss'Z'"))
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        XCTAssertFalse(first === PhrenDateFormats.fixed("yyyy-MM-dd", timeZone: tokyo))
        XCTAssertEqual(first.locale.identifier, "en_US_POSIX")
    }

    func testFixedFormatterOutputInUTCAndLocalZones() {
        XCTAssertEqual(PhrenDateFormats.utc("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").string(from: instant), "2026-09-21T12:00:00.456Z")
        XCTAssertEqual(PhrenDateFormats.utc("yyyyMMdd'T'HHmmss'Z'").string(from: instant), "20260921T120000Z")
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        XCTAssertEqual(PhrenDateFormats.fixed("yyyy-MM-dd HH:mm", timeZone: tokyo).string(from: instant), "2026-09-21 21:00")
        let local = PhrenDateFormats.fixed("HH:mm")
        XCTAssertEqual(local.timeZone, TimeZone.current)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = calendar.dateComponents([.hour, .minute], from: instant)
        XCTAssertEqual(local.string(from: instant), String(format: "%02d:%02d", parts.hour!, parts.minute!))
        XCTAssertEqual(PhrenDateFormats.utc("yyyy-MM-dd").date(from: "2026-09-21"),
                       Date(timeIntervalSince1970: 1_789_948_800))
        XCTAssertNil(PhrenDateFormats.utc("yyyy-MM-dd").date(from: "2026-13-40"), "Strict parsing")
    }
}
