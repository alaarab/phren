import PhrenKit
import SwiftUI

/// The agent's checklist: circle, half, check; the active item lit, done
/// items struck through. A list a later call replaced folds to one line —
/// "Todos · 2 of 5 done" — and opens on a tap, so the history stays and the
/// newest list is the one that reads in full.
struct ChatTodoCard: View {
    let list: AgentTodoPresentation
    let entry: ChatTimelineEntry
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    /// Items shown before "more"; a long list stays a card, not a page.
    private static let visibleItems = 12

    private var folded: Bool { entry.cardSuperseded && !expanded }
    private var visible: ArraySlice<AgentTodoPresentation.Item> {
        expanded ? list.items[...] : list.items.prefix(Self.visibleItems)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
            } label: {
                ToolCardHeader(icon: "checklist", title: list.title, compact: folded) {
                    Text(list.summary).font(folded ? PhrenTypography.footnote.monospacedDigit() : .caption.monospacedDigit())
                        .foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                    if entry.cardSuperseded {
                        Image(systemName: "chevron.down").font(.system(size: folded ? 12 : 10, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(PhrenTheme.phrenCardAccent)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(list.title), \(list.summary)")
            .accessibilityValue(folded ? "Collapsed" : "Expanded")
            .accessibilityHint(entry.cardSuperseded ? "A later list replaced this one" : "")
            if !folded {
                if let note = list.note {
                    Text(note).font(.caption).foregroundStyle(PhrenTheme.textSecondary).lineLimit(3)
                }
                ForEach(Array(visible.enumerated()), id: \.offset) { _, item in
                    ChatTodoRow(item: item)
                }
                if list.items.count > Self.visibleItems, !expanded {
                    Button("+\(list.items.count - Self.visibleItems) more") {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded = true }
                    }
                    .font(.caption).foregroundStyle(PhrenTheme.accent)
                    .accessibilityIdentifier("chat-todo-more:\(entry.callID)")
                }
            }
        }
        .toolCard(collapsed: folded)
        .toolCardMarker("chat-todo-card:\(entry.callID)",
                        label: "\(list.title), \(list.summary)" + (entry.cardSuperseded ? ", replaced by a later list" : ""))
    }
}

private struct ChatTodoRow: View {
    let item: AgentTodoPresentation.Item
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: glyph).font(.system(size: 13, weight: .medium)).foregroundStyle(tint)
                .frame(width: 16).accessibilityHidden(true)
            // The text stays its own element (tests and VoiceOver read the
            // item by name); the state rides along as its value.
            Text(item.text).font(.subheadline.weight(item.status == .active ? .medium : .regular))
                .strikethrough(item.status == .done, color: PhrenTheme.textMuted)
                .foregroundStyle(item.status == .done ? PhrenTheme.textMuted : item.status == .active ? PhrenTheme.text : PhrenTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityValue(label)
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
        .background(item.status == .active ? PhrenTheme.phrenCardAccent.opacity(0.12) : .clear,
                    in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
    }
    private var glyph: String {
        switch item.status {
        case .pending: return "circle"
        case .active: return "circle.lefthalf.filled"
        case .done: return "checkmark.circle.fill"
        }
    }
    private var tint: Color {
        switch item.status {
        case .pending: return PhrenTheme.textDim
        case .active: return PhrenTheme.phrenCardAccent
        case .done: return PhrenTheme.success
        }
    }
    private var label: String {
        switch item.status {
        case .pending: return "To do"
        case .active: return "In progress"
        case .done: return "Done"
        }
    }
}
