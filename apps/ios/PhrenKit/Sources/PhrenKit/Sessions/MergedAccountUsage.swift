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
    /// The signed-in email or handle from the newest report, when one carries it.
    public let accountName: String?
    /// Which Claude report the newest account came from: `status-line` or `oauth`.
    public let origin: String?
    public var id: String { source }
    public var name: String {
        switch source {
        case "claude": "Claude"
        case "opencode": "OpenCode"
        case "opencode-go": "OpenCode Go"
        case "openrouter": "OpenRouter"
        default: "Codex"
        }
    }
    /// The Account usage card's window order: Claude leads with the 5-hour
    /// window, then the per-model weekly allowance, then all models. The
    /// header ring binds to the first row of this order, so both surfaces
    /// always show the same number first.
    public var displayWindows: [AccountUsageSnapshot.Window] {
        guard source == "claude" else { return windows }
        let order = ["five_hour", "seven_day_fable", "seven_day"]
        let rank = { (window: AccountUsageSnapshot.Window) in order.firstIndex(of: window.id) ?? order.count }
        return windows.sorted { rank($0) != rank($1) ? rank($0) < rank($1) : $0.id < $1.id }
    }

    /// The window the header ring draws: the first window the page shows
    /// with a percentage (Claude's 5-hour window), never a different or
    /// higher window such as the per-model weekly allowance.
    public var primaryWindow: AccountUsageSnapshot.Window? {
        displayWindows.first { $0.usedPercent != nil }
    }

    public static func merge(_ reports: [(computer: String, snapshot: AccountUsageSnapshot?)], at now: Date) -> [MergedAccountUsage] {
        struct SpendCandidate { let spend: AccountUsageSnapshot.Spend; let date: Date? }
        struct GoWindowCandidate { var window: AccountUsageSnapshot.Window; var amountUSD: Double; var date: Date? }
        var order: [String] = []
        var computers: [String: [String]] = [:]
        var latest: [String: AccountUsageSnapshot.Account] = [:]
        var updated: [String: Date] = [:]
        var stale: [String: Bool] = [:]
        var localSpend: [String: (amount: Double, period: String)] = [:]
        var goWindows: [String: GoWindowCandidate] = [:]
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
                if account.source == "opencode-go" {
                    for window in account.windows {
                        let current = goWindows[window.id]
                        let shouldReplaceLimit = window.limitUSD != nil && (current?.window.limitUSD == nil
                            || (current?.date ?? .distantPast) < (account.updatedDate ?? .distantPast))
                        let template = shouldReplaceLimit || current == nil ? window : current!.window
                        goWindows[window.id] = GoWindowCandidate(window: template, amountUSD: (current?.amountUSD ?? 0) + (window.usedUSD ?? 0),
                                                                  date: max(current?.date ?? .distantPast, account.updatedDate ?? .distantPast))
                    }
                }
                if let spend = account.spend {
                    if ["opencode", "opencode-go"].contains(account.source) {
                        let current = localSpend[account.source] ?? (amount: 0, period: spend.period)
                        localSpend[account.source] = (amount: current.amount + spend.amountUSD, period: spend.period)
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
            let list: [AccountUsageSnapshot.Window] = if source == "opencode-go" {
                goWindows.values.map { candidate in
                    let limitUSD = candidate.window.limitUSD
                    let usedPercent = limitUSD.map { min(100, candidate.amountUSD / $0 * 100) }
                    return .init(id: candidate.window.id, name: candidate.window.name, usedPercent: usedPercent, usedUSD: candidate.amountUSD,
                                 limitUSD: limitUSD, resetsAt: candidate.window.resetsAt, asOf: candidate.window.asOf)
                }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            } else { selected?.windows ?? [] }
            let spend: AccountUsageSnapshot.Spend? = if let local = localSpend[source] {
                .init(amountUSD: local.amount, period: local.period)
            } else if source == "openrouter", let candidates = sharedSpend[source], !candidates.isEmpty {
                .init(amountUSD: candidates.values.reduce(0) { $0 + $1.spend.amountUSD }, period: "calendar_week")
            } else { nil }
            let isStale = spend == nil ? (selected?.isStale(at: now) ?? false) : (stale[source] ?? false)
            return MergedAccountUsage(source: source, computers: computers[source] ?? [], windows: list, spend: spend,
                                      updatedAt: updated[source], message: source == "opencode-go" ? selected?.message : (list.isEmpty && spend == nil ? selected?.message : nil),
                                      stale: isStale, accountName: selected?.accountName, origin: selected?.origin)
        }
    }
}
