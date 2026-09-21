import PhrenKit
import SwiftUI

/// Uses the same merged report as Account usage so both surfaces agree.
struct AccountUsageRings: View {
    let hosts: [LiveHost]
    private let cache = AccountUsageCache.shared
    @Environment(\.scenePhase) private var phase

    private var quotas: [AccountUsageRingQuota] {
        AccountUsageRingSelection.primaryWindows(in: cache.mergedAccounts(for: hosts, at: Date()))
    }

    var body: some View {
        let quotas = quotas
        NavigationLink { AccountUsageView() } label: {
            ZStack {
                if quotas.isEmpty {
                    ring(nil, color: PhrenTheme.textMuted, size: 20)
                } else {
                    ForEach(Array(quotas.enumerated()), id: \.element.source) { index, quota in
                        ring(quota.window.usedPercent, color: Self.color(for: quota.source), size: 20 - CGFloat(index) * 7)
                    }
                }
            }.frame(width: 22, height: 22).contentShape(Rectangle())
        }
        .accessibilityLabel("Account usage")
        .accessibilityValue(AccountUsageRingSelection.accessibilityValue(quotas))
        .accessibilityIdentifier("all-account-usage")
        .task(id: RefreshID(hosts: hosts, active: phase == .active)) {
            guard phase == .active else { return }
            repeat {
                for host in hosts { _ = try? await cache.refresh(host) }
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            } while !Task.isCancelled
        }
    }
    private struct RefreshID: Equatable { let hosts: [LiveHost]; let active: Bool }

    static func color(for source: String) -> Color {
        switch source {
        case "claude": Color(hex: 0xE8825A)
        case "codex": PhrenTheme.success
        default: PhrenTheme.cyan
        }
    }
    private func ring(_ percent: Double?, color: Color, size: CGFloat) -> some View {
        Circle().stroke(PhrenTheme.borderStrong, lineWidth: 2)
            .overlay {
                if let percent {
                    Circle().trim(from: 0, to: min(1, max(0, percent / 100)))
                        .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
                }
            }.frame(width: size, height: size)
    }
}

struct AccountUsageRingQuota: Equatable {
    let source: String
    let accountName: String
    let window: AccountUsageSnapshot.Window
}

enum AccountUsageRingSelection {
    static func primaryWindows(in accounts: [MergedAccountUsage]) -> [AccountUsageRingQuota] {
        let order = ["claude", "codex", "copilot"]
        return accounts.compactMap { account in
            account.primaryWindow.map { AccountUsageRingQuota(source: account.source, accountName: account.name, window: $0) }
        }.sorted {
            (order.firstIndex(of: $0.source) ?? 9, $0.source) < (order.firstIndex(of: $1.source) ?? 9, $1.source)
        }
    }

    static func accessibilityValue(_ quotas: [AccountUsageRingQuota]) -> String {
        guard let primary = quotas.first else { return "unavailable" }
        return "\(primary.accountName) \(AccountUsagePresentation.percent(primary.window.usedPercent))"
    }
}

enum AccountUsagePresentation {
    static func percent(_ value: Double) -> String {
        "\(value.formatted(.number.precision(.fractionLength(0...1))))%"
    }

    static func windowName(_ window: AccountUsageSnapshot.Window, source: String) -> String {
        guard source == "claude" else { return shortName(window.name) }
        if window.id == "seven_day" { return "7-day, all models" }
        if window.id.hasPrefix("seven_day_") {
            return shortName(window.name).replacingOccurrences(of: "7-day · ", with: "7-day, ")
        }
        return shortName(window.name)
    }

    private static func shortName(_ name: String) -> String {
        name.hasSuffix(" limit") ? String(name.dropLast(6)) : name
    }
}
