import Observation
import PhrenKit
import SwiftUI
import UIKit

/// The app's one second-by-second clock. Only elapsed-time labels read `now`:
/// a tick invalidates those leaves and nothing above them. It runs while at
/// least one label is on screen and the app is active, and stops otherwise.
/// Freshness (live, stale, connecting) is not clock-driven: monitors publish
/// it when an answer lands and when it ages out.
@Observable @MainActor
final class AppClock {
    static let shared = AppClock()
    private(set) var now = Date.now
    @ObservationIgnored private var readers = 0
    @ObservationIgnored private var ticking: Task<Void, Never>?

    /// Call from a label's `.task`; returns when the task is cancelled.
    func observe() async {
        readers += 1
        if ticking == nil {
            now = .now
            ticking = Task {
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    // A backgrounded app draws nothing; skip the invalidation.
                    guard UIApplication.shared.applicationState == .active else { continue }
                    now = .now
                    PerformanceCounters.bump("tick.app-clock")
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

/// Text computed from the shared clock: the only kind of view that ticks.
struct ClockText<Label: View>: View {
    let content: (Date) -> Label
    private let clock = AppClock.shared

    init(@ViewBuilder _ content: @escaping (Date) -> Label) { self.content = content }

    var body: some View {
        let _ = PerformanceCounters.bump("tick.clock-label")
        content(clock.now).task { await clock.observe() }
    }
}

struct SessionRelativeTimeLabel: View {
    let changedAt: Date
    var prefix = "· "

    var body: some View {
        ClockText { now in
            Text(prefix + SessionRelativeTime.text(since: changedAt, at: now))
                .font(PhrenTypography.caption2).monospacedDigit().foregroundStyle(PhrenTheme.sessionMeta)
                .lineLimit(1).fixedSize()
        }
    }
}
