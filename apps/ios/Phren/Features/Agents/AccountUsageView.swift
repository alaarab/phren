import PhrenKit
import PhrenLive
import SwiftUI

/// One card per provider. Shared allowance reports are merged, OpenCode's
/// local ledgers are summed, and duplicate OpenRouter keys count once.
struct AccountUsageView: View {
    var hostID: UUID? = nil
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @State private var refresh = 0
    @State private var errors: [UUID: String] = [:]
    @State private var loading: Set<UUID> = []
    private let cache = AccountUsageCache.shared
    private var hosts: [LiveHost] {
        (preferencesStore.preferences?.hosts ?? []).filter { hostID == nil || $0.id == hostID }
    }

    var body: some View {
        PhrenScrollScreen {
            if hosts.isEmpty {
                Text("Connect a computer in Agents to see Claude, Codex, OpenCode, OpenCode Go, and OpenRouter usage.")
                    .font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.textMuted)
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    let accounts = ordered(cache.mergedAccounts(for: hosts, at: context.date))
                    if accounts.isEmpty {
                        if !loading.isEmpty {
                            Text("Reading account limits…")
                                .font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.textMuted)
                        }
                    } else {
                        let newest = accounts.compactMap(\.updatedAt).max()
                        if let newest {
                            Text(updatedLine(accounts, newest: newest, now: context.date))
                                .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                                .phrenIdentifier("usage-updated")
                        }
                        ForEach(accounts) { account in
                            if account.source == "openrouter", let spend = account.spend, spend.amountUSD == 0 {
                                OpenRouterZeroRow()
                            } else {
                                AccountUsageCard(account: account, now: context.date, newest: newest)
                            }
                        }
                    }
                }
                ForEach(hosts.filter { errors[$0.id] != nil }) { host in
                    Text("\(host.name): \(errors[host.id] ?? "")")
                        .font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.warning)
                }
                Text("Claude and Codex limits come from each provider's own usage report. OpenCode Go is metered by the plan; OpenCode is an estimate recorded from local sessions. OpenRouter is live charged usage for the current UTC week.")
                    .font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.textMuted)
            }
        }
        .background {
            ForEach(hosts) { host in
                AccountUsagePoller(host: host, refresh: refresh,
                                   error: Binding(get: { errors[host.id] }, set: { errors[host.id] = $0 }),
                                   loading: Binding(get: { loading.contains(host.id) }, set: { if $0 { loading.insert(host.id) } else { loading.remove(host.id) } }))
            }
        }
        .navigationTitle("Account usage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("Refresh usage", systemImage: "arrow.clockwise") { refresh += 1 } }
        .refreshable { refresh += 1 }
    }

    /// Claude first, then the metered plan, the local estimate, and the
    /// zero-charge OpenRouter row last.
    private func ordered(_ accounts: [MergedAccountUsage]) -> [MergedAccountUsage] {
        let order = ["claude", "codex", "opencode-go", "opencode", "openrouter"]
        return accounts.sorted {
            (order.firstIndex(of: $0.source) ?? order.count, $0.source) < (order.firstIndex(of: $1.source) ?? order.count, $1.source)
        }
    }

    /// "Updated 6 s ago · <computers>": the newest report and the computers
    /// that reported it, once for the whole page.
    private func updatedLine(_ accounts: [MergedAccountUsage], newest: Date, now: Date) -> String {
        var seen = Set<String>()
        var names: [String] = []
        for account in accounts {
            for computer in account.computers where seen.insert(computer).inserted { names.append(computer) }
        }
        var text = "Updated \(UsageFormat.compact(now.timeIntervalSince(newest))) ago"
        if !names.isEmpty { text += " · " + names.joined(separator: ", ") }
        return text
    }
}

private struct AccountUsageCard: View {
    let account: MergedAccountUsage
    let now: Date
    let newest: Date?

    /// Older than the newest report by more than ten minutes.
    private var stale: Bool {
        guard let updated = account.updatedAt, let newest else { return false }
        return newest.timeIntervalSince(updated) > 600
    }

