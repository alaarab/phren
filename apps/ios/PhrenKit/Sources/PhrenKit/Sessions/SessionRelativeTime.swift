import Foundation

public enum SessionRelativeTime {
    /// Compact and deliberately stable at minute/hour/day boundaries.
    public static func text(since changed: Date, at now: Date) -> String {
        let elapsed = max(0, now.timeIntervalSince(changed))
        guard elapsed.isFinite, elapsed >= 10 else { return "now" }
        if elapsed < 60 { return "\(Int(elapsed))s ago" }
        if elapsed < 3_600 { return "\(Int(elapsed / 60))m ago" }
        if elapsed < 86_400 { return "\(Int(elapsed / 3_600))h ago" }
        return "\(Int(min(elapsed / 86_400, Double(Int.max / 2))))d ago"
    }
}
