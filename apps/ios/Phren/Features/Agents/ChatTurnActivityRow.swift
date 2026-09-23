import PhrenKit
import SwiftUI

/// Claude's live spinner fields, as the Hook reads them from the pane. Only
/// the activity row observes this, so a token update redraws that row alone.
@MainActor @Observable final class ChatTurnControl {
    var spinner: AgentChatSpinner?
}

/// The activity line's stop ring: the same stop the composer's button sends.
struct ChatTurnStop: Equatable {
    var enabled = false
    var action: @MainActor () -> Void = {}
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.enabled == rhs.enabled }
}

extension EnvironmentValues {
    @Entry var chatTurnStop: ChatTurnStop? = nil
}

/// One quiet line. Only this leaf ticks; transcript preparation never sees the clock.
struct ChatTurnActivityRow: View {
    let activity: ChatTurnActivity
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.chatTurnStop) private var stop
    @Environment(ChatTurnControl.self) private var control: ChatTurnControl?
    @ScaledMetric(relativeTo: .footnote) private var timerWidth: CGFloat = 112
    @ScaledMetric(relativeTo: .footnote) private var rowHeight: CGFloat = 24

    /// Claude's own spinner line for this turn: its verb, with the fields
    /// the Hook read beside it.
    private var spinner: AgentChatSpinner? {
        guard activity.isLive, activity.fromHarness, let spinner = control?.spinner, spinner.verb == activity.verb else { return nil }
        return spinner
    }

    var body: some View {
        if activity.isLive && scenePhase == .active {
            // The shared clock ticks this leaf alone.
            ClockText { now in live(at: now) }
        } else if activity.isLive {
            live(at: .now)
        } else {
            finished
        }
    }

    private func live(at now: Date) -> some View {
        HStack(spacing: PhrenTheme.Space.small) {
            line(at: now)
            if let stop {
                // The ring keeps its 44-point target, laid over the gaps
                // above and below the line rather than adding to them.
                ChatStopRing(enabled: stop.enabled, action: stop.action)
                    .frame(width: 44, height: rowHeight)
            }
        }
        // The height is the same at every tick, so seconds becoming minutes
        // never move the transcript.
        .frame(height: rowHeight)
    }

    @ViewBuilder private func line(at now: Date) -> some View {
        let elapsed = ChatTurnActivity.duration(now.timeIntervalSince(activity.startedAt))
        HStack(spacing: PhrenTheme.Space.small) {
            if let spinner {
                ClaudeSpinnerGlyph(reduceMotion: reduceMotion)
                Text(spinner.verb + "…").foregroundStyle(PhrenTheme.textMuted).lineLimit(1).layoutPriority(1)
                Text("(" + ([elapsed] + spinner.details).joined(separator: " · ") + ")")
                    .monospacedDigit().foregroundStyle(PhrenTheme.chatNeutralDim).lineLimit(1)
            } else {
                SessionActivityArc(color: PhrenTheme.textMuted)
                    .frame(width: 12, height: 12).accessibilityHidden(true)
                Text(activity.verb).lineLimit(1)
                Text(elapsed).monospacedDigit().frame(width: timerWidth, alignment: .leading)
            }
            Spacer(minLength: 0)
        }
        // The size of a tool pill's preview, so the verb reads at a glance.
        .font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.textMuted)
        .frame(maxWidth: .infinity, alignment: .leading).frame(height: rowHeight)
        // Keep the accessibility region on the laid-out row. Without a
        // shape, its bounds follow the text and rotating arc, not the space
        // reserved for the timer and the rest of the row.
        .contentShape(.accessibility, Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spinner.map { "\($0.verb)… (" + ([elapsed] + $0.details).joined(separator: " · ") + ")" }
                            ?? activity.label(at: now))
        .accessibilityIdentifier(activity.identifier)
    }

    /// The finished turn: Claude's verb in the past tense where it said one,
    /// a quiet italic note above the reply.
    private var finished: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            Text(activity.label(at: activity.finishedAt ?? activity.startedAt)).italic().lineLimit(1)
            Spacer(minLength: 0)
        }
        .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.chatNote)
        .frame(maxWidth: .infinity, alignment: .leading).frame(height: rowHeight)
        .contentShape(.accessibility, Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(activity.label(at: activity.finishedAt ?? activity.startedAt))
        .accessibilityIdentifier(activity.identifier)
    }

}

/// Claude's spinner glyph, turning at its terminal pace (about eight frames a
/// second, forward then back) on a clock of its own, so only this glyph
/// redraws between the row's once-a-second ticks.
struct ClaudeSpinnerGlyph: View {
    let reduceMotion: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: Self.frame, paused: reduceMotion)) { context in
            Text(reduceMotion ? Self.glyphs[4] : Self.glyphs[Self.index(at: context.date)])
                .foregroundStyle(PhrenTheme.chatRunning).frame(width: 12).accessibilityHidden(true)
        }
    }

    static let frame: TimeInterval = 0.12
    // Text presentation: without the selector some of these draw as emoji.
    static let glyphs = ["·", "✢", "✳", "✶", "✻", "✽"].map { $0 + "\u{FE0E}" }
    /// Forward then back without repeating the ends: 0 1 2 3 4 5 4 3 2 1.
    static func index(at date: Date) -> Int {
        let cycle = glyphs.count * 2 - 2
        let step = Int(date.timeIntervalSinceReferenceDate / frame) % cycle
        return step < glyphs.count ? step : cycle - step
    }
}

/// A small ring at the end of the live line: a turning arc around a stop
/// square, in a 44-point target. It stops the turn as the composer's does.
struct ChatStopRing: View {
    let enabled: Bool
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().stroke(PhrenTheme.chatNeutralDim.opacity(0.35), lineWidth: 2)
                SessionActivityArc(color: PhrenTheme.chatRunning)
                RoundedRectangle(cornerRadius: 1.5).fill(PhrenTheme.chatText).frame(width: 7, height: 7)
            }
            .frame(width: 22, height: 22)
            .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .accessibilityLabel("Stop")
        .accessibilityHint("Stops the agent's current turn")
        .accessibilityIdentifier("chat-activity-stop")
    }
}
