import Foundation

/// Debug counters for the phone's performance work: how often preferences
/// are read and decoded, how often a clock or a poll wakes the app, how many
/// times a view body runs. Off unless `PHREN_PERFORMANCE_LOG=1`, so a normal
/// run pays one branch per call site. The app exposes the totals to UI tests
/// through an accessibility value (see `PerformanceCountersProbe`), which lets
/// a test read the work done between two points without touching the app.
public enum PerformanceCounters {
    public static let enabled: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1"
        #else
        return false
        #endif
    }()

    private static let lock = NSLock()
    nonisolated(unsafe) private static var counts: [String: Int] = [:]

    @inline(__always)
    public static func bump(_ name: String, by amount: Int = 1) {
        guard enabled else { return }
        lock.lock(); counts[name, default: 0] += amount; lock.unlock()
    }

    public static func snapshot() -> [String: Int] {
        lock.lock(); defer { lock.unlock() }
        return counts
    }

    /// `name=value` pairs sorted by name, separated by spaces.
    public static func formatted() -> String {
        snapshot().sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
    }

    public static func reset() {
        lock.lock(); counts = [:]; lock.unlock()
    }
}
