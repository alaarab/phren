import PhrenKit
import SwiftUI

/// The list-mode body of Memory: the current filters' counts line, then one
/// row per finding, note, task or topic. Grouped by project when the project
/// filter is not a single project. Tapping a row switches to the map with the
/// node selected; the row's action glyph opens the same sheet as before.
struct MemoryPanel: View {
    let rows: [MemoryItem]
    let counts: MemoryCounts
    let countKinds: Set<MemoryKind>
    let groupByProject: Bool
    let showKind: Bool
    let emptyText: String
    let highlightedID: String?
    @Binding var scrollTarget: String?
    let canWrite: (MemoryItem) -> Bool
    let onSelect: (MemoryItem) -> Void
    let onMove: (MemoryItem, TaskMove) -> Void
    let onEdit: (MemoryItem) -> Void
    let onDelete: (MemoryItem) -> Void
    let onActions: (MemoryItem) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: PhrenTheme.Space.xs) {
                    countsLine
                    if rows.isEmpty {
                        Text(emptyText)
                            .font(PhrenTypography.body).foregroundStyle(PhrenTheme.textMuted)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .phrenIdentifier("memory-empty")
                    } else if groupByProject {
                        ForEach(MemoryBrowsing.grouped(rows), id: \.project) { group in
                            Text(group.project).plainListSectionLabel()
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .phrenIdentifier("memory-section:\(group.project)")
                            cards(group.rows)
                        }
                    } else {
                        cards(rows)
                    }
                }
                .padding(.horizontal, PhrenTheme.Space.medium)
                .padding(.top, PhrenTheme.Space.small)
                .padding(.bottom, PhrenTheme.Space.medium)
            }
            .scrollDismissesKeyboard(.interactively)
            .phrenIdentifier("memory-list")
            .onChange(of: scrollTarget, initial: true) { _, target in
                guard let target else { return }
                // The list may have just replaced the map; let it lay out first.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(60))
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { proxy.scrollTo(target, anchor: .top) }
                    scrollTarget = nil
                }
            }
        }
    }

    private var countsLine: some View {
        Text(counts.line(for: countKinds))
            .font(PhrenTypography.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.text)
            .monospacedDigit().lineLimit(2)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .phrenIdentifier("memory-counts")
    }

    private func cards(_ items: [MemoryItem]) -> some View {
        ForEach(items) { item in
            MemoryRowCard(item: item, showKind: showKind, showProject: false,
                          highlighted: highlightedID == item.id, canWrite: canWrite(item),
                          onSelect: { onSelect(item) }, onMove: { onMove(item, $0) },
                          onEdit: { onEdit(item) }, onDelete: { onDelete(item) }, onActions: { onActions(item) })
                .id(item.id)
        }
    }
}

/// One row for a finding, note, task, topic or project: two lines of text and
/// a meta line of chips. Swiping reveals the row's actions; a long press
/// opens the same actions as a sheet.
struct MemoryRowCard: View {
    let item: MemoryItem
    let showKind: Bool
    let showProject: Bool
    let highlighted: Bool
    let canWrite: Bool
    let onSelect: () -> Void
    let onMove: (TaskMove) -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onActions: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var offset: CGFloat = 0
    @GestureState private var dragOffset: CGFloat = 0

    private struct RowAction: Identifiable {
        let id: String
        let title: String
        let color: Color
        let onColor: Color
        let run: () -> Void
    }

    private var actions: [RowAction] {
        guard canWrite else { return [] }
        switch item.kind {
        case .task:
            var actions: [RowAction] = []
            if item.section != .done {
                actions.append(RowAction(id: "done", title: "Done", color: PhrenTheme.success, onColor: PhrenTheme.bg) { onMove(.done) })
            }
            if item.section != .queue {
                actions.append(RowAction(id: "backlog", title: "Backlog", color: PhrenTheme.surfaceRaised, onColor: PhrenTheme.textSecondary) { onMove(.backlog) })
            }
            return actions
        case .finding:
            return [
                RowAction(id: "edit", title: "Edit", color: PhrenTheme.surfaceRaised, onColor: PhrenTheme.textSecondary, run: onEdit),
                RowAction(id: "delete", title: "Delete", color: PhrenTheme.danger, onColor: PhrenTheme.onAccent, run: onDelete),
            ]
        case .note, .topic, .project:
            return []
        }
    }

    private var stripWidth: CGFloat { CGFloat(actions.count) * 72 }
    private var presentedOffset: CGFloat { min(0, max(-stripWidth, offset + dragOffset)) }
    private var isOpen: Bool { presentedOffset < 0 }

