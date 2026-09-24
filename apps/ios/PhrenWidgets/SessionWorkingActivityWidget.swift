import ActivityKit
import AppIntents
import Foundation
import SwiftUI
import WidgetKit

struct SessionWorkingActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionWorkingActivityAttributes.self) { context in
            SessionWorkingSummary(state: context.state, isStale: context.isStale)
                .padding(10)
                .activityBackgroundTint(WidgetTheme.activityBackground)
                .activitySystemActionForegroundColor(WidgetTheme.activityText)
                .widgetURL(routeURL(context))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { PhrenActivityMark(size: 18) }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.headline)
                        .font(WidgetTheme.Font.caption).foregroundStyle(WidgetTheme.activitySecondary).lineLimit(1).truncationMode(.tail)

                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let approval = context.state.approval {
                            FleetApprovalBlock(approval: approval, isStale: context.isStale, compact: true)
                        }
                        // A request fills the expanded island; the rows are on the lock screen.
                        ForEach(context.state.entries.prefix(context.state.approval == nil ? 3 : 0)) { entry in
                            AgentRow(entry: entry)
                        }
                    }
                    // Clear of the island's rounded corners, where a timer clips.
                    .padding(.horizontal, 6)

                }
            } compactLeading: {
                PhrenActivityMark(size: 16)
            } compactTrailing: {
                FleetCompactCounts(state: context.state, isStale: context.isStale)
            } minimal: { PhrenActivityMark(size: 16) }
            .widgetURL(routeURL(context))
        }
    }

    /// Opens the conversation the activity leads with; the app resolves the
    /// stored route, falling back to the Agents tab when it is gone.
    private func routeURL(_ context: ActivityViewContext<SessionWorkingActivityAttributes>) -> URL? {
        // A waiting request leads: a tap opens its own conversation.
        if let approval = context.state.approval, let url = approval.openURL { return url }
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
    let isStale: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The lock screen gives an activity about 160 points, so a request on
    /// top leaves room for two rows rather than five.
    private var visibleCount: Int {
        if dynamicTypeSize.isAccessibilitySize { return min(1, state.entries.count) }
        return state.approval == nil ? state.entries.count : min(2, state.entries.count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                PhrenActivityMark(size: 18)
                Text(state.headline).font(WidgetTheme.Font.caption).foregroundStyle(WidgetTheme.activitySecondary)
                    .lineLimit(1).truncationMode(.tail)
            }
            if let approval = state.approval {
                FleetApprovalBlock(approval: approval, isStale: isStale, compact: true)
                    .padding(.vertical, 2)
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
        VStack(alignment: .leading, spacing: 1) {
            content
            if let reply = entry.reply, isIdle, !dynamicTypeSize.isAccessibilitySize {
                Text(reply).privacySensitive().font(WidgetTheme.Font.caption2)
                    .foregroundStyle(WidgetTheme.activitySecondary)
                    .lineLimit(1).truncationMode(.tail)
                    .padding(.leading, 20)
            }
        }
    }

    @ViewBuilder private var content: some View {
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

/// The island's compact trailing side: the request's word while one waits,
/// otherwise the working count with the needs-you count beside it. Pinned
/// widths, so a number never resizes the island.
private struct FleetCompactCounts: View {
    let state: SessionWorkingActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        if let approval = state.approval, !isStale {
            Text(approval.question ? "Question" : "Approve?")
                .font(WidgetTheme.Font.caption2.weight(.semibold)).foregroundStyle(WidgetTheme.warning)
                .lineLimit(1).frame(width: 60, alignment: .trailing)
        } else {
            HStack(spacing: 3) {
                pill("\(state.working)", color: WidgetTheme.cyan)
                if state.needsYou > 0 { pill("\(state.needsYou)", color: WidgetTheme.warning) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(state.headline)
        }
    }

    private func pill(_ text: String, color: Color) -> some View {
        Text(text).font(WidgetTheme.Font.caption2.weight(.semibold)).monospacedDigit()
            .foregroundStyle(color).lineLimit(1)
            .frame(minWidth: 12).padding(.horizontal, 5).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
    }
}

/// The request the fleet activity leads with: who asks, where, what, and
/// Deny / Approve through the same authenticated intent as the chat card. A
/// question offers Open, since its choices are made in the app.
private struct FleetApprovalBlock: View {
    let approval: SessionWorkingActivityAttributes.PendingApproval
    let isStale: Bool
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 4 : 6) {
            HStack(spacing: 6) {
                Image(systemName: isStale ? "clock" : approval.question ? "questionmark.bubble.fill" : "hand.raised.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isStale ? WidgetTheme.activitySecondary : WidgetTheme.warning)
                    .frame(width: 14, height: 14)
                Text(isStale ? "Check current request" : approval.headline)
                    .font(WidgetTheme.Font.caption.weight(.semibold)).foregroundStyle(WidgetTheme.activityText)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Text("\(approval.project) · \(approval.host)").privacySensitive()
                    .font(WidgetTheme.Font.caption2).foregroundStyle(WidgetTheme.activitySecondary)
                    .lineLimit(1).truncationMode(.tail)
            }
            if !isStale {
                Text(approval.explanation).privacySensitive()
                    .font(WidgetTheme.Font.caption2).foregroundStyle(WidgetTheme.activitySecondary)
                    .lineLimit(compact ? 1 : 2).truncationMode(.tail)
            }
            actions
        }
    }

    @ViewBuilder private var actions: some View {
        if isStale || approval.question {
            if let url = approval.openURL {
                Link(destination: url) { label("Open", prominent: true) }
            }
        } else {
            HStack(spacing: 8) {
                Button(intent: AnswerApprovalIntent(requestID: approval.requestID, approve: false)) {
                    label("Deny", prominent: false)
                }.buttonStyle(.plain)
                Button(intent: AnswerApprovalIntent(requestID: approval.requestID, approve: true)) {
                    label("Approve", prominent: true)
                }.buttonStyle(.plain)
            }
        }
    }

    private func label(_ title: String, prominent: Bool) -> some View {
        Text(title).font(WidgetTheme.Font.caption.weight(.semibold))
            .foregroundStyle(prominent ? Color.black : WidgetTheme.activityText)
            .frame(maxWidth: .infinity, minHeight: compact ? 30 : 34)
            .background(prominent ? WidgetTheme.accent : Color.white.opacity(0.12), in: Capsule())
            .contentShape(Capsule())
    }
}
