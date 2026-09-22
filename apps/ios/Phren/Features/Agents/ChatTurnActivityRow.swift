import PhrenKit
import SwiftUI

/// One quiet line. Only this leaf ticks; transcript preparation never sees the clock.
struct ChatTurnActivityRow: View {
    let activity: ChatTurnActivity
    @Environment(\.scenePhase) private var scenePhase
    @ScaledMetric(relativeTo: .caption) private var timerWidth: CGFloat = 104
    @ScaledMetric(relativeTo: .caption) private var rowHeight: CGFloat = 24

    var body: some View {
        if activity.isLive && scenePhase == .active {
            TimelineView(.periodic(from: activity.startedAt, by: 1)) { tick in
                line(at: tick.date)
            }
        } else {
            line(at: activity.finishedAt ?? .now)
        }
    }

    private func line(at now: Date) -> some View {
        HStack(spacing: PhrenTheme.Space.small) {
            if activity.isLive {
                SessionActivityArc(color: PhrenTheme.textMuted)
                    .frame(width: 12, height: 12).accessibilityHidden(true)
            }
            Text(activity.verb).lineLimit(1)
            if activity.isLive {
                Text(ChatTurnActivity.duration(now.timeIntervalSince(activity.startedAt)))
                    .monospacedDigit().frame(width: timerWidth, alignment: .leading)
            } else {
                Text(ChatTurnActivity.duration((activity.finishedAt ?? activity.startedAt).timeIntervalSince(activity.startedAt)))
                    .monospacedDigit()
            }
            Spacer(minLength: 0)
        }
        .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
        .frame(maxWidth: .infinity, alignment: .leading).frame(height: rowHeight)
        // Keep the accessibility region on the laid-out row. Without a
        // shape, its bounds follow the text and rotating arc, not the space
        // reserved for the timer and the rest of the row.
        .contentShape(.accessibility, Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(activity.label(at: now))
        .accessibilityIdentifier(activity.identifier)
    }
}