    var body: some View {
        ZStack(alignment: .trailing) {
            if !actions.isEmpty { strip }
            card
                .offset(x: presentedOffset)
                .simultaneousGesture(actions.isEmpty ? nil : swipeGesture)
        }
        .clipShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium, style: .continuous))
    }

    private var card: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.text)
                    .font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if dynamicTypeSize.isAccessibilitySize {
                    PhrenFlowLayout(spacing: 6) { chips }
                } else {
                    HStack(spacing: 6) {
                        chips
                        Spacer(minLength: PhrenTheme.Space.xs)
                        if let date = item.date {
                            Text(date).font(PhrenTypography.caption2).foregroundStyle(PhrenTheme.textDim).monospacedDigit()
                        }
                    }
                    .frame(minHeight: 28)
                }
            }
            .padding(.horizontal, PhrenTheme.Space.medium).padding(.vertical, PhrenTheme.Space.small)
            .padding(.trailing, hasActionMenu ? 40 : 0)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { if isOpen { close() } else { onSelect() } }
            .onLongPressGesture(minimumDuration: 0.45) { if hasActionMenu { onActions() } }
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAction { onSelect() }
            .phrenIdentifier(item.rowIdentifier)
            if hasActionMenu {
                Button(action: onActions) {
                    Image(systemName: "ellipsis")
                        .font(PhrenTypography.icon(16, weight: .semibold))
                        .foregroundStyle(PhrenTheme.accent)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(["Actions", item.text].joined(separator: ", "))
                .phrenIdentifier("\(item.rowIdentifier):actions")
            }
        }
        .sessionCard()
        .overlay {
            if highlighted {
                RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium, style: .continuous)
                    .strokeBorder(PhrenTheme.accent, lineWidth: 2)
                    .accessibilityHidden(true)
            }
        }
    }

    private var hasActionMenu: Bool { item.kind != .topic }

    @ViewBuilder private var chips: some View {
        if showKind {
            PhrenChip(text: Self.kindTitle(for: item), color: Self.kindColor(for: item))
        }
        if let tag = item.typeTag {
            PhrenChip(text: tag, color: item.kind == .task ? Self.priorityColor(tag) : PhrenTheme.chipColor(.type))
        }
        if showProject, item.kind != .project, !item.project.isEmpty {
            PhrenChip(text: item.project, color: PhrenTheme.projectColor(storeId: item.storeId, project: item.project))
        }
        if let detail = item.detail {
            Text(detail).font(PhrenTypography.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
        }
        if dynamicTypeSize.isAccessibilitySize, let date = item.date {
            Text(date).font(PhrenTypography.caption2).foregroundStyle(PhrenTheme.textDim).monospacedDigit()
        }
    }

    private var accessibilityLabel: String {
        var parts = [item.text, Self.kindTitle(for: item)]
        if let tag = item.typeTag { parts.append(tag) }
        if showProject, !item.project.isEmpty { parts.append(item.project) }
        if let detail = item.detail { parts.append(detail) }
        if let date = item.date { parts.append(date) }
        return parts.joined(separator: ", ")
    }

    private var strip: some View {
        HStack(spacing: 0) {
            ForEach(actions) { action in
                Button {
                    close()
                    action.run()
                } label: {
                    Text(action.title)
                        .font(PhrenTypography.subheadline.weight(.medium))
                        .foregroundStyle(action.onColor)
                        .frame(width: 72).frame(maxHeight: .infinity)
                        .background(action.color).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .phrenIdentifier("\(item.rowIdentifier):\(action.id)")
            }
        }
        .frame(minHeight: 44)
        .allowsHitTesting(isOpen)
        .accessibilityHidden(!isOpen)
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($dragOffset) { value, state, _ in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                state = value.translation.width
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let projected = offset + value.predictedEndTranslation.width
                let open = projected < -stripWidth / 2
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { offset = open ? -stripWidth : 0 }
            }
    }

    private func close() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { offset = 0 }
    }

    // MARK: - Kind vocabulary shared with the dossier header

    static func kindTitle(for item: MemoryItem) -> String {
        switch item.kind {
        case .task:
            switch item.section {
            case .queue: return "Backlog"
            case .active: return "Active"
            case .done: return "Done"
            case nil: return "Task"
            }
        case .finding: return "finding"
        case .note: return "note"
        case .topic: return "topic"
        case .project: return "project"
        }
    }

    static func kindColor(for item: MemoryItem) -> Color {
        switch item.kind {
        case .finding: return PhrenTheme.warning
        case .note: return PhrenTheme.cyan
        case .task: return item.section == .done ? PhrenTheme.textMuted : PhrenTheme.success
        case .topic: return PhrenTheme.lavender
        case .project: return PhrenTheme.sessionProject
        }
    }

    static func kindTitle(for node: GraphNodeRef) -> String {
        if node.isTask { return node.group == "task-active" ? "Active" : "Backlog" }
        if node.isFinding { return "finding" }
        return "project"
    }

    static func kindColor(for node: GraphNodeRef) -> Color {
        if node.isTask { return PhrenTheme.success }
        if node.isFinding { return PhrenTheme.warning }
        return PhrenTheme.sessionProject
    }

    static func priorityColor(_ raw: String) -> Color {
        PhrenTask.Priority(rawValue: raw)?.color ?? PhrenTheme.textDim
    }
}

extension GraphNodeRef {
    var isProject: Bool { group == "project" }
}
