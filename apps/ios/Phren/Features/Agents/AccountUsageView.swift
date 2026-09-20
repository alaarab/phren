import PhrenKit
import PhrenLive
import SwiftUI

/// One card per provider. Shared allowance reports are merged, OpenCode's
/// local ledgers are summed, and duplicate OpenRouter keys count once.
struct AccountUsageView: View {
    var hostID: UUID? = nil
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var refresh = 0
    @State private var errors: [UUID: String] = [:]
    @State private var loading: Set<UUID> = []
    private let cache = AccountUsageCache.shared
    private var hosts: [LiveHost] {
        ((try? LiveSessionPreferences.read(data))?.hosts ?? []).filter { hostID == nil || $0.id == hostID }
    }
    var body: some View {
        PhrenList {
            if hosts.isEmpty {
                Text("Connect a computer in Agents to see Claude, Codex, OpenCode, and OpenRouter usage.")
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    let accounts = cache.mergedAccounts(for: hosts, at: context.date)
                    if accounts.isEmpty, !loading.isEmpty { ProgressView("Reading account limits…") }
                    ForEach(accounts) { account in
                        Section { AccountUsageCard(account: account, now: context.date) }
                    }
                }
                ForEach(hosts.filter { errors[$0.id] != nil }) { host in
                    Text("\(host.name): \(errors[host.id] ?? "")").font(.footnote).foregroundStyle(PhrenTheme.warning)
                }
                Section {
                    Text("OpenCode is the rolling seven-day cost recorded in local sessions. OpenRouter is live charged usage for the current UTC week. Account limits are merged across computers.")
                        .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
                }
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
        .phrenScreen()
        .toolbar { Button("Refresh usage", systemImage: "arrow.clockwise") { refresh += 1 } }
        .refreshable { refresh += 1 }
    }
}

private struct AccountUsageCard: View {
    let account: MergedAccountUsage
    let now: Date
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(account.name).font(.headline)
                Spacer()
                if account.stale, !account.windows.isEmpty || account.spend != nil {
                    Text("Last reported").font(.caption).foregroundStyle(PhrenTheme.warning)
                } else {
                    Text(account.computers.joined(separator: " · ")).font(.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                }
            }
            if let spend = account.spend {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(spend.periodLabel).font(.subheadline)
                        Text(account.source == "opencode" ? "Recorded by OpenCode" : "Reported live by OpenRouter")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                    Spacer()
                    Text(spend.amountUSD, format: .currency(code: "USD").precision(.fractionLength(2)))
                        .font(.title2.monospacedDigit().weight(.semibold))
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("usage-spend:\(account.source)")
            }
            ForEach(account.windows) { window in
                let name = AccountUsagePresentation.windowName(window, source: account.source)
                let percent = AccountUsagePresentation.percent(window.usedPercent)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(name).font(.subheadline)
                        Spacer()
                        Text(percent).font(.subheadline.monospacedDigit().weight(.semibold))
                    }
                    ProgressView(value: window.usedPercent, total: 100)
                        .tint(account.stale ? PhrenTheme.textMuted : window.usedPercent >= 90 ? PhrenTheme.warning : PhrenTheme.accent)
                        .accessibilityLabel("\(name): \(window.usedPercent.formatted()) percent used")
                    caption(window)
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(name)
                .accessibilityValue("\(account.name) \(percent)")
                .accessibilityIdentifier(window.id == account.primaryWindow?.id
                                         ? "usage-primary-window:\(account.source)"
                                         : "usage-window:\(account.source):\(window.id)")
            }
            if let message = account.message {
                Text(message).font(.footnote).foregroundStyle(PhrenTheme.textMuted)
            }
            if let updated = account.updatedAt, !account.windows.isEmpty || account.spend != nil {
                Text("Updated \(updated, style: .relative) ago").font(.caption2).foregroundStyle(PhrenTheme.textMuted)
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("account-usage:\(account.source)")
    }

    @ViewBuilder private func caption(_ window: AccountUsageSnapshot.Window) -> some View {
        let reset: Text? = window.resetDate.map { reset in
            reset > now ? Text("resets in \(reset, style: .relative)") : Text("reset passed · waiting for an update")
        }
        let snapshot: Text? = window.asOfDate.map { asOf in Text("snapshot from \(asOf, style: .relative) ago") }
        let parts = [reset, snapshot].compactMap { $0 }
        if !parts.isEmpty {
            parts.dropFirst().reduce(parts[0]) { $0 + Text(" · ") + $1 }
                .font(.caption)
                .foregroundStyle(window.resetDate.map { $0 <= now } == true ? PhrenTheme.warning : PhrenTheme.textMuted)
                .accessibilityIdentifier("usage-window-caption:\(window.id)")
        }
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
                repeat {
                    loading = cache.snapshot(for: host) == nil
                    do {
                        _ = try await cache.refresh(host, force: refresh != lastRefresh)
                        try Task.checkCancellation()
                        lastRefresh = refresh; error = nil
                    } catch {
                        guard !Task.isCancelled else { return }
                        self.error = error.localizedDescription
                    }
                    loading = false
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                } while !Task.isCancelled
            }
    }
}
