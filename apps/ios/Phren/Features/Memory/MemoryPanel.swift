import PhrenKit
import SwiftUI

/// The bottom panel of Memory: the scope's contents, search results, or one
/// header line under the web dossier while a node is selected. Three heights,
/// changed by dragging or tapping the header; the graph stays live above it.
struct MemoryPanel: View {
    enum Mode: Equatable {
        case loading
        case contents
        case results
        case dossier(GraphNodeRef)
    }

    let mode: Mode
    /// The height the owner shows now; collapsed while loading or selected.
    let shown: MemoryPanelHeight
    let available: CGFloat
    @Binding var dragHeight: CGFloat?
    let title: String
    /// The focused node's label while the graph draws its neighbourhood.
    let focus: String?
    let counts: MemoryCounts
    let rows: [MemoryItem]
    let showProject: Bool
    let groupByProject: Bool
    let searching: Bool
    let emptyText: String
    @Binding var content: MemoryContent
    @Binding var topic: String?
    let freshness: MemoryFreshness
    let highlightedID: String?
    @Binding var scrollTarget: String?
    let canWrite: (MemoryItem) -> Bool
    let onHeight: (MemoryPanelHeight) -> Void
    let onSelect: (MemoryItem) -> Void
    let onMove: (MemoryItem, TaskMove) -> Void
    let onEdit: (MemoryItem) -> Void
    let onDelete: (MemoryItem) -> Void
    let onActions: (MemoryItem) -> Void
    let onShowInList: () -> Void
    let onClearFocus: () -> Void
    let onPull: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var dragBase: CGFloat?

    static let collapsedHeight: CGFloat = 56

    static func points(_ height: MemoryPanelHeight, available: CGFloat, collapsed: CGFloat = collapsedHeight) -> CGFloat {
        switch height {
        case .collapsed: return min(collapsed, available)
        case .half: return min(available, max(collapsed, available * 0.45))
        case .full: return available
        }
    }

    private var interactive: Bool {
        switch mode {
        case .contents, .results: return true
        case .loading, .dossier: return false
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            switch mode {
            case .contents, .results: list
            case .loading, .dossier: Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(PhrenTheme.surface, in: UnevenRoundedRectangle(
            topLeadingRadius: PhrenTheme.Radius.large, topTrailingRadius: PhrenTheme.Radius.large, style: .continuous))
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: PhrenTheme.Radius.large, topTrailingRadius: PhrenTheme.Radius.large, style: .continuous))
        .phrenContainerMarker("memory-panel", label: "Memory panel", value: shown.rawValue)
        .phrenContainerMarker("memory-panel-height", label: "Memory panel height", value: shown.rawValue)
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 0) {
            Capsule().fill(interactive ? PhrenTheme.textDim : PhrenTheme.border)
                .frame(width: 32, height: 4).padding(.top, 6)
                .accessibilityHidden(true)
            HStack(alignment: .center, spacing: PhrenTheme.Space.small) {
                headerText
                Spacer(minLength: PhrenTheme.Space.xs)
                headerTrailing
            }
            .padding(.leading, PhrenTheme.Space.large).padding(.trailing, PhrenTheme.Space.small)
            .frame(minHeight: Self.collapsedHeight - 10)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { if interactive { onHeight(nextOnTap) } }
        .gesture(interactive ? dragGesture : nil)
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Expand") { if interactive { onHeight(shown == .full ? .full : shown == .half ? .full : .half) } }
        .accessibilityAction(named: "Collapse") { if interactive { onHeight(.collapsed) } }
    }

