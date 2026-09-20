import Foundation

/// One card per account, whichever computers report it. The same Claude or
/// Codex sign-in on two computers has one allowance, so the page shows it
/// once, using the whole report from the computer that read it most
/// recently. Keeping a report intact prevents windows from different reads
/// from looking like one provider response.
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
    public var primaryWindow: AccountUsageSnapshot.Window? {
        windows.reduce(Optional<AccountUsageSnapshot.Window>.none) { current, window in
            guard let current else { return window }
            return window.usedPercent > current.usedPercent ? window : current
        }
    }

    public static func merge(_ reports: [(computer: String, snapshot: AccountUsageSnapshot?)], at now: Date) -> [MergedAccountUsage] {
        struct SpendCandidate { let spend: AccountUsageSnapshot.Spend; let date: Date? }
        var order: [String] = []
        var computers: [String: [String]] = [:]
        var latest: [String: AccountUsageSnapshot.Account] = [:]
        var updated: [String: Date] = [:]
        var stale: [String: Bool] = [:]
        var localSpend: [String: Double] = [:]
        var sharedSpend: [String: [String: SpendCandidate]] = [:]
        for (computer, snapshot) in reports {
            for account in snapshot?.accounts ?? [] {
                if !order.contains(account.source) { order.append(account.source) }
                if !computers[account.source, default: []].contains(computer) { computers[account.source, default: []].append(computer) }
                if let date = account.updatedDate, date > (updated[account.source] ?? .distantPast) { updated[account.source] = date }
                if latest[account.source] == nil
                    || (latest[account.source]?.updatedDate ?? .distantPast) < (account.updatedDate ?? .distantPast) {
                    latest[account.source] = account
                }
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
            }
        }
        return order.map { source in
            let selected = latest[source]
            let list = selected?.windows ?? []
            let spend: AccountUsageSnapshot.Spend? = if source == "opencode", let amount = localSpend[source] {
                .init(amountUSD: amount, period: "rolling_7_days")
            } else if source == "openrouter", let candidates = sharedSpend[source], !candidates.isEmpty {
                .init(amountUSD: candidates.values.reduce(0) { $0 + $1.spend.amountUSD }, period: "calendar_week")
            } else { nil }
            let isStale = spend == nil ? (selected?.isStale(at: now) ?? false) : (stale[source] ?? false)
            return MergedAccountUsage(source: source, computers: computers[source] ?? [], windows: list, spend: spend,
                                      updatedAt: updated[source], message: list.isEmpty && spend == nil ? selected?.message : nil,
                                      stale: isStale)
        }
    }
}
