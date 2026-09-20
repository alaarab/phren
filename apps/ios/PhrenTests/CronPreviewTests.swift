import XCTest
@testable import Phren

final class CronPreviewTests: XCTestCase {
    func testWeekdayCron() throws {
        let runs = try XCTUnwrap(CronPreview.next("0 7 * * 1-5", count: 3, from: date(2026, 9, 20, 6, 0), calendar: calendar))
        XCTAssertEqual(runs, [
            date(2026, 9, 21, 7, 0),
            date(2026, 9, 22, 7, 0),
            date(2026, 9, 23, 7, 0),
        ])
    }

    func testQuarterHourCron() throws {
        let runs = try XCTUnwrap(CronPreview.next("*/15 * * * *", count: 3, from: date(2026, 9, 20, 10, 7), calendar: calendar))
        XCTAssertEqual(runs, [
            date(2026, 9, 20, 10, 15),
            date(2026, 9, 20, 10, 30),
            date(2026, 9, 20, 10, 45),
        ])
    }

    func testFirstDayOfMonthCron() throws {
        let runs = try XCTUnwrap(CronPreview.next("0 0 1 * *", count: 3, from: date(2026, 9, 20, 10, 7), calendar: calendar))
        XCTAssertEqual(runs, [
            date(2026, 10, 1, 0, 0),
            date(2026, 11, 1, 0, 0),
            date(2026, 12, 1, 0, 0),
        ])
    }

    func testInvalidCronLine() {
        XCTAssertNil(CronPreview.next("0 7 * *", count: 3, from: date(2026, 9, 20, 6, 0), calendar: calendar))
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }
}
