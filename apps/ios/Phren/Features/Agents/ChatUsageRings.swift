import PhrenKit
import SwiftUI

struct ChatUsageRings: View {
    let session: LiveAgentSession
    let source: String?
    private let cache = AccountUsageCache.shared
    @Environment(\.scenePhase) private var phase

    var body: some View {
        let context = session.tab.contextUsedPercent
        let account = cache.mergedAccounts(for: [session.host], at: Date()).first { $0.source == source }
        let quota = account?.primaryWindow?.usedPercent
        NavigationLink { AccountUsageView(hostID: session.host.id) } label: {
            ZStack {
                ring(context, color: PhrenTheme.accent, size: 28)
                ring(quota, color: PhrenTheme.success, size: 18)
            }.frame(width: 44, height: 44).contentShape(Rectangle())
        }.accessibilityLabel("Context and account usage")
            .accessibilityValue("Context \(context.map { AccountUsagePresentation.percent($0) } ?? "unavailable"), account \(quota.map { AccountUsagePresentation.percent($0) } ?? "unavailable")")
            .accessibilityIdentifier("chat-usage-rings")
            .task(id: phase) {
                guard phase == .active else { return }
                repeat {
                    _ = try? await cache.refresh(session.host)
                    do { try await Task.sleep(for: .seconds(60)) } catch { return }
                } while !Task.isCancelled
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
