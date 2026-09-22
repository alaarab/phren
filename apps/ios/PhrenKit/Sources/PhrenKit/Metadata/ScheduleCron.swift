import Foundation

public enum ScheduleCron {
    public static func next(_ expression: String, count: Int, from: Date, calendar: Calendar) -> [Date]? {
        guard count >= 0, let cron = Parsed(expression) else { return nil }
        guard count > 0 else { return [] }

        var dates: [Date] = []
        let start = calendar.startOfDay(for: from)
        for offset in 0..<(366 * 8) {
            guard let day = calendar.date(byAdding: .day, value: offset, to: start) else { return nil }
            let dayComponents = calendar.dateComponents([.year, .month, .day, .weekday], from: day)
            guard cron.matches(dayComponents) else { continue }

            for hour in cron.hour.values.sorted() {
                for minute in cron.minute.values.sorted() {
                    var components = dayComponents
                    components.calendar = calendar
                    components.timeZone = calendar.timeZone
                    components.hour = hour
                    components.minute = minute
                    components.second = 0
                    guard let candidate = calendar.date(from: components) else { continue }
                    let check = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: candidate)
                    guard check.year == components.year, check.month == components.month,
                          check.day == components.day, check.hour == hour, check.minute == minute,
                          candidate > from else { continue }
                    dates.append(candidate)
                    if dates.count == count { return dates }
                }
            }
        }
        return nil
    }
}

private extension ScheduleCron {
    struct Parsed {
        let minute: Field
        let hour: Field
        let day: Field
        let month: Field
        let weekday: Field

        init?(_ expression: String) {
            let pieces = expression.split(whereSeparator: \.isWhitespace).map(String.init)
            guard pieces.count == 5,
                  let minute = Field(pieces[0], range: 0...59),
                  let hour = Field(pieces[1], range: 0...23),
                  let day = Field(pieces[2], range: 1...31),
                  let month = Field(pieces[3], range: 1...12),
                  let weekday = Field(pieces[4], range: 0...7, normalize: { $0 == 7 ? 0 : $0 }) else { return nil }
            self.minute = minute
            self.hour = hour
            self.day = day
            self.month = month
            self.weekday = weekday
        }

        func matches(_ components: DateComponents) -> Bool {
            guard let dayValue = components.day, let monthValue = components.month,
                  let calendarWeekday = components.weekday, month.values.contains(monthValue) else { return false }
            let dayMatches = day.values.contains(dayValue)
            let weekdayMatches = weekday.values.contains(calendarWeekday - 1)
            if day.wildcard { return weekday.wildcard || weekdayMatches }
            if weekday.wildcard { return dayMatches }
            return dayMatches || weekdayMatches
        }
    }

    struct Field {
        let values: Set<Int>
        let wildcard: Bool

        init?(_ source: String, range: ClosedRange<Int>, normalize: (Int) -> Int = { $0 }) {
            guard !source.isEmpty else { return nil }
            var values = Set<Int>()
            for item in source.split(separator: ",", omittingEmptySubsequences: false) {
                guard !item.isEmpty else { return nil }
                let stepParts = item.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
                guard stepParts.count <= 2 else { return nil }
                let base = String(stepParts[0])
                let step: Int
                if stepParts.count == 2 {
                    guard let parsed = Int(stepParts[1]), parsed > 0 else { return nil }
                    step = parsed
                } else {
                    step = 1
                }

                let bounds: ClosedRange<Int>
                if base == "*" {
                    bounds = range
                } else if base.contains("-") {
                    let endpoints = base.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
                    guard endpoints.count == 2, let lower = Int(endpoints[0]), let upper = Int(endpoints[1]),
                          range.contains(lower), range.contains(upper), lower <= upper else { return nil }
                    bounds = lower...upper
                } else {
                    guard let value = Int(base), range.contains(value) else { return nil }
                    bounds = stepParts.count == 2 ? value...range.upperBound : value...value
                }

                var value = bounds.lowerBound
                while value <= bounds.upperBound {
                    values.insert(normalize(value))
                    guard value <= bounds.upperBound - step else { break }
                    value += step
                }
            }
            guard !values.isEmpty else { return nil }
            self.values = values
            wildcard = source == "*"
        }
    }
}
