import Foundation

/// The one ISO-8601 parser for timestamps the CLI and Phren Hook emit.
///
/// Fractional seconds are tried first: `new Date().toISOString()` always
/// carries `.SSS`, so any other order throws once per value on the common
/// case. The styles are built once — a per-call `ISO8601DateFormatter()` is
/// the expensive part, not the parse.
public enum ISO8601Dates {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()
    private static let dateOnly = Date.ISO8601FormatStyle(timeZone: TimeZone(identifier: "UTC")!)
        .year().month().day().dateSeparator(.dash)

    /// `2026-09-10T12:00:00.123Z`, `2026-09-10T13:00:00+01:00`, or a bare
    /// `2026-09-10` (read as midnight UTC). nil for nil or anything else.
    public static func parse(_ text: String?) -> Date? {
        guard let text else { return nil }
        if let date = try? fractional.parse(text) { return date }
        if let date = try? whole.parse(text) { return date }
        return text.count == 10 ? try? dateOnly.parse(text) : nil
    }

    // ISO8601DateFormatter rounds a parsed .456 second where ISO8601FormatStyle
    // can truncate it to .455, so writing goes through the formatter, built once.
    private static let writerFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let writerWhole = ISO8601DateFormatter()

    /// `2026-09-10T12:00:00.123Z` with `fractionalSeconds`, else
    /// `2026-09-10T12:00:00Z`. Always UTC.
    public static func string(from date: Date, fractionalSeconds: Bool = false) -> String {
        (fractionalSeconds ? writerFractional : writerWhole).string(from: date)
    }
}
