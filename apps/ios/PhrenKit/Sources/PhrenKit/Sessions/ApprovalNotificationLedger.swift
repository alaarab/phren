import Foundation

/// Persist this ledger before submitting an alert. Keeping the IDs after an
/// answer, expiry or reconnect prevents the same approval alerting twice.
/// Callers may hash identities before storing them; no prompt text is needed.
public struct ApprovalNotificationLedger: Codable, Equatable, Sendable {
    public private(set) var notified: Set<String> = []
    public init() {}

    public mutating func claim(_ id: String, expiresAt: Date, now: Date) -> Bool {
        guard !id.isEmpty, expiresAt > now else { return false }
        return notified.insert(id).inserted
    }
}
