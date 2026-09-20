import Foundation

/// How long a turn has been running, as the widget's timer reads it. Pure so
/// the shared activity contract and its tests stay independent of ActivityKit.
public enum SessionElapsedTime {
    public static func format(from startedAt: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(startedAt)))
        let hours = seconds / 3_600
        let minutes = seconds % 3_600 / 60
        let remainder = seconds % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
            : String(format: "%d:%02d", minutes, remainder)
    }
}