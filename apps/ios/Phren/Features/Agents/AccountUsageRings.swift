import PhrenKit
import SwiftUI

/// The plan usage rings on the Sessions tab, the way Moshi's home shows
/// them: one ring per provider in use — Claude and Codex both when both
/// are — each the most consumed window that provider reports across your
/// computers. Tapping opens Account usage. Read from the shared usage cache,
/// which each computer refreshes about once a minute.
struct AccountUsageRings: View {
    let hosts: [LiveHost]
    private let cache = AccountUsageCache.shared
    @Environment(\.scenePhase) private var phase

    /// Provider → most consumed window across every computer that reports it.
    private var quotas: [(source: String, percent: Double)] {
        var best: [String: Double] = [:]
        for host in hosts {
            for account in cache.snapshot(for: host)?.accounts ?? [] {
                guard let used = account.windows.map(\.usedPercent).max() else { continue }
                best[account.source] = max(best[account.source] ?? 0, used)
            }
        }
        // A stable order: Claude outermost, then Codex, then anything else.
        let order = ["claude", "codex", "copilot"]
        return best.sorted { (order.firstIndex(of: $0.key) ?? 9, $0.key) < (order.firstIndex(of: $1.key) ?? 9, $1.key) }
            .map { (source: $0.key, percent: $0.value) }
    }

    var body: some View {
        let quotas = quotas
        NavigationLink { AccountUsageView() } label: {
            ZStack {
                if quotas.isEmpty {
                    ring(nil, color: PhrenTheme.textMuted, size: 26)
                } else {
                    ForEach(Array(quotas.enumerated()), id: \.element.source) { index, quota in
                        ring(quota.percent, color: Self.color(for: quota.source), size: 26 - CGFloat(index) * 9)
                    }
                }
            }.frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel("Account usage")
        .accessibilityValue(quotas.isEmpty ? "unavailable"
                            : quotas.map { "\($0.source.capitalized) \(Int($0.percent))%" }.joined(separator: ", "))
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
        Circle().stroke(PhrenTheme.borderStrong, lineWidth: 2.5)
            .overlay {
                if let percent {
                    Circle().trim(from: 0, to: min(1, max(0, percent / 100)))
                        .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round)).rotationEffect(.degrees(-90))
                }
            }.frame(width: size, height: size)
    }
}
