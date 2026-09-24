import PhrenKit
import SwiftUI

/// Claude Code's plan review in the timeline: the plan as it was written,
/// the first screenful with the rest in the reader, and how it was answered.
struct ChatPlanCard: View, Equatable {
    let plan: AgentPlanPresentation
    let entry: ChatTimelineEntry
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var opened = false
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.plan == rhs.plan && lhs.entry == rhs.entry }
    /// While the answer is pending the review card below carries the plan
    /// and the buttons; this row folds to its header so the plan is not on
    /// screen twice. A tap opens it — the review may have gone elsewhere.
    private var folded: Bool { plan.state == .pending && !opened }
    var body: some View {
        VStack(alignment: .leading, spacing: PhrenDensity.toolCardRowSpacing) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { opened.toggle() }
            } label: {
                ToolCardHeader(icon: "map", title: "Plan ready for review", status: status, compact: folded) {
                    Text(stateLabel).font(folded ? PhrenTypography.footnote.weight(.medium) : .caption.weight(.medium)).lineLimit(1)
                        .foregroundStyle(plan.state == .pending ? PhrenTheme.warning : PhrenTheme.textMuted)
                    if plan.state == .pending {
                        Image(systemName: "chevron.down").font(.system(size: folded ? 12 : 10, weight: .semibold))
                            .rotationEffect(.degrees(opened ? 180 : 0)).foregroundStyle(PhrenTheme.phrenCardAccent)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(plan.state != .pending)
            .accessibilityLabel("Plan ready for review, \(stateLabel)")
            .accessibilityValue(folded ? "Collapsed" : "Expanded")
            if !folded, let preview = entry.card?.markdownPreview {
                ChatPlanBody(plan: plan.plan, preview: preview, cacheKey: entry.cardMarkdownKey, id: entry.callID)
            }
        }
        .toolCard(collapsed: folded)
        .toolCardMarker("chat-plan-card:\(entry.callID)", label: "Plan ready for review, \(stateLabel)")
    }
    private var status: ToolCardStatus? {
        switch plan.state {
        case .pending: return .running
        case .approved: return .done
        case .rejected: return nil
        }
    }
    private var stateLabel: String {
        switch plan.state {
        case .pending: return "Awaiting your answer"
        case .approved: return "Approved"
        case .rejected: return "Kept planning"
        }
    }
}

/// The plan's markdown, cut to a screenful; Read full plan opens the rest.
private struct ChatPlanBody: View {
    let plan: String
    let preview: ToolOutputPreview
    let cacheKey: String
    let id: String
    @Environment(\.openToolOutput) private var openOutput
    var body: some View {
        ChatRichText(text: preview.text, cacheKey: cacheKey).equatable()
        if preview.truncated {
            Button("Read full plan") { openOutput(.init(title: "Plan", text: plan)) }
                .font(.caption).foregroundStyle(PhrenTheme.accent)
                .accessibilityIdentifier("chat-plan-full:\(id)")
        }
    }
}

/// The review itself, pinned above the composer while Claude waits: Approve
/// plan lets it build, Keep planning sends it back (the permission is
/// denied), both through the ordinary approval reply.
struct ChatPlanApprovalCard: View {
    let plan: AgentPlanPresentation
    let id: String
    let busy: Bool
    let answer: (Bool) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ToolCardHeader(icon: "map", title: "Plan ready for review")
            ChatPlanBody(plan: plan.plan, preview: ToolOutputPreview(plan.plan, lines: 14, characters: 2_000),
                         cacheKey: "plan-approval:\(id)|\(plan.plan.utf8.count)", id: id)
            if typeSize.isAccessibilitySize {
                VStack(spacing: 12) { keep; approve }.disabled(busy)
            } else {
                HStack { keep; Spacer(); approve }.disabled(busy)
            }
            if busy { ProgressView() }
        }
        .padding(16).phrenCard()
        .toolCardMarker("chat-plan-card:\(id)", label: "Plan ready for review, awaiting your answer")
    }
    private var keep: some View {
        Button { answer(false) } label: {
            Text("Keep planning").lineLimit(1).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.bordered).accessibilityIdentifier("chat-plan-keep")
    }
    private var approve: some View {
        Button { answer(true) } label: {
            Text("Approve plan").lineLimit(1).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.borderedProminent).tint(PhrenTheme.cyan).accessibilityIdentifier("chat-plan-approve")
    }
}

/// EnterPlanMode: a mode change, one system line like a slash command.
struct ChatPlanModeChip: View {
    let id: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "map").font(.system(size: 10, weight: .semibold)).foregroundStyle(PhrenTheme.chatNeutralDim)
                .frame(width: 14).accessibilityHidden(true)
            Text("Entered plan mode").font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.textSecondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Entered plan mode")
        .accessibilityIdentifier("chat-plan-mode:\(id)")
    }
}
