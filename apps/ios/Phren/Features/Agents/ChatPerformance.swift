import Foundation
import PhrenKit

enum ChatPerformance {
    static let enabled = ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1"
    private static let lock = NSLock()
    private static var totals: [String: (count: Int, total: Double, max: Double)] = [:]
    static func begin() -> CFAbsoluteTime { enabled ? CFAbsoluteTimeGetCurrent() : 0 }
    static func end(_ name: String, _ start: CFAbsoluteTime) {
        #if DEBUG
        guard enabled else { return }
        PerformanceCounters.bump("body." + name.replacingOccurrences(of: " ", with: "-"))
        let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1_000
        lock.lock()
        let old = totals[name] ?? (0, 0, 0)
        let value = (count: old.count + 1, total: old.total + elapsed, max: max(old.max, elapsed))
        totals[name] = value
        lock.unlock()
        if value.count == 1 || value.count % 20 == 0 {
            print("[PhrenPerformance] \(name) bodies=\(value.count) mean=\(String(format: "%.3f", value.total / Double(value.count)))ms max=\(String(format: "%.3f", value.max))ms")
        }
        #endif
    }
    static func measure<Value>(_ name: String, _ content: () -> Value) -> Value {
        let start = begin(); defer { end(name, start) }; return content()
    }
}

/// The chat-open journey for `PerformanceCounters`: from the tap that opens
/// a conversation to its first transcript row on screen. Each completed open
/// adds its milliseconds to `journey.chat-first-row-ms` and one to
/// `journey.chat-opens`, so a test reads the mean over the opens it made.
@MainActor enum ChatJourney {
    private static var startedAt: CFAbsoluteTime?
    private static var endedAt: CFAbsoluteTime = 0
    static func begin() {
        guard PerformanceCounters.enabled else { return }
        startedAt = CFAbsoluteTimeGetCurrent()
    }
    /// For an open that no tap started (Siri, a notification, the drawer).
    static func beginIfIdle() { if startedAt == nil, CFAbsoluteTimeGetCurrent() - endedAt > 1 { begin() } }
    static func cancel() { startedAt = nil }
    /// The chat screen itself is up (`journey.chat-view-ms`), rows or not.
    static func appeared() {
        guard let started = startedAt else { return }
        PerformanceCounters.bump("journey.chat-view-ms", by: Int(((CFAbsoluteTimeGetCurrent() - started) * 1_000).rounded()))
        PerformanceCounters.bump("journey.chat-views")
    }
    static func firstRow() {
        guard let started = startedAt else { return }
        startedAt = nil; endedAt = CFAbsoluteTimeGetCurrent()
        let milliseconds = Int(((CFAbsoluteTimeGetCurrent() - started) * 1_000).rounded())
        PerformanceCounters.bump("journey.chat-first-row-ms", by: milliseconds)
        PerformanceCounters.bump("journey.chat-opens")
        print("[PhrenPerformance] chat first row after \(milliseconds)ms")
    }
}