    private var snapshot: String? {
        guard stale, let updated = account.updatedAt else { return nil }
        return "snapshot from \(UsageFormat.compact(now.timeIntervalSince(updated))) ago"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.medium) {
            header
            if let snapshot {
                Text(snapshot).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.warning)
            }
            if account.source == "claude", account.origin != nil, let updated = account.updatedAt {
                Text(sourceLine(updated: updated))
                    .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    .phrenIdentifier("usage-source:claude")
            }
            switch account.source {
            case "opencode-go":
                if let spend = account.spend { UsageSpendLine(source: account.source, spend: spend, large: true) }
                OpenCodeGoUsageRows(account: account)
            case "opencode", "openrouter":
                if let spend = account.spend {
                    UsageSpendLine(source: account.source, spend: spend)
                    if account.source == "opencode" {
                        Text("Recorded by OpenCode from local sessions; not a bill.")
                            .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                }
            default:
                ForEach(account.displayWindows) { window in
                    UsageWindowLine(account: account, window: window, now: now)
                }
            }
            if let message = account.message {
                Text(message).font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.textMuted)
            }
        }
        .padding(PhrenTheme.Space.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .sessionCard()
        .phrenContainerMarker("account-usage:\(account.source)", label: account.name)
    }

    /// One documented source per number: which Claude report these windows came
    /// from, and how old that report is.
    private func sourceLine(updated: Date) -> String {
        let ago = UsageFormat.compact(now.timeIntervalSince(updated))
        switch account.origin {
        case "oauth": return "from Claude's usage endpoint, updated \(ago) ago"
        default: return "from Claude Code status line, updated \(ago) ago"
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: PhrenTheme.Space.small) {
            if stale {
                Circle().fill(PhrenTheme.warning).frame(width: 7, height: 7).accessibilityHidden(true)
            }
            Text(account.name).font(PhrenTypography.title3.weight(.semibold))
            if let billing = AccountUsagePresentation.billing(for: account.source) {
                PhrenChip(text: billing, color: PhrenTheme.textMuted)
            }
            Spacer(minLength: PhrenTheme.Space.small)
            if let accountName = account.accountName, !accountName.isEmpty {
                Text(accountName).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
            }
        }
    }
}

/// A limit line: name left, percent right, a 6pt bar, then the reset caption.
private struct UsageWindowLine: View {
    let account: MergedAccountUsage
    let window: AccountUsageSnapshot.Window
    let now: Date

    var body: some View {
        let name = AccountUsagePresentation.windowName(window, source: account.source)
        let usedPercent = window.usedPercent ?? 0
        let percent = AccountUsagePresentation.percent(usedPercent)
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text(name).font(PhrenTypography.subheadline)
                Spacer(minLength: PhrenTheme.Space.small)
                Text(percent).font(PhrenTypography.title3.monospacedDigit())
            }
            UsageBar(percent: usedPercent, color: UsageFormat.barColor(usedPercent))
            caption
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(name)
        .accessibilityValue("\(account.name) \(percent)")
        .accessibilityIdentifier(window.id == account.primaryWindow?.id
                                 ? "usage-primary-window:\(account.source)"
                                 : "usage-window:\(account.source):\(window.id)")
    }

    @ViewBuilder private var caption: some View {
        let reset: String? = window.resetDate.map { date in
            date > now ? "resets in \(UsageFormat.compact(date.timeIntervalSince(now)))"
                       : "reset passed · waiting for an update"
        }
        // A per-model window read from Claude Code's own snapshot carries its
        // own asOf: show that age beside the window's own reset time so the
        // row is never read as part of a fresher all-models window.
        let own: String? = window.asOfDate.map { "updated \(UsageFormat.compact(now.timeIntervalSince($0))) ago" }
        let parts = [reset, own].compactMap { $0 }
        if !parts.isEmpty {
            Text(parts.joined(separator: " · ")).font(PhrenTypography.caption)
                .foregroundStyle(window.resetDate.map { $0 <= now } == true ? PhrenTheme.warning : PhrenTheme.textMuted)
                .accessibilityIdentifier("usage-window-caption:\(window.id)")
        }
    }
}

/// The one-line spend total for a source, in dollars.
private struct UsageSpendLine: View {
    let source: String
    let spend: AccountUsageSnapshot.Spend
    /// The Go card states its whole total in title3.
    var large = false

    var body: some View {
        let amount = spend.amountUSD.formatted(.currency(code: "USD").precision(.fractionLength(2)))
        HStack(alignment: .firstTextBaseline) {
            Text(spend.periodLabel).font(large ? PhrenTypography.title3 : PhrenTypography.subheadline)
                .foregroundStyle(PhrenTheme.textSecondary)
            Spacer(minLength: PhrenTheme.Space.small)
            Text(amount).font(PhrenTypography.title3.monospacedDigit())
        }
        .phrenContainerMarker("usage-spend:\(source)", label: "\(spend.periodLabel) \(amount)")
    }
}

private struct OpenCodeGoUsageRows: View {
    let account: MergedAccountUsage

    private struct Row: Identifiable {
        let period: String
        let window: AccountUsageSnapshot.Window
        var id: String { window.id }
    }
    private struct Model: Identifiable {
        let key: String
        let title: String
        let rows: [Row]
        var id: String { key }
    }

