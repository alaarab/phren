import Foundation
import PhrenKit

enum ScheduleWords {
    static func describe(_ schedule: Schedule) -> String {
        switch schedule.every {
        case .interval(let minutes):
            if minutes.isMultiple(of: 1_440) { return "Every \(minutes / 1_440)d" }
            if minutes.isMultiple(of: 60) { return "Every \(minutes / 60)h" }
            return "Every \(minutes)m"
        case .daily(let hour, let minute):
            return "Daily at \(time(hour: hour, minute: minute))"
        case .weekly(let days, let hour, let minute):
            let prefix: String
            if days == Set([.mon, .tue, .wed, .thu, .fri]) {
                prefix = "Weekdays"
            } else if days == Set([.sat, .sun]) {
                prefix = "Weekends"
            } else {
                prefix = Schedule.Weekday.allCases.filter(days.contains).map(shortDay).joined(separator: ", ")
            }
            return "\(prefix) at \(time(hour: hour, minute: minute))"
        case .once(let date):
            return "Once, \(onceDate(date)) at \(clock(date, calendar: .current))"
        case .cron(let expression):
            return "Cron \(expression)"
        }
    }

    static func nextRun(_ schedule: Schedule, after: Date, calendar: Calendar) -> Date? {
        guard schedule.enabled else { return nil }
        switch schedule.every {
        case .interval(let minutes):
            guard minutes > 0 else { return nil }
            let seconds = minutes.multipliedReportingOverflow(by: 60)
            guard !seconds.overflow else { return nil }
            let duration = TimeInterval(seconds.partialValue)
            if schedule.createdAt > after { return schedule.createdAt }
            let elapsed = after.timeIntervalSince(schedule.createdAt)
            let occurrences = floor(elapsed / duration) + 1
            return schedule.createdAt.addingTimeInterval(occurrences * duration)
        case .daily(let hour, let minute):
            guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
            for offset in 0...1 {
                guard let day = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: after)),
                      let candidate = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) else { continue }
                if candidate > after { return candidate }
            }
            return nil
        case .weekly(let days, let hour, let minute):
            guard !days.isEmpty, (0...23).contains(hour), (0...59).contains(minute) else { return nil }
            let start = calendar.startOfDay(for: after)
            for offset in 0...7 {
                guard let day = calendar.date(byAdding: .day, value: offset, to: start),
                      let weekday = weekday(for: calendar.component(.weekday, from: day)),
                      days.contains(weekday),
                      let candidate = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) else { continue }
                if candidate > after { return candidate }
            }
            return nil
        case .once(let date):
            return date > after ? date : nil
        case .cron(let expression):
            return CronPreview.next(expression, count: 1, from: after, calendar: calendar)?.first
        }
    }

    static func relative(_ date: Date, now: Date) -> String {
        guard date > now else { return SessionRelativeTime.text(since: date, at: now) }
        let calendar = Calendar.current
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "tomorrow \(clock(date, calendar: calendar))"
        }
        let seconds = date.timeIntervalSince(now)
        if seconds < 3_600 {
            return "in \(max(1, Int(ceil(seconds / 60))))m"
        }
        if calendar.isDate(date, inSameDayAs: now) {
            return "in \(max(1, Int(ceil(seconds / 3_600))))h"
        }
        let start = calendar.startOfDay(for: now)
        let end = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: start, to: end).day ?? 1
        return "in \(max(1, days))d"
    }

    static func harnessName(_ harness: Schedule.Harness) -> String {
        switch harness {
        case .claude: "Claude"
        case .codex: "Codex"
        case .opencode: "OpenCode"
        }
    }

    static func shortDay(_ day: Schedule.Weekday) -> String {
        switch day {
        case .mon: return "Mon"
        case .tue: return "Tue"
        case .wed: return "Wed"
        case .thu: return "Thu"
        case .fri: return "Fri"
        case .sat: return "Sat"
        case .sun: return "Sun"
        }
    }

    private static func weekday(for calendarWeekday: Int) -> Schedule.Weekday? {
        switch calendarWeekday {
        case 1: return .sun
        case 2: return .mon
        case 3: return .tue
        case 4: return .wed
        case 5: return .thu
        case 6: return .fri
        case 7: return .sat
        default: return nil
        }
    }

    private static func time(hour: Int, minute: Int) -> String {
        String(format: "%02d:%02d", hour, minute)
    }

    private static func clock(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    private static func onceDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }
}
