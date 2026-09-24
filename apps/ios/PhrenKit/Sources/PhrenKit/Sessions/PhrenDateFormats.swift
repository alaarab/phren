import Foundation

/// The one place for date formatters outside ISO 8601 (see `ISO8601Dates`).
///
/// Building a `DateFormatter` costs far more than using one, and formatters
/// are thread-safe for formatting and parsing once configured, so every
/// style is built once and shared. Fixed wire and file formats use
/// `fixed(_:timeZone:calendar:)`, which is en_US_POSIX, Gregorian unless told
/// otherwise and strict. Text shown to the person uses the locale-aware
/// `relative`, `shortDate`, `time` and `shortDateTime`.
public enum PhrenDateFormats {
    private struct FixedKey: Hashable {
        let format: String
        let timeZone: String
        let calendar: Calendar.Identifier
    }

    /// The caches, only touched under `lock`.
    private final class Cache: @unchecked Sendable {
        let lock = NSLock()
        var fixed: [FixedKey: DateFormatter] = [:]
        var relative: [RelativeDateTimeFormatter.UnitsStyle: RelativeDateTimeFormatter] = [:]
    }
    private static let cache = Cache()

    /// A fixed-format formatter such as `yyyy-MM-dd` or `HH:mm`, cached per
    /// format, time zone and calendar. `timeZone` defaults to the current zone
    /// at the time of the call.
    public static func fixed(_ format: String, timeZone: TimeZone = .current,
                             calendar: Calendar = Calendar(identifier: .gregorian)) -> DateFormatter {
        let key = FixedKey(format: format, timeZone: timeZone.identifier, calendar: calendar.identifier)
        cache.lock.lock(); defer { cache.lock.unlock() }
        if let cached = cache.fixed[key] { return cached }
        var zoned = calendar
        zoned.timeZone = timeZone
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = zoned
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        formatter.isLenient = false
        cache.fixed[key] = formatter
        return formatter
    }

    /// `yyyy-MM-dd`-style formatting in UTC, the store's own dates.
    public static func utc(_ format: String) -> DateFormatter {
        fixed(format, timeZone: utcZone)
    }

    public static let utcZone = TimeZone(identifier: "UTC")!

    /// "2 hr. ago" (abbreviated) or "2 hours ago" (full), in the current locale.
    public static func relative(_ date: Date, to reference: Date = .now,
                                unitsStyle: RelativeDateTimeFormatter.UnitsStyle = .abbreviated) -> String {
        relativeFormatter(unitsStyle).localizedString(for: date, relativeTo: reference)
    }

    public static func relativeFormatter(_ unitsStyle: RelativeDateTimeFormatter.UnitsStyle) -> RelativeDateTimeFormatter {
        cache.lock.lock(); defer { cache.lock.unlock() }
        if let cached = cache.relative[unitsStyle] { return cached }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = unitsStyle
        cache.relative[unitsStyle] = formatter
        return formatter
    }

    /// Locale-aware short date ("9/22/26"), time ("3:04 PM") and both.
    public static let shortDate: DateFormatter = styled(date: .short, time: .none)
    public static let time: DateFormatter = styled(date: .none, time: .short)
    public static let shortDateTime: DateFormatter = styled(date: .short, time: .short)

    private static func styled(date: DateFormatter.Style, time: DateFormatter.Style) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.dateStyle = date
        formatter.timeStyle = time
        return formatter
    }
}