    private var models: [Model] {
        let grouped = Dictionary(grouping: account.windows) { window in
            let pieces = window.name.components(separatedBy: " · ")
            return pieces.count == 2 ? pieces[0] : window.name
        }
        return grouped.map { key, windows in
            var byPeriod: [String: AccountUsageSnapshot.Window] = [:]
            for window in windows {
                let period = window.name.components(separatedBy: " · ").last
                if let period, byPeriod[period] == nil { byPeriod[period] = window }
            }
            let order = ["5h", "7d", "30d"]
            let rows = byPeriod.keys
                .sorted { (order.firstIndex(of: $0) ?? order.count, $0) < (order.firstIndex(of: $1) ?? order.count, $1) }
                .map { Row(period: $0, window: byPeriod[$0]!) }
            return Model(key: key, title: AccountUsagePresentation.modelTitle(key), rows: rows)
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    var body: some View {
        ForEach(models) { model in
            VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                Text(model.title).font(PhrenTypography.subheadline.weight(.semibold))
                ForEach(model.rows) { row in
                    GoWindowLine(source: account.source, window: row.window, period: row.period,
                                 isPrimary: row.window.id == account.primaryWindow?.id)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .phrenContainerMarker("usage-go-model:\(model.key)", label: model.title)
        }
    }
}

/// One Go window: "5h $0.21 of $0.80", the limit omitted when the plan has none.
private struct GoWindowLine: View {
    let source: String
    let window: AccountUsageSnapshot.Window
    let period: String
    let isPrimary: Bool

    var body: some View {
        let used = window.usedUSD.map { $0.formatted(.currency(code: "USD").precision(.fractionLength(2))) } ?? "-"
        let value: String = if let limit = window.limitUSD {
            "\(used) of \(limit.formatted(.currency(code: "USD").precision(.fractionLength(2))))"
        } else {
            used
        }
        let percent = window.usedPercent ?? 0
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text(period).font(PhrenTypography.subheadline)
                Spacer(minLength: PhrenTheme.Space.small)
                Text(value).font(PhrenTypography.title3.monospacedDigit())
            }
            UsageBar(percent: percent, color: UsageFormat.barColor(percent))
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(period) \(value)")
        .accessibilityIdentifier(isPrimary ? "usage-primary-window:\(source)" : "usage-window:\(source):\(window.id)")
    }
}

/// A plain 6pt progress bar. No native ProgressView: the fill is a Capsule.
private struct UsageBar: View {
    let percent: Double
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(PhrenTheme.surfaceRaised)
                Capsule().fill(color).frame(width: geometry.size.width * min(1, max(0, percent / 100)))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

private struct OpenRouterZeroRow: View {
    var body: some View {
        Text("OpenRouter · $0.00 this week")
            .font(PhrenTypography.subheadline).foregroundStyle(PhrenTheme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, PhrenTheme.Space.small)
            .phrenIdentifier("account-usage:openrouter")
    }
}

private enum UsageFormat {
    static func barColor(_ percent: Double) -> Color {
        if percent > 95 { return PhrenTheme.danger }
        if percent > 80 { return PhrenTheme.warning }
        return PhrenTheme.accent
    }

    /// "3 h 5 m", "1 d 4 h", "6 s": the compact form the captions use.
    static func compact(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval.rounded()))
        let days = total / 86_400
        let hours = (total % 86_400) / 3_600
        let minutes = (total % 3_600) / 60
        let seconds = total % 60
        if days > 0 { return hours > 0 ? "\(days) d \(hours) h" : "\(days) d" }
        if hours > 0 { return minutes > 0 ? "\(hours) h \(minutes) m" : "\(hours) h" }
        if minutes > 0 { return seconds > 0 ? "\(minutes) m \(seconds) s" : "\(minutes) m" }
        return "\(seconds) s"
    }
}

/// Keeps one computer's report fresh while the page is open. Draws nothing.
private struct AccountUsagePoller: View {
    let host: LiveHost
    let refresh: Int
    @Binding var error: String?
    @Binding var loading: Bool
    @Environment(\.scenePhase) private var phase
    private let cache = AccountUsageCache.shared
    @State private var lastRefresh = 0
    @State private var openedAt = CFAbsoluteTimeGetCurrent()
    private struct PollID: Equatable { let host: LiveHost; let refresh: Int; let active: Bool }

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .task(id: PollID(host: host, refresh: refresh, active: phase == .active)) {
                guard phase == .active else { return }
                #if DEBUG
                if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1", cache.snapshot(for: host) != nil {
                    print("[PhrenPerformance] usage open from cache: \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - openedAt) * 1_000)) ms")
                }
                #endif
                await LiveRefresh.shared.every(.seconds(30), key: "usage:\(host.id):\(refresh)") {
                    loading = cache.snapshot(for: host) == nil
                    do {
                        _ = try await cache.refresh(host, force: refresh != lastRefresh)
                        lastRefresh = refresh; error = nil
                    } catch {
                        self.error = error.localizedDescription
                    }
                    loading = false
                }
            }
    }
}
