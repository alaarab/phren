import Foundation

/// Mirrors the Hook's nextRun: intervals start at the last actual launch;
/// calendar forms use the assigned computer's calendar, never the phone's.
public enum ScheduleNextRun {
    public static func next(_ schedule: Schedule, lastStartedAt: Date?, computerCalendar: Calendar,
                            wallCalendar: Calendar = .current) -> Date? {
        guard schedule.enabled else { return nil }
        let after = lastStartedAt ?? schedule.createdAt
        switch schedule.every {
        case .interval(let minutes):
            guard minutes > 0 else { return nil }
            let seconds = minutes.multipliedReportingOverflow(by: 60)
            return seconds.overflow ? nil : after.addingTimeInterval(TimeInterval(seconds.partialValue))
        case .once(let localDate):
            guard lastStartedAt == nil else { return nil }
            // Schedule's wire decoder represents floating wall time in the
            // phone's calendar. Reinterpret those components on the computer.
            let parts = wallCalendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: localDate)
            guard let candidate = computerCalendar.date(from: parts),
                  computerCalendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: candidate) == parts else { return nil }
            return candidate
        case .cron(let expression):
            return ScheduleCron.next(expression, count: 1, from: after, calendar: computerCalendar)?.first
        case .daily(let hour, let minute):
            return calendarRun(after: after, hour: hour, minute: minute, days: nil, calendar: computerCalendar)
        case .weekly(let days, let hour, let minute):
            return calendarRun(after: after, hour: hour, minute: minute, days: days, calendar: computerCalendar)
        }
    }

    /// An overdue Hook run may still be waiting for a computer to wake. Do not
    /// turn it into a misleading immediate notification or invent later runs.
    public static func reminderDate(_ nextRun: Date?, enabled: Bool, running: Bool, now: Date) -> Date? {
        guard enabled, !running, let nextRun, nextRun > now else { return nil }
        return nextRun
    }

    private static func calendarRun(after: Date, hour: Int, minute: Int, days: Set<Schedule.Weekday>?, calendar: Calendar) -> Date? {
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        let weekdays: [Schedule.Weekday] = [.sun, .mon, .tue, .wed, .thu, .fri, .sat]
        let start = calendar.startOfDay(for: after)
        for offset in 0..<370 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: start) else { continue }
            if let days, !days.contains(weekdays[calendar.component(.weekday, from: day) - 1]) { continue }
            var parts = calendar.dateComponents([.year, .month, .day], from: day)
            parts.hour = hour; parts.minute = minute; parts.second = 0
            guard let candidate = calendar.date(from: parts), candidate > after,
                  calendar.component(.hour, from: candidate) == hour,
                  calendar.component(.minute, from: candidate) == minute else { continue }
            return candidate
        }
        return nil
    }
}
