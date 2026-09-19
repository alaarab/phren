import Foundation

enum ChatPerformance {
    static let enabled = ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1"
    private static let lock = NSLock()
    private static var totals: [String: (count: Int, total: Double, max: Double)] = [:]
    static func begin() -> CFAbsoluteTime { enabled ? CFAbsoluteTimeGetCurrent() : 0 }
    static func end(_ name: String, _ start: CFAbsoluteTime) {
        #if DEBUG
        guard enabled else { return }
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