    @ViewBuilder private var headerText: some View {
        switch mode {
        case .loading:
            Text("Loading…").font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
        case .contents:
            VStack(alignment: .leading, spacing: 1) {
                Text(focus.map { "Focus: \($0)" } ?? title)
                    .font(PhrenTypography.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                    .lineLimit(1)
                Text(counts.line).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1).monospacedDigit()
                    .phrenIdentifier("memory-panel-counts")
            }
            .fixedSize(horizontal: false, vertical: true)
        case .results:
            Text(resultsTitle).font(PhrenTypography.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                .monospacedDigit().phrenIdentifier("memory-panel-results")
        case .dossier(let node):
            HStack(spacing: PhrenTheme.Space.small) {
                PhrenChip(text: MemoryRowCard.kindTitle(for: node), color: MemoryRowCard.kindColor(for: node))
                if let project = node.project, !node.isProject {
                    Text(project).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.sessionProject).lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder private var headerTrailing: some View {
        switch mode {
        case .dossier:
            Button(action: onShowInList) {
                HStack(spacing: PhrenTheme.Space.xs) {
                    Image(systemName: "list.bullet").font(PhrenTypography.icon(12, weight: .semibold)).accessibilityHidden(true)
                    Text("Show in list")
                }
                .font(PhrenTypography.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.accent)
                .padding(.horizontal, PhrenTheme.Space.medium).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).phrenIdentifier("memory-show-in-list")
        case .contents, .results:
            if focus != nil, mode == .contents {
                Button(action: onClearFocus) {
                    Image(systemName: "xmark").font(PhrenTypography.icon(12, weight: .semibold))
                        .foregroundStyle(PhrenTheme.textSecondary).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("Show full view").phrenIdentifier("memory-focus-clear")
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                if freshness.isStale(now: context.date) {
                    Button(action: onPull) {
                        HStack(spacing: PhrenTheme.Space.xs) {
                            Circle().fill(freshness.hasError ? PhrenTheme.danger : PhrenTheme.warning)
                                .frame(width: 6, height: 6).accessibilityHidden(true)
                            Text(freshness.text(now: context.date)).font(PhrenTypography.caption)
                                .foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                        }
                        .padding(.horizontal, PhrenTheme.Space.small).frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(["Store", freshness.text(now: context.date), "Pull now"].joined(separator: ", "))
                    .phrenIdentifier("memory-stale")
                }
            }
        case .loading:
            EmptyView()
        }
    }

    private var resultsTitle: String {
        if rows.isEmpty { return searching ? "Searching…" : "No matches" }
        return "\(rows.count) result\(rows.count == 1 ? "" : "s")"
    }

    private var nextOnTap: MemoryPanelHeight {
        switch shown {
        case .collapsed: return .half
        case .half: return .full
        case .full: return .half
        }
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .global)
            .onChanged { value in
                let base = dragBase ?? Self.points(shown, available: available)
                dragBase = base
                dragHeight = min(available, max(Self.collapsedHeight, base - value.translation.height))
            }
            .onEnded { value in
                let base = dragBase ?? Self.points(shown, available: available)
                let projected = min(available, max(Self.collapsedHeight, base - value.predictedEndTranslation.height))
                let nearest = MemoryPanelHeight.allCases.min {
                    abs(Self.points($0, available: available) - projected) < abs(Self.points($1, available: available) - projected)
                } ?? .half
                dragBase = nil
                dragHeight = nil
                onHeight(nearest)
            }
    }

    // MARK: - List

    private var list: some View {
        VStack(spacing: 0) {
            if mode == .contents {
                // A chip tap chooses fresh; a topic row set both together.
                PhrenChipRow(items: Self.contentOptions,
                             selection: Binding(get: { content }, set: { content = $0; topic = nil }),
                             identifier: "memory-filter", raised: true)
                    .padding(.horizontal, PhrenTheme.Space.large).padding(.bottom, PhrenTheme.Space.xs)
                if let topic {
                    HStack(spacing: PhrenTheme.Space.small) {
                        Text("Topic").font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                        PhrenChip(text: MemoryBrowsing.topicLabel(topic), color: PhrenTheme.lavender)
                        Spacer(minLength: 0)
                        Button { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { self.topic = nil } } label: {
                            Image(systemName: "xmark").font(PhrenTypography.icon(12, weight: .semibold))
                                .foregroundStyle(PhrenTheme.textSecondary).frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).accessibilityLabel("Show every topic").phrenIdentifier("memory-topic-clear")
                    }
                    .padding(.leading, PhrenTheme.Space.large).padding(.trailing, PhrenTheme.Space.small)
                }
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: PhrenTheme.Space.xs) {
                        if rows.isEmpty {
                            Text(mode == .results ? (searching ? "Searching…" : "No matches") : emptyText)
                                .font(PhrenTypography.body).foregroundStyle(PhrenTheme.textMuted)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .padding(.horizontal, PhrenTheme.Space.xs)
                                .phrenIdentifier("memory-empty")
                        } else if groupByProject {
                            ForEach(MemoryBrowsing.grouped(rows), id: \.project) { group in
                                Text(group.project).plainListSectionLabel()
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .phrenIdentifier("memory-section:\(group.project)")
                                cards(group.rows, showProject: true)
                            }
                        } else {
                            cards(rows, showProject: true)
                        }
                    }
                    .padding(.horizontal, PhrenTheme.Space.medium).padding(.top, PhrenTheme.Space.xs).padding(.bottom, PhrenTheme.Space.medium)
                }
                .scrollDismissesKeyboard(.interactively)
                .phrenIdentifier("memory-list")
                .onChange(of: scrollTarget, initial: true) { _, target in
                    guard let target else { return }
                    // The list may have just replaced the dossier line; let it lay out first.
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(60))
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { proxy.scrollTo(target, anchor: .top) }
                        scrollTarget = nil
                    }
                }
            }
        }
    }

    private func cards(_ items: [MemoryItem], showProject: Bool) -> some View {
        ForEach(items) { item in
            MemoryRowCard(item: item, showProject: self.showProject && showProject,
                          highlighted: highlightedID == item.id, canWrite: canWrite(item),
                          onSelect: { onSelect(item) }, onMove: { onMove(item, $0) },
                          onEdit: { onEdit(item) }, onDelete: { onDelete(item) }, onActions: { onActions(item) })
                .id(item.id)
        }
    }

    static let contentOptions: [PhrenOption<MemoryContent>] = MemoryContent.allCases.map {
        PhrenOption(id: $0.id, value: $0, title: $0.rawValue)
    }
}

/// One row for a finding, note, task, topic or project: two lines of text and
/// a meta line of chips. Swiping reveals the row's actions; a long press
/// opens the same actions as a sheet.
struct MemoryRowCard: View {
    let item: MemoryItem
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
                PhrenIconButton(icon: "ellipsis", label: ["Actions", item.text].joined(separator: ", "), action: onActions)
                    .phrenIdentifier("\(item.rowIdentifier):actions")
                    .padding(.trailing, 2)
                    .padding(.top, 2)
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
        PhrenChip(text: Self.kindTitle(for: item), color: Self.kindColor(for: item))
        if let tag = item.typeTag {
            PhrenChip(text: tag, color: item.kind == .task ? Self.priorityColor(tag) : PhrenTheme.chipColor(.type))
        }
        if showProject, item.kind != .project, !item.project.isEmpty {
            PhrenChip(text: item.project, role: .project)
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
