import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

struct SessionWorkingActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionWorkingActivityAttributes.self) { context in
            SessionWorkingSummary(state: context.state)
                .padding(10)
                .activityBackgroundTint(WidgetTheme.activityBackground)
                .activitySystemActionForegroundColor(WidgetTheme.activityText)
                .widgetURL(routeURL(context))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { PhrenActivityMark(size: 18) }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.summary)
                        .font(WidgetTheme.Font.caption).foregroundStyle(WidgetTheme.activitySecondary).lineLimit(1).truncationMode(.tail)

                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(context.state.entries.prefix(3)) { entry in
                            AgentRow(entry: entry)
                        }
                    }

                }
            } compactLeading: {
                PhrenActivityMark(size: 16)
            } compactTrailing: {
                Text("\(context.state.working)").font(WidgetTheme.Font.caption2.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(context.state.waiting > 0 ? WidgetTheme.warning : WidgetTheme.cyan)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .background((context.state.waiting > 0 ? WidgetTheme.warning : WidgetTheme.cyan).opacity(0.15), in: Capsule())
                    .accessibilityLabel("\(context.state.working) working, \(context.state.waiting) waiting")
            } minimal: { PhrenActivityMark(size: 16) }
            .widgetURL(routeURL(context))
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

/// The lock-screen / banner presentation: the phren mark and a count, then one
/// short row per running agent, then how many more were too many to list.
private struct SessionWorkingSummary: View {
    let state: SessionWorkingActivityAttributes.ContentState
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var visibleCount: Int { dynamicTypeSize.isAccessibilitySize ? min(1, state.entries.count) : state.entries.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                PhrenActivityMark(size: 18)
                Text(state.summary).font(WidgetTheme.Font.caption).foregroundStyle(WidgetTheme.activitySecondary)
                    .lineLimit(1).truncationMode(.tail)
            }
            ForEach(state.entries.prefix(visibleCount)) { entry in
                AgentRow(entry: entry)
            }
            let more = state.more + state.entries.count - visibleCount
            if more > 0 {
                Text("+\(more) more agents").font(WidgetTheme.Font.caption2).foregroundStyle(WidgetTheme.activitySecondary)
                    .lineLimit(1).truncationMode(.tail)
            }
        }
    }
}

/// One fixed-height agent row: provider, project, model, computer, then the
/// branch or worktree (or the worker count, or the state word) with a state
/// dot, and its own elapsed timer. Every text truncates so a long value can
/// never wrap the row or stretch the activity.
private struct AgentRow: View {
    let entry: SessionWorkingActivityAttributes.Entry
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var isWaiting: Bool { entry.state == "waiting" }
    private var isIdle: Bool { entry.state == "idle" || entry.state == "done" }
    /// The middle column: the branch (or worktree folder), otherwise how many
    /// fan-out workers are running, otherwise the state word.
    private var detail: String {
        if entry.role == "conductor", entry.subagents > 0 {
            let leads = "\(entry.subagents) \(entry.subagents == 1 ? "lead" : "leads")"
            let computers = Set(entry.leadComputers).count
            return computers > 0 ? "\(leads) on \(computers) \(computers == 1 ? "computer" : "computers")" : leads
        }
        if let branch = entry.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty { return branch }
        if entry.subagents > 0 { return "\(entry.subagents) \(entry.subagents == 1 ? "worker" : "workers")" }
        return stateWord
    }
    private var stateWord: String {
        if isWaiting { return "Needs an answer" }
        switch entry.state {
        case "idle": return "Idle"
        case "done": return "Done"
        default: return "Working"
        }
    }
    private var color: Color { isWaiting ? WidgetTheme.warning : isIdle ? WidgetTheme.green : WidgetTheme.activitySecondary }
    private var projectColor: Color { WidgetTheme.projectNameColor(entry.projectColor) }

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    if entry.role == "conductor" {
                        Image(systemName: "wand.and.rays").foregroundStyle(WidgetTheme.cyan)
                            .accessibilityLabel("Conductor")
                    }
                    Text(entry.project).font(WidgetTheme.Font.caption.weight(.semibold)).foregroundStyle(projectColor)
                }
                Text([entry.model, entry.computer, detail].compactMap { $0 }.joined(separator: " · "))
                    .font(WidgetTheme.Font.caption2).foregroundStyle(color)
            }
        } else {
            row
        }
    }

    private var row: some View {
        HStack(spacing: 6) {
            if entry.role == "conductor" {
                Image(systemName: "wand.and.rays")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WidgetTheme.cyan)
                    .frame(width: 14, height: 14)
                    .accessibilityLabel("Conductor")
            } else {
                ProviderActivityGlyphStack(providers: [entry.provider] + entry.childProviders, size: 14)
            }
            Text(entry.project).privacySensitive().font(WidgetTheme.Font.caption.weight(.semibold))
                .foregroundStyle(projectColor).lineLimit(1).truncationMode(.tail).layoutPriority(1)
            if let model = entry.model {
                Text(model).font(WidgetTheme.Font.caption2.monospaced()).foregroundStyle(WidgetTheme.activitySecondary)
                    .lineLimit(1).truncationMode(.tail)
            }
            Text(entry.computer).font(WidgetTheme.Font.caption2).foregroundStyle(WidgetTheme.activitySecondary)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(detail).privacySensitive().font(WidgetTheme.Font.caption2).foregroundStyle(color)
                    .lineLimit(1).truncationMode(.middle)
            }
            if !isLuminanceReduced, !isIdle, let startedAt = entry.startedAt {
                Text(startedAt, style: .timer).font(WidgetTheme.Font.caption2.monospacedDigit())
                    .multilineTextAlignment(.trailing).minimumScaleFactor(0.7)
                    .lineLimit(1).truncationMode(.tail)
                    .frame(width: 44, alignment: .trailing).clipped()
            }
        }
        .frame(minHeight: 18)
    }
}

private struct ProviderActivityGlyphStack: View {
    let providers: [String]
    let size: CGFloat
    private var visible: [String] { Array(providers.prefix(4)) }

    var body: some View {
        ZStack(alignment: .leading) {
            ForEach(visible.indices, id: \.self) { index in
                ProviderActivityGlyph(provider: visible[index], size: size)
                    .padding(1).background(WidgetTheme.activityBackground, in: Circle())
                    .offset(x: CGFloat(index) * size * 0.55)
            }
        }
        .frame(width: size + CGFloat(max(0, visible.count - 1)) * size * 0.55, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(visible.joined(separator: ", "))
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
