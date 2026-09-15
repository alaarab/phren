import Foundation

/// Keep the last report for immediate display, but refresh reports older than
/// a minute. A changed SSH identity never inherits another connection's data.
public struct AccountUsageMemoryCache: Sendable {
    private struct Entry: Sendable { let host: LiveHost; let value: AccountUsageSnapshot; let fetchedAt: Date }
    private var entries: [UUID: Entry] = [:]
    public let ttl: TimeInterval
    public init(ttl: TimeInterval = 60) { self.ttl = ttl }
    public func snapshot(for host: LiveHost) -> AccountUsageSnapshot? {
        guard let entry = entries[host.id], entry.host == host else { return nil }
        return entry.value
    }
    public func needsRefresh(_ host: LiveHost, at now: Date) -> Bool {
        guard let entry = entries[host.id], entry.host == host else { return true }
        return now.timeIntervalSince(entry.fetchedAt) >= ttl || now < entry.fetchedAt
    }
    public mutating func insert(_ value: AccountUsageSnapshot, for host: LiveHost, at now: Date) {
        entries[host.id] = Entry(host: host, value: value, fetchedAt: now)
        if entries.count > 32, let oldest = entries.min(by: { $0.value.fetchedAt < $1.value.fetchedAt })?.key {
            entries.removeValue(forKey: oldest)
        }
    }
}
