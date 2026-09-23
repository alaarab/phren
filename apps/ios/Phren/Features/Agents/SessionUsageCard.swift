import PhrenKit
import PhrenLive
import SwiftUI

/// This computer's account limits for the session's harness, as bars.
struct SessionUsageCard: View {
    let host: LiveHost
    let source: String?
    private let cache = AccountUsageCache.shared
    var body: some View {
        Group {
            if let account = cache.snapshot(for: host)?.accounts.first(where: { $0.source == source }), !account.windows.isEmpty {
                VStack(spacing: 10) {
                    HStack { Text("Account").foregroundStyle(PhrenTheme.textMuted); Spacer(); Text(account.source.capitalized).foregroundStyle(PhrenTheme.text) }
                    ForEach(account.windows) { window in
                        if let usedPercent = window.usedPercent {
                            HStack(spacing: 12) {
                                Text(Self.short(window.name)).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted).frame(width: 40, alignment: .leading)
                                GeometryReader { geometry in
                                    ZStack(alignment: .leading) {
                                        Capsule().fill(PhrenTheme.surfaceRaised)
                                        Capsule().fill(usedPercent >= 90 ? PhrenTheme.warning : PhrenTheme.success)
                                            .frame(width: max(8, geometry.size.width * min(1, usedPercent / 100)))
                                    }
                                }.frame(height: 8)
                                Text("\(Int(usedPercent.rounded()))%").font(.caption).monospacedDigit().foregroundStyle(PhrenTheme.textSecondary).frame(width: 36, alignment: .trailing)
                                Text(window.resetDate.map { Self.until($0) } ?? "").font(.caption).monospacedDigit().foregroundStyle(PhrenTheme.textMuted).frame(width: 60, alignment: .trailing)
                            }
                        }
                    }
                }
                .padding(16).background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
        .task {
            _ = try? await cache.refresh(host)
        }
    }
    private static func short(_ name: String) -> String {
        let lower = name.lowercased()
        if lower.contains("5") { return "5h" }
        if lower.contains("7") { return "7d" }
        return String(name.split(separator: " ").first ?? "").capitalized
    }
    private static func until(_ date: Date) -> String {
        let seconds = max(0, date.timeIntervalSinceNow)
        let days = Int(seconds / 86_400), hours = Int(seconds.truncatingRemainder(dividingBy: 86_400) / 3_600), minutes = Int(seconds.truncatingRemainder(dividingBy: 3_600) / 60)
        return days > 0 ? "\(days)d \(hours)h" : "\(hours)h \(minutes)m"
    }
}
