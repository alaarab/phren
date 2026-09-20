import ActivityKit
import SwiftUI
import WidgetKit

struct SessionWorkingActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionWorkingActivityAttributes.self) { context in
            SessionWorkingSummary(state: context.state)
                .padding(10)
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(routeURL(context))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { PhrenActivityMark(size: 18) }
                DynamicIslandExpandedRegion(.trailing) { ElapsedTimer(start: context.state.startedAt) }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.headline)
                        .font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
                }
                DynamicIslandExpandedRegion(.bottom) { bottom(context.state) }
            } compactLeading: {
                PhrenActivityMark(size: 16)
            } compactTrailing: {
                Text("\(context.state.working)").font(.caption2.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(context.state.waiting > 0 ? .orange : WidgetTheme.cyan)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .background((context.state.waiting > 0 ? Color.orange : WidgetTheme.cyan).opacity(0.15), in: Capsule())
                    .accessibilityLabel("\(context.state.working) working, \(context.state.waiting) waiting")
            } minimal: { PhrenActivityMark(size: 16) }
            .widgetURL(routeURL(context))
        }
    }

    /// The primary session's project · computer and current step, then the
    /// remaining rows. Steps carry `privacySensitive` so a locked screen hides
    /// what the agent is doing until the person authenticates.
    @ViewBuilder private func bottom(_ state: SessionWorkingActivityAttributes.ContentState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let entry = state.primary {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(entry.project).privacySensitive().font(.caption.weight(.semibold)).lineLimit(1)
                        Text("· \(entry.computer)").privacySensitive().font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        if entry.subagents > 0 { SubagentPill(count: entry.subagents) }
                        Spacer(minLength: 0)
                    }
                    if let step = entry.step ?? entry.tool {
                        Text(step).privacySensitive().font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            ForEach(state.entries.dropFirst().prefix(3)) { entry in
                HStack(spacing: 6) {
                    ProviderActivityGlyph(provider: entry.provider, size: 16)
                    Text(entry.project).privacySensitive().lineLimit(1)
                    if let step = entry.step ?? entry.tool {
                        Text("· \(step)").privacySensitive().foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Text(entry.computer).privacySensitive().font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Opens the conversation the activity leads with; the app resolves the
    /// stored route, falling back to the Agents tab when it is gone.
    private func routeURL(_ context: ActivityViewContext<SessionWorkingActivityAttributes>) -> URL? {
        var components = URLComponents()
        components.scheme = "phren"; components.host = "session"
        components.queryItems = [URLQueryItem(name: "route", value: context.attributes.routeID)]
        return components.url
    }
}

/// The lock-screen / banner presentation: the session leading the activity.
private struct SessionWorkingSummary: View {
    let state: SessionWorkingActivityAttributes.ContentState

    private var total: Int { state.working + state.waiting }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            PhrenActivityMark(size: 18)
            if let entry = state.primary {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(entry.project).privacySensitive().font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                        Text("· \(entry.computer)").privacySensitive().font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        if entry.subagents > 0 { SubagentPill(count: entry.subagents) }
                    }
                    Text(entry.step ?? entry.tool ?? state.headline).privacySensitive()
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Text(state.headline).font(.subheadline.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
            }
            Spacer(minLength: 4)
            if total > 1 {
                Text("\(total)").font(.caption2.weight(.bold)).monospacedDigit()
                    .foregroundStyle(WidgetTheme.cyan)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .background(WidgetTheme.cyan.opacity(0.15), in: Capsule())
                    .accessibilityLabel("\(total) sessions")
            }
            ElapsedTimer(start: state.startedAt)
        }
    }
}

/// The timer is pinned to a fixed width so `Text(style: .timer)` can never
/// stretch the island as it grows.
private struct ElapsedTimer: View {
    let start: Date

    var body: some View {
        Text(start, style: .timer).font(.caption.monospacedDigit()).foregroundStyle(WidgetTheme.cyan)
            .multilineTextAlignment(.trailing).minimumScaleFactor(0.65)
            .frame(width: 52, alignment: .trailing).clipped()
    }
}

private struct SubagentPill: View {
    let count: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "person.2.fill").font(.system(size: 9))
            Text("\(count) agent\(count == 1 ? "" : "s")").font(.caption2.weight(.semibold)).monospacedDigit()
        }
        .foregroundStyle(WidgetTheme.cyan)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(WidgetTheme.cyan.opacity(0.15), in: Capsule())
        .accessibilityLabel("\(count) agent\(count == 1 ? "" : "s") running")
    }
}

private struct PhrenActivityMark: View {
    let size: CGFloat

    var body: some View {
        // The mark is the sprite alone on a transparent ground, so it reads
        // at island size instead of vanishing into a dark tile.
        Image("PhrenMark").resizable().scaledToFit()
            .frame(width: size, height: size)
            .accessibilityLabel("phren")
    }
}

private struct ProviderActivityGlyph: View {
    let provider: String
    let size: CGFloat

    private var asset: String? {
        switch provider.lowercased() {
        case "claude": "ClaudeMark"
        case "codex": "CodexMark"
        case "copilot": "CopilotMark"
        case "opencode": "OpenCodeMark"
        default: nil
        }
    }

    var body: some View {
        if let asset {
            Image(asset).resizable().scaledToFit().frame(width: size, height: size)
        } else {
            Image(systemName: "terminal").frame(width: size, height: size)
        }
    }
}