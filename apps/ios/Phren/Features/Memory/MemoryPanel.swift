import PhrenKit
import SwiftUI

/// The list-mode body of Memory: the current filters' counts line, then one
/// row per finding, note, task or topic, grouped by project when the model
/// says so. Tapping a row switches to the map with the node selected; the
/// row's action glyph opens the same sheet as before.
struct MemoryPanel: View {
    let rows: [MemoryItem]
    /// Project groups from `MemoryListModel`, or nil for a flat list.
    let groups: [(project: String, rows: [MemoryItem])]?
    let counts: MemoryCounts
    let countKinds: Set<MemoryKind>
    let showKind: Bool
    let showProject: Bool
    let emptyText: String
    let highlightedID: String?
    @Binding var scrollTarget: String?
    let onSelect: (MemoryItem) -> Void
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
                    } else if let groups {
                        ForEach(groups, id: \.project) { group in
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
            .onAppear {
                // The list may have just replaced the map with a target already set.
                if let target = scrollTarget { scheduleScroll(target, proxy: proxy) }
            }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                scheduleScroll(target, proxy: proxy)
            }
        }
    }

    private func scheduleScroll(_ target: String, proxy: ScrollViewProxy) {
        // The list may have just replaced the map; let it lay out first.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            guard scrollTarget == target, !Task.isCancelled else { return }
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { proxy.scrollTo(target, anchor: .top) }
            scrollTarget = nil
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
            MemoryRowCard(item: item, showKind: showKind, showProject: showProject,
                          highlighted: highlightedID == item.id,
                          onSelect: { onSelect(item) }, onActions: { onActions(item) })
                .equatable()
                .id(item.id)
        }
    }
}

extension MemoryRowCard: Equatable {
    /// What the row draws; the tap closures are excluded, so a parent redraw
    /// only rebuilds the rows whose item or flags actually changed.
    static func == (lhs: MemoryRowCard, rhs: MemoryRowCard) -> Bool {
        lhs.item == rhs.item && lhs.showKind == rhs.showKind
            && lhs.showProject == rhs.showProject && lhs.highlighted == rhs.highlighted
    }
}

/// One row for a finding, note, task, topic or project: two lines of text and
/// a meta line of chips. The action glyph, or a long press, opens the row's
/// actions as a sheet.
struct MemoryRowCard: View {
    let item: MemoryItem
    let showKind: Bool
    let showProject: Bool
    let highlighted: Bool
    let onSelect: () -> Void
    let onActions: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if highlighted {
            card.overlay {
                RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium, style: .continuous)
                    .strokeBorder(PhrenTheme.accent, lineWidth: 2)
                    .accessibilityHidden(true)
            }
        } else {
            card
        }
    }

    private var card: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.text)
                    .font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if hasMetaLine {
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
            }
            .padding(.horizontal, PhrenTheme.Space.medium).padding(.vertical, PhrenTheme.Space.small)
            .padding(.trailing, hasActionMenu ? 40 : 0)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: onSelect)
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
    }

    private var hasActionMenu: Bool { item.kind != .topic }

    /// Whether the meta line has anything to draw. When it does not, the line
    /// is skipped outright (no 28pt spacer), so a bare row is two text lines
    /// plus its padding.
    private var hasMetaLine: Bool {
        Self.hasMetaLine(item: item, showKind: showKind, showProject: showProject)
    }

    static func hasMetaLine(item: MemoryItem, showKind: Bool, showProject: Bool) -> Bool {
        if showKind || item.kind == .task { return true }
        if item.typeTag != nil { return true }
        if showProject, item.kind != .project, !item.project.isEmpty { return true }
        if item.detail != nil { return true }
        return item.date != nil
    }

    @ViewBuilder private var chips: some View {
        // A task always shows its section chip (Active, Backlog, Done); the
        // other kinds show their kind chip only under the all-kinds filter.
        if showKind || item.kind == .task {
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
