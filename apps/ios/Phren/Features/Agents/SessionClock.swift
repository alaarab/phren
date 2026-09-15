import Observation
import PhrenKit
import SwiftUI

/// One clock shared by visible time labels. Only a leaf that reads `now`
/// invalidates on a tick; neither the cards nor their list observe it.
@Observable @MainActor
final class SessionClock {
    static let shared = SessionClock()
    private(set) var now = Date.now
    @ObservationIgnored private var readers = 0
    @ObservationIgnored private var ticking: Task<Void, Never>?

    func observe() async {
        readers += 1
        if ticking == nil {
            now = .now
            ticking = Task {
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    now = .now
                }
            }
        }
        defer {
            readers -= 1
            if readers == 0 { ticking?.cancel(); ticking = nil }
        }
        do { while !Task.isCancelled { try await Task.sleep(for: .seconds(3_600)) } } catch { }
    }
}

struct SessionRelativeTimeLabel: View {
    let changedAt: Date
    var prefix = "· "
    private let clock = SessionClock.shared

    var body: some View {
        Text(prefix + SessionRelativeTime.text(since: changedAt, at: clock.now))
            .font(.caption2).monospacedDigit().foregroundStyle(PhrenTheme.sessionMeta)
            .lineLimit(1).fixedSize()
            .task { await clock.observe() }
    }
}
