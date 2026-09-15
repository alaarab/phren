import Foundation

/// DEBUG-only counters make repeated scrolling measurable without logging
/// transcript content. NSCache and these counters may be read off-main.
enum ChatRenderCacheMetrics {
    /// Read synchronously on the caller's current thread, including from a
    /// detached decode task (Foundation marks Thread's API noasync).
    static var isMainThread: Bool { Thread.isMainThread }
    private final class Counters: @unchecked Sendable {
        let lock = NSLock()
        var hits: [String: Int] = [:]
        var misses: [String: Int] = [:]
    }
    private static let counters = Counters()
    static func record(_ kind: String, hit: Bool) {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" else { return }
        counters.lock.lock()
        if hit { counters.hits[kind, default: 0] += 1 } else { counters.misses[kind, default: 0] += 1 }
        let hits = counters.hits[kind, default: 0], misses = counters.misses[kind, default: 0]
        counters.lock.unlock()
        if !hit || hits % 100 == 0 { print("[PhrenPerformance] \(kind) cache hits=\(hits) misses=\(misses)") }
        #endif
    }
}
