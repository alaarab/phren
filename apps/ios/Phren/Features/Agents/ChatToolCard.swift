import PhrenKit
import SwiftUI

/// The agent's own bookkeeping calls, each drawn as a card of its own: one
/// view per `ToolCardKind` case. Add a case there, a view here.
struct ChatToolCard: View, Equatable {
    let entry: ChatTimelineEntry
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.entry == rhs.entry }
    var body: some View {
        ChatPerformance.measure("tool card row") { content }
    }
    @ViewBuilder private var content: some View {
        switch entry.card {
        case .agent(let agent): ChatAgentCard(agent: agent, entry: entry)
        case .todos(let list): ChatTodoCard(list: list, entry: entry)
        case .plan(let plan): ChatPlanCard(plan: plan, entry: entry)
        case .planMode: ChatPlanModeChip(id: entry.callID)
        case .web(let web): WebToolCard(presentation: web, messages: entry.messages, markdownKey: entry.cardMarkdownKey)
        case .skill(let skill): SkillChip(presentation: skill, messages: entry.messages)
        case .mcp(let mcp): MCPToolCard(presentation: mcp, messages: entry.messages)
        case nil: EmptyView()
        }
    }
}

extension ChatTimelineEntry {
    /// The call's id, for the card's identifier; the message id where the
    /// transcript has none.
    var callID: String { messages.first?.toolCallID ?? messages.first?.id ?? "" }
    /// The key a card's markdown is parsed under — the same in the
    /// preparation pass and in the row, so the row never parses.
    var cardMarkdownKey: String { "\(messages.first?.renderKey ?? "")|\(messages.last?.renderKey ?? "")|card" }
}

/// PhrenToolCard's look for the agent's own cards: the same surface, border
/// and radius, so the phren, agent, todo and plan cards read as one family.
struct ToolCardChrome: ViewModifier {
    var collapsed = false
    func body(content: Content) -> some View {
        if collapsed {
            content
                .padding(.horizontal, 12).frame(height: 44).frame(maxWidth: .infinity, alignment: .leading)
                .background(PhrenTheme.phrenCardSurface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium))
                .overlay(RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium).strokeBorder(PhrenTheme.phrenCardBorder, lineWidth: 0.5))
        } else {
            content
                .padding(PhrenDensity.toolCardPadding).frame(maxWidth: .infinity, alignment: .leading)
                .background(PhrenTheme.phrenCardSurface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium))
                .overlay(RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium).strokeBorder(PhrenTheme.phrenCardBorder, lineWidth: 0.5))
        }
    }
}
extension View {
    func toolCard(collapsed: Bool = false) -> some View { modifier(ToolCardChrome(collapsed: collapsed)) }
    /// The card's identifier on a 1×1 element over its corner: stamped on
    /// the container it would hide the children from tests and VoiceOver.
    func toolCardMarker(_ id: String, label: String) -> some View {
        overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement()
                .accessibilityLabel(label).accessibilityIdentifier(id)
        }
    }
}

enum ToolCardStatus { case running, done, failed }

/// A glyph, the title, and how the call stands — the row every card opens with.
struct ToolCardHeader<Trailing: View>: View {
    let icon: String
    let title: String
    var status: ToolCardStatus? = nil
    var compact = false
    @ViewBuilder var trailing: () -> Trailing
    init(icon: String, title: String, status: ToolCardStatus? = nil, compact: Bool = false,
         @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.icon = icon; self.title = title; self.status = status; self.compact = compact; self.trailing = trailing
    }
    var body: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            Image(systemName: icon).font(.system(size: compact ? 14 : 15, weight: .medium)).foregroundStyle(PhrenTheme.phrenCardAccent)
                .frame(width: compact ? 18 : 22, height: compact ? 18 : 22).accessibilityHidden(true)
            Text(title).font(compact ? PhrenTypography.footnote.weight(.semibold) : .subheadline.weight(.semibold))
                .foregroundStyle(PhrenTheme.text).lineLimit(compact ? 1 : 2)
            Spacer(minLength: 0)
            trailing()
            Group {
                switch status {
                case .running:
                    Image(systemName: "ellipsis").foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Running")
                case .done:
                    Image(systemName: "checkmark").foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Completed")
                case .failed:
                    Image(systemName: "exclamationmark.circle").foregroundStyle(PhrenTheme.danger).accessibilityLabel("Failed")
                case nil: EmptyView()
                }
            }
            .font(.system(size: compact ? 12 : 15, weight: .medium))
        }
        .frame(height: compact ? 44 : nil)
    }
}

/// A small capsule — the model an agent ran on, "background".
struct ToolCardChip: View {
    let text: String
    var body: some View {
        Text(text).font(.caption.weight(.medium)).lineLimit(1)
            .foregroundStyle(PhrenTheme.sessionProject)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(PhrenTheme.sessionProject.opacity(0.1), in: Capsule())
    }
}
