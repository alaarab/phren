import Foundation

/// Coalesce a burst from its first change, so continuous polling cannot keep
/// postponing a write. Only successful writes become the comparison baseline.
struct SpotlightDebounce<Value: Equatable> {
    let interval: TimeInterval
    private(set) var committed: Value?
    private(set) var pending: Value?
    private(set) var deadline: Date?

    init(interval: TimeInterval = 3) { self.interval = interval }

    mutating func update(_ value: Value, at now: Date) {
        pending = value
        if value == committed { deadline = nil }
        else if deadline == nil { deadline = now.addingTimeInterval(interval) }
    }

    func ready(at now: Date) -> Value? {
        guard let deadline, now >= deadline else { return nil }
        return pending
    }

    mutating func complete(_ value: Value, succeeded: Bool, at now: Date) {
        // A partial Core Spotlight write can have added or deleted entries.
        // Invalidate the baseline on failure so the retry rebuilds both types.
        committed = succeeded ? value : nil
        deadline = pending == committed ? nil : now.addingTimeInterval(interval)
    }
}

