import Foundation

/// One card per account, whichever computers report it. The same Claude or
/// Codex sign-in on two computers has one allowance, so the page shows it
/// once, with every window taken from the computer that read it most
/// recently (per-model windows come from a snapshot with its own date).
public struct MergedAccountUsage: Identifiable, Equatable, Sendable {
    public let source: String
    public let computers: [String]
    public let windows: [AccountUsageSnapshot.Window]
    public let updatedAt: Date?
    public let message: String?
    public let stale: Bool
    public var id: String { source }
    public var name: String { source == "claude" ? "Claude" : "Codex" }

    public static func merge(_ reports: [(computer: String, snapshot: AccountUsageSnapshot?)], at now: Date) -> [MergedAccountUsage] {
        struct Candidate { let window: AccountUsageSnapshot.Window; let date: Date? }
        var order: [String] = []
        var computers: [String: [String]] = [:]
        var windows: [String: [String: Candidate]] = [:]
        var windowOrder: [String: [String]] = [:]
        var updated: [String: Date] = [:]
        var messages: [String: String] = [:]
        var stale: [String: Bool] = [:]
        for (computer, snapshot) in reports {
            for account in snapshot?.accounts ?? [] {
                if !order.contains(account.source) { order.append(account.source) }
                if !computers[account.source, default: []].contains(computer) { computers[account.source, default: []].append(computer) }
                if let date = account.updatedDate, date > (updated[account.source] ?? .distantPast) { updated[account.source] = date }
                if let message = account.message, messages[account.source] == nil { messages[account.source] = message }
                let accountStale = account.isStale(at: now)
                if !account.windows.isEmpty { stale[account.source] = (stale[account.source] ?? true) && accountStale }
                for window in account.windows {
                    let date = window.asOfDate ?? account.updatedDate
                    if !windowOrder[account.source, default: []].contains(window.id) { windowOrder[account.source, default: []].append(window.id) }
                    if let current = windows[account.source]?[window.id], (current.date ?? .distantPast) >= (date ?? .distantPast) { continue }
                    windows[account.source, default: [:]][window.id] = Candidate(window: window, date: date)
                }
            }
        }
        return order.map { source in
            let list = windowOrder[source, default: []].compactMap { windows[source]?[$0]?.window }
            return MergedAccountUsage(source: source, computers: computers[source] ?? [], windows: list, updatedAt: updated[source],
                                      message: list.isEmpty ? messages[source] : nil, stale: stale[source] ?? false)
        }
    }
}
