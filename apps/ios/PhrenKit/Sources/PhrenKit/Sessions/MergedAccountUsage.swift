import Foundation

/// One card per account, whichever computers report it. The same Claude or
/// Codex sign-in on two computers has one allowance, so the page shows it
/// once, with every window taken from the computer that read it most
/// recently (per-model windows come from a snapshot with its own date).
public struct MergedAccountUsage: Identifiable, Equatable, Sendable {
    public let source: String
    public let computers: [String]
    public let windows: [AccountUsageSnapshot.Window]
    public let spend: AccountUsageSnapshot.Spend?
    public let updatedAt: Date?
    public let message: String?
    public let stale: Bool
    public var id: String { source }
    public var name: String {
        switch source {
        case "claude": "Claude"
        case "opencode": "OpenCode"
        case "openrouter": "OpenRouter"
        default: "Codex"
        }
    }

    public static func merge(_ reports: [(computer: String, snapshot: AccountUsageSnapshot?)], at now: Date) -> [MergedAccountUsage] {
        struct Candidate { let window: AccountUsageSnapshot.Window; let date: Date? }
        struct SpendCandidate { let spend: AccountUsageSnapshot.Spend; let date: Date? }
        var order: [String] = []
        var computers: [String: [String]] = [:]
        var windows: [String: [String: Candidate]] = [:]
        var windowOrder: [String: [String]] = [:]
        var updated: [String: Date] = [:]
        var messages: [String: String] = [:]
        var stale: [String: Bool] = [:]
        var localSpend: [String: Double] = [:]
        var sharedSpend: [String: [String: SpendCandidate]] = [:]
        for (computer, snapshot) in reports {
            for account in snapshot?.accounts ?? [] {
                if !order.contains(account.source) { order.append(account.source) }
                if !computers[account.source, default: []].contains(computer) { computers[account.source, default: []].append(computer) }
                if let date = account.updatedDate, date > (updated[account.source] ?? .distantPast) { updated[account.source] = date }
                if let message = account.message, messages[account.source] == nil { messages[account.source] = message }
                let accountStale = account.isStale(at: now)
                if !account.windows.isEmpty || account.spend != nil { stale[account.source] = (stale[account.source] ?? true) && accountStale }
                if let spend = account.spend {
                    if account.source == "opencode" {
                        localSpend[account.source, default: 0] += spend.amountUSD
                    } else if account.source == "openrouter" {
                        let identity = account.accountId ?? "computer:\(computer)"
                        let current = sharedSpend[account.source]?[identity]
                        if current == nil || (current!.date ?? .distantPast) < (account.updatedDate ?? .distantPast) {
                            sharedSpend[account.source, default: [:]][identity] = SpendCandidate(spend: spend, date: account.updatedDate)
                        }
                    }
                }
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
            let spend: AccountUsageSnapshot.Spend? = if source == "opencode", let amount = localSpend[source] {
                .init(amountUSD: amount, period: "rolling_7_days")
            } else if source == "openrouter", let candidates = sharedSpend[source], !candidates.isEmpty {
                .init(amountUSD: candidates.values.reduce(0) { $0 + $1.spend.amountUSD }, period: "calendar_week")
            } else { nil }
            return MergedAccountUsage(source: source, computers: computers[source] ?? [], windows: list, spend: spend,
                                      updatedAt: updated[source], message: list.isEmpty && spend == nil ? messages[source] : nil,
                                      stale: stale[source] ?? false)
        }
    }
}
