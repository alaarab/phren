import XCTest
import PhrenKit
@testable import Phren

final class ScheduleWordsTests: XCTestCase {
    func testDescribeEveryScheduleForm() throws {
        XCTAssertEqual(ScheduleWords.describe(schedule(.interval(minutes: 30))), "Every 30m")
        XCTAssertEqual(ScheduleWords.describe(schedule(.interval(minutes: 360))), "Every 6h")
        XCTAssertEqual(ScheduleWords.describe(schedule(.interval(minutes: 2_880))), "Every 2d")
        XCTAssertEqual(ScheduleWords.describe(schedule(.daily(hour: 7, minute: 30))), "Daily at 07:30")
        XCTAssertEqual(
            ScheduleWords.describe(schedule(.weekly(days: [.mon, .tue, .wed, .thu, .fri], hour: 7, minute: 30))),
            "Weekdays at 07:30"
        )
        XCTAssertEqual(
            ScheduleWords.describe(schedule(.weekly(days: [.sat, .sun], hour: 9, minute: 0))),
            "Weekends at 09:00"
        )
        XCTAssertEqual(
            ScheduleWords.describe(schedule(.weekly(days: [.fri, .mon, .wed], hour: 18, minute: 0))),
            "Mon, Wed, Fri at 18:00"
        )
        XCTAssertEqual(ScheduleWords.describe(schedule(.once(localDate(2026, 9, 21, 9, 0)))), "Once, Sep 21 at 09:00")
        XCTAssertEqual(ScheduleWords.describe(schedule(.cron("0 7 * * 1-5"))), "Cron 0 7 * * 1-5")
    }

    func testNextDailyRunCrossesDayBoundary() throws {
        let after = date(2026, 9, 20, 8, 0)
        let expected = date(2026, 9, 21, 7, 30)
        XCTAssertEqual(
            ScheduleWords.nextRun(schedule(.daily(hour: 7, minute: 30)), after: after, calendar: utcCalendar),
            expected
        )
    }

    func testNextWeeklyRunCrossesWeekBoundary() throws {
        let after = date(2026, 9, 21, 8, 0)
        let expected = date(2026, 9, 28, 7, 30)
        XCTAssertEqual(
            ScheduleWords.nextRun(schedule(.weekly(days: [.mon], hour: 7, minute: 30)), after: after, calendar: utcCalendar),
            expected
        )
    }

    func testRelativeWords() throws {
        var calendar = Calendar.current
        calendar.locale = Locale(identifier: "en_US_POSIX")
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 9, day: 20, hour: 10)))
        XCTAssertEqual(ScheduleWords.relative(try XCTUnwrap(calendar.date(byAdding: .hour, value: 4, to: now)), now: now), "in 4h")
        XCTAssertEqual(ScheduleWords.relative(now.addingTimeInterval(-7_200), now: now), "2h ago")

        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: now))
        let tomorrowMorning = try XCTUnwrap(calendar.date(bySettingHour: 7, minute: 30, second: 0, of: tomorrow))
        XCTAssertEqual(ScheduleWords.relative(tomorrowMorning, now: now), "tomorrow 07:30")

        let threeDays = try XCTUnwrap(calendar.date(byAdding: .day, value: 3, to: now))
        XCTAssertEqual(ScheduleWords.relative(threeDays, now: now), "in 3d")
    }

    private var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        utcCalendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    private func localDate(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    private func schedule(_ every: Schedule.Every) -> Schedule {
        Schedule(
            id: "7f3a2c1d",
            name: "Nightly test sweep",
            enabled: true,
            computer: "Desk",
            harness: .codex,
            model: "gpt-5.6-sol",
            every: every,
            prompt: "Run the full test suite.",
            createdAt: date(2026, 9, 1, 0, 0),
            updatedAt: date(2026, 9, 1, 0, 0)
        )
    }
}
