import Foundation
import XCTest
@testable import PhrenKit

final class LocalNotificationPolicyTests: XCTestCase {
    private func date(_ text: String) -> Date { ISO8601Dates.parse(text)! }
    private func calendar(_ zone: String = "UTC") -> Calendar {
        var value = Calendar(identifier: .gregorian); value.timeZone = TimeZone(identifier: zone)!; return value
    }
    private func schedule(_ every: Schedule.Every, created: String = "2026-09-21T10:00:00Z") -> Schedule {
        Schedule(id: "1234abcd", name: "Check", enabled: true, computer: "Desk", harness: .codex,
                 every: every, prompt: "Check tests", createdAt: date(created), updatedAt: date(created))
    }

    func testAllFiveTimingFormsFeedFutureReminders() {
        let cases: [(Schedule.Every, String)] = [
            (.interval(minutes: 30), "2026-09-21T10:30:00Z"),
            (.daily(hour: 11, minute: 15), "2026-09-21T11:15:00Z"),
            (.weekly(days: [.tue, .fri], hour: 9, minute: 0), "2026-09-22T09:00:00Z"),
            (.once(date("2026-09-23T12:00:00Z")), "2026-09-23T12:00:00Z"),
            (.cron("*/20 * * * *"), "2026-09-21T10:20:00Z"),
        ]
        for (every, expected) in cases {
            let next = ScheduleNextRun.next(schedule(every), lastStartedAt: nil,
                                            computerCalendar: calendar(), wallCalendar: calendar())
            XCTAssertEqual(next, date(expected), every.kind)
            XCTAssertEqual(ScheduleNextRun.reminderDate(next, enabled: true, running: false,
                now: date("2026-09-21T10:01:00Z")), date(expected))
        }
    }

    func testIntervalAnchorsToActualLaunchAndOnceNeverRepeats() {
        XCTAssertEqual(ScheduleNextRun.next(schedule(.interval(minutes: 30)),
            lastStartedAt: date("2026-09-22T10:07:00Z"), computerCalendar: calendar()), date("2026-09-22T10:37:00Z"))
        XCTAssertNil(ScheduleNextRun.next(schedule(.once(date("2026-09-23T12:00:00Z"))),
            lastStartedAt: date("2026-09-23T12:00:00Z"), computerCalendar: calendar()))
    }

    func testComputerTimeZoneAndFloatingOnceDifferFromPhone() {
        let computer = calendar("America/Los_Angeles")
        XCTAssertEqual(ScheduleNextRun.next(schedule(.daily(hour: 9, minute: 0)), lastStartedAt: nil,
            computerCalendar: computer), date("2026-09-21T16:00:00Z"))
        XCTAssertEqual(ScheduleNextRun.next(schedule(.once(date("2026-09-23T09:00:00Z"))), lastStartedAt: nil,
            computerCalendar: computer, wallCalendar: calendar()), date("2026-09-23T16:00:00Z"))
    }

    func testDSTSkipsNonexistentDailyAndCronTimes() {
        let computer = calendar("America/Los_Angeles")
        for every: Schedule.Every in [.daily(hour: 2, minute: 30), .cron("30 2 * * *")] {
            XCTAssertEqual(ScheduleNextRun.next(schedule(every, created: "2026-03-07T11:00:00Z"),
                lastStartedAt: nil, computerCalendar: computer), date("2026-03-09T09:30:00Z"))
        }
        XCTAssertNil(ScheduleNextRun.next(schedule(.once(date("2026-03-08T02:30:00Z"))),
            lastStartedAt: nil, computerCalendar: computer, wallCalendar: calendar()))
    }

    func testCronDayOrWeekdayAndDisabledOverdueRunningGuards() {
        XCTAssertEqual(ScheduleNextRun.next(schedule(.cron("0 9 1 * 2")), lastStartedAt: nil,
            computerCalendar: calendar()), date("2026-09-22T09:00:00Z"))
        var paused = schedule(.interval(minutes: 10)); paused.enabled = false
        XCTAssertNil(ScheduleNextRun.next(paused, lastStartedAt: nil, computerCalendar: calendar()))
        let now = date("2026-09-22T09:00:00Z")
        XCTAssertNil(ScheduleNextRun.reminderDate(now, enabled: true, running: false, now: now))
        XCTAssertNil(ScheduleNextRun.reminderDate(now.addingTimeInterval(60), enabled: false, running: false, now: now))
        XCTAssertNil(ScheduleNextRun.reminderDate(now.addingTimeInterval(60), enabled: true, running: true, now: now))
        XCTAssertNil(ScheduleNextRun.next(schedule(.cron("bad")), lastStartedAt: nil, computerCalendar: calendar()))
    }

    func testApprovalIDIsClaimedOnceAcrossReloadsAndExpiry() throws {
        var ledger = ApprovalNotificationLedger()
        let now = date("2026-09-21T10:00:00Z"), expiry = now.addingTimeInterval(60)
        XCTAssertTrue(ledger.claim("first", expiresAt: expiry, now: now))
        XCTAssertFalse(ledger.claim("first", expiresAt: expiry, now: now))
        ledger = try JSONDecoder().decode(ApprovalNotificationLedger.self, from: JSONEncoder().encode(ledger))
        XCTAssertFalse(ledger.claim("first", expiresAt: expiry.addingTimeInterval(600), now: expiry))
        XCTAssertTrue(ledger.claim("second", expiresAt: expiry, now: now))
        XCTAssertFalse(ledger.claim("expired", expiresAt: now, now: now))
        XCTAssertFalse(ledger.claim("", expiresAt: expiry, now: now))
    }
}
