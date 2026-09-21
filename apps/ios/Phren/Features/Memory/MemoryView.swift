import PhrenKit
import SwiftUI

/// The Memory tab: the graph page with search and browsing folded into it.
/// The web renderer keeps its node dossier; the native panel below it owns
/// the scope's contents and the search results. Selection travels both ways
/// over the renderer's message bridge: a row tap issues `focus`, a canvas tap
/// arrives as `graphSelect`.
struct MemoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var storeId = ""
    /// Empty means every project of the store.
    @State private var project = ""
    @State private var content: MemoryContent = .all
    @State private var topic: String?
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @State private var payload: GraphPayload?
    @State private var payloadRevision = UUID()
    @State private var visible: GraphPayload?
    @State private var payloadJSON: String?
    @State private var nodes = MemoryBrowsing.NodeIndex(payload: nil)
    @State private var nodesRevision = UUID()
    @State private var contents: [MemoryItem] = []
    @State private var error: String?
    @State private var selection: GraphNodeRef?
    @State private var focusedNodeID: String?
    @State private var command: GraphCommand?
    @State private var rendererID = UUID()
    @State private var renderedScope: String?
    @State private var height: MemoryPanelHeight = .half
    @State private var dragHeight: CGFloat?
    @State private var results: [MemoryItem] = []
    @State private var searching = false
    @State private var scrollTarget: String?
    @State private var highlightedID: String?
    @State private var editing: MemoryEdit?
    @State private var deleting: MemoryDeletion?
    @State private var actionItem: MemoryItem?
    @State private var editingTask: TaskListRow?
    @State private var choosingStore = false
    @State private var projectRoute: ProjectRoute?
    @State private var taskRoute: TaskListRow?
    @State private var shareText: String?
    @State private var moving = false

    private var selectedStore: String {
        storeId.isEmpty ? (model.storeFilter ?? model.storeDescriptors.first?.id ?? "") : storeId
    }
    private var selectedProject: String? { project.isEmpty ? nil : project }
    private var snapshot: LocalStore.Snapshot { model.snapshot(for: selectedStore) }
    private var projects: [String] { snapshot.projects.map(\.name).sorted() }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var refreshKey: RefreshKey {
        RefreshKey(store: selectedStore, project: selectedProject, revision: snapshot.revision)
    }
    private var contentsKey: ContentsKey {
        ContentsKey(store: selectedStore, project: selectedProject, revision: snapshot.revision, nodes: nodesRevision)
    }
    private var searchRequest: SearchRequest {
        SearchRequest(query: trimmedQuery, store: selectedStore, project: selectedProject,
                      revision: model.searchRevision, nodes: nodesRevision)
    }

    private var mode: MemoryPanel.Mode {
        if let selection { return .dossier(selection) }
        if payload == nil, error == nil { return .loading }
        if !trimmedQuery.isEmpty { return .results }
        return .contents
    }

    private var shownHeight: MemoryPanelHeight {
        switch mode {
        case .loading, .dossier: return .collapsed
        case .contents, .results: return height
        }
    }

    /// While a node is focused the graph draws its neighbourhood, so the
    /// list keeps to the rows that neighbourhood draws.
    private var scopedContents: [MemoryItem] {
        focusedNodeID == nil ? contents : contents.filter { $0.nodeID != nil }
    }

    private var rows: [MemoryItem] {
        mode == .results ? results : MemoryBrowsing.filter(scopedContents, content: content, topic: topic)
    }

    private var emptyText: String {
        if scopedContents.isEmpty {
            return selectedProject.map { "Nothing saved for \($0) yet" } ?? "Nothing saved in \(selectedStore) yet"
        }
        return "No \(content == .all ? "rows" : content.rawValue.lowercased()) here"
    }

    private var freshness: MemoryFreshness {
        let status = model.storeContexts.first { $0.id == selectedStore }?.status ?? SyncEngine.Status()
        return MemoryFreshness(lastSyncedAt: status.lastSyncedAt, isSyncing: status.isSyncing, hasError: status.lastError != nil)
    }

    private var focusLabel: String? {
        guard let focusedNodeID else { return nil }
        return payload?.nodes.first { $0.id == focusedNodeID }?.label
    }

    var body: some View {
        PhrenNavigationStack {
            VStack(spacing: 0) {
                ActionErrorBanner()
                PhrenSearchField(text: $query, placeholder: "Search memory", identifier: "memory-search",
                                 focus: $searchFocused, onSubmit: submitSearch)
                    .padding(.horizontal, PhrenTheme.Space.large).padding(.top, PhrenTheme.Space.small)
                scopeRow
                    .padding(.horizontal, PhrenTheme.Space.large).padding(.vertical, PhrenTheme.Space.xs)
                GeometryReader { geometry in
                    let available = geometry.size.height
                    let panelPoints = dragHeight ?? MemoryPanel.points(shownHeight, available: available)
                    VStack(spacing: 0) {
                        graphArea.frame(height: max(0, available - panelPoints)).clipped()
                        panel(available: available).frame(height: panelPoints)
                    }
                    .animation(dragHeight == nil && !reduceMotion ? .easeOut(duration: 0.18) : nil, value: panelPoints)
                }
            }
            .background(PhrenTheme.bg)
            .navigationTitle("Memory")
            .navigationBarTitleDisplayMode(.inline)
            .disablesPanToGoBack()
            .navigationDestination(item: $projectRoute) { route in
                ProjectDetailView(storeId: route.storeId, project: route.project)
            }
            .navigationDestination(item: $taskRoute) { row in
                TaskDetailsSheet(row: row)
            }
            .task(id: refreshKey) { await rebuild() }
            .task(id: PresentationKey(revision: payloadRevision, filter: content.graphFilter, focus: focusedNodeID)) { await present() }
            .task(id: searchRequest) { await search() }
            .onChange(of: contentsKey, initial: true) { _, _ in refreshContents() }
            .onChange(of: project) { _, _ in
                selection = nil
                focusedNodeID = nil
                topic = nil
                highlightedID = nil
            }
            .onChange(of: query) { _, value in
                if !value.isEmpty, height == .collapsed { height = .half }
            }
            .onChange(of: searchFocused) { _, focused in
                if focused, height == .collapsed { height = .half }
            }
            .onChange(of: selection?.id) { previous, current in
                guard previous != nil, current == nil else { return }
                switch command?.action {
                case .reset, .reveal, .clear: break
                default: command = GraphCommand(action: .clear)
                }
            }
            .sheet(item: $editing) { edit in
                TextEntrySheet(title: edit.title, initialText: edit.text, confirmLabel: "Save") { text, _ in
                    await edit.save(text)
                }
            }
            .sheet(item: $editingTask) { row in TaskEditSheet(row: row) }
            .sheet(isPresented: $shareText.isPresent()) { ActivityView(activityItems: [shareText ?? ""]) }
        }
        .phrenActionSheet(isPresented: $choosingStore, title: "Store", actions: storeActions, identifier: "memory-store-sheet")
        .phrenActionSheet(isPresented: $actionItem.isPresent(), title: actionTitle, actions: rowActions, identifier: "memory-actions")
        .phrenDialog(isPresented: $deleting.isPresent(),
                     title: deleting?.isTask == true ? "Delete this task?" : "Delete this finding?",
                     message: deleting?.text ?? "", actions: deleteActions, identifier: "memory-delete")
    }

    // MARK: - Scope

    private var scopeRow: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: PhrenTheme.Space.xs))
            : AnyLayout(HStackLayout(spacing: PhrenTheme.Space.small))
        return layout {
            if model.hasMultipleStores {
                Button { choosingStore = true } label: {
                    HStack(spacing: PhrenTheme.Space.xs) {
                        Image(systemName: "externaldrive").font(PhrenTypography.icon(11, weight: .semibold)).accessibilityHidden(true)
                        Text(selectedStore).lineLimit(1)
                        Image(systemName: "chevron.down").font(PhrenTypography.icon(9, weight: .semibold)).accessibilityHidden(true)
                    }
                    .font(PhrenTypography.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.lavender)
                    .padding(.horizontal, PhrenTheme.Space.medium).frame(minHeight: 32)
                    .background(PhrenTheme.lavender.opacity(0.16), in: Capsule())
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(["Store", selectedStore].joined(separator: ", "))
                .phrenIdentifier("memory-store")
            }
            PhrenChipRow(items: scopeOptions, selection: $project, identifier: "memory-scope",
                         tint: { $0.isEmpty ? PhrenTheme.accent : PhrenTheme.projectColor(storeId: selectedStore, project: $0) })
        }
    }

    private var scopeOptions: [PhrenOption<String>] {
        [PhrenOption(id: "all", value: "", title: "All")] + projects.map { PhrenOption(id: $0, value: $0, title: $0) }
    }

    private var storeActions: [PhrenControlAction] {
        model.storeDescriptors.map { store in
            PhrenControlAction(id: store.id, title: store.id, icon: "externaldrive", isSelected: store.id == selectedStore) {
                switchStore(store.id)
            }
        }
    }

    private func switchStore(_ id: String) {
        guard id != selectedStore else { return }
        selection = nil
        focusedNodeID = nil
        highlightedID = nil
        topic = nil
        storeId = id
        project = ""
        payload = nil
        visible = nil
        payloadJSON = nil
        error = nil
    }

    // MARK: - Graph

    private var graphArea: some View {
        ZStack(alignment: .topTrailing) {
            PhrenTheme.bg
            if let visible, let json = payloadJSON, !visible.nodes.isEmpty {
                GraphWebView(payloadJSON: json, command: command,
                             onSelect: receiveSelection, onAction: handleGraphAction,
                             onError: { error = $0 })
                    .id(rendererID)
                    .accessibilityLabel("Interactive memory graph")
                cameraControls.padding(PhrenTheme.Space.medium)
            } else if visible == nil, error == nil {
                ProgressView().tint(PhrenTheme.textMuted).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let error {
                VStack(spacing: PhrenTheme.Space.medium) {
                    Text("Graph unavailable").font(PhrenTypography.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                    Text(error).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                        .multilineTextAlignment(.center)
                    Button {
                        self.error = nil
                        rendererID = UUID()
                        Task { await rebuild() }
                    } label: {
                        Text("Try again").font(PhrenTypography.body.weight(.medium)).foregroundStyle(PhrenTheme.accent)
                            .padding(.horizontal, PhrenTheme.Space.large).frame(minHeight: 44)
                            .background(PhrenTheme.surfaceRaised, in: Capsule()).contentShape(Capsule())
                    }
                    .buttonStyle(.plain).phrenIdentifier("memory-retry")
                }
                .padding(PhrenTheme.Space.section)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(PhrenTheme.bg)
            }
        }
    }

    private var cameraControls: some View {
        VStack(spacing: 2) {
            cameraButton("Zoom in", icon: "plus", action: .zoomIn)
            cameraButton("Zoom out", icon: "minus", action: .zoomOut)
            cameraButton("Fit graph", icon: "arrow.up.left.and.arrow.down.right", action: .reset)
        }
        .background(PhrenTheme.surface.opacity(0.92), in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PhrenTheme.Radius.large, style: .continuous).strokeBorder(PhrenTheme.border, lineWidth: 1))
    }

    private func cameraButton(_ title: String, icon: String, action: GraphCommand.Action) -> some View {
        Button { command = GraphCommand(action: action) } label: {
            Image(systemName: icon).font(PhrenTypography.icon(15, weight: .medium)).foregroundStyle(PhrenTheme.text)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(title)
    }

    // MARK: - Panel

    private func panel(available: CGFloat) -> some View {
        MemoryPanel(
            mode: mode, shown: shownHeight, available: available, dragHeight: $dragHeight,
            title: selectedProject ?? "All projects", focus: focusLabel,
            counts: MemoryBrowsing.counts(scopedContents), rows: rows,
            showProject: selectedProject == nil, groupByProject: mode == .results && selectedProject == nil,
            searching: searching, emptyText: emptyText, content: $content, topic: $topic,
            freshness: freshness, highlightedID: highlightedID, scrollTarget: $scrollTarget,
            canWrite: { model.canWrite(storeId: $0.storeId, project: $0.project) && !moving },
            onHeight: { height = $0 }, onSelect: open, onMove: move, onEdit: edit, onDelete: confirmDelete,
            onActions: { actionItem = $0 }, onShowInList: showInList, onClearFocus: clearFocus,
            onPull: { Task { await model.pullToRefresh() } }
        )
    }

    private func refreshContents() {
        contents = MemoryBrowsing.contents(snapshot: snapshot, storeId: selectedStore, project: selectedProject, nodes: nodes)
        if contents.isEmpty, payload != nil, height == .collapsed { height = .half }
    }

    private func submitSearch() {
        searchFocused = false
        if !trimmedQuery.isEmpty { height = .full }
    }

    // MARK: - Rows

    private func open(_ item: MemoryItem) {
        highlightedID = nil
        switch item.kind {
        case .topic:
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                content = .findings
                topic = item.key
            }
        case .project:
            if let id = item.nodeID { selectNode(id) }
        case .note:
            projectRoute = ProjectRoute(storeId: item.storeId, project: item.project)
        case .finding:
            if let id = item.nodeID { selectNode(id) } else { projectRoute = ProjectRoute(storeId: item.storeId, project: item.project) }
        case .task:
            if let id = item.nodeID { selectNode(id) } else {
                projectRoute = ProjectRoute(storeId: item.storeId, project: item.project)
            }
        }
    }

    private func taskRow(_ item: MemoryItem) -> TaskListRow? {
        guard let task = item.task else { return nil }
        return TaskListRow(storeId: item.storeId, storeName: model.storeName(for: item.storeId), project: item.project, task: task)
    }

    private func move(_ item: MemoryItem, using action: TaskMove) {
        guard !moving, let row = taskRow(item) else { return }
        moving = true
        Task {
            do {
                guard model.canWrite(storeId: row.storeId, project: row.project) else {
                    throw StoreWriteError.readOnly(row.storeName)
                }
                try await model.enqueue(action.operation(for: row), in: row.storeId)
            } catch {
                model.lastActionError = error.localizedDescription
            }
            await model.refresh()
            moving = false
        }
    }

    private func edit(_ item: MemoryItem) {
        switch item.kind {
        case .task:
            editingTask = taskRow(item)
        case .finding:
            guard let finding = item.finding else { return }
            editing = MemoryEdit(id: item.id, title: "Edit finding", text: finding.text) { text in
                await model.perform(.editFinding(
                    project: item.project, match: finding.stableId.map { "fid:\($0)" } ?? finding.text, newText: text
                ), in: item.storeId)
                selection = nil
            }
        case .note, .topic, .project:
            break
        }
    }

    private func confirmDelete(_ item: MemoryItem) {
        switch item.kind {
        case .task:
            guard let task = item.task else { return }
            deleting = MemoryDeletion(id: item.id, isTask: true, text: item.text) {
                await model.perform(.removeTask(project: item.project, match: task.stableId ?? task.line), in: item.storeId)
                selection = nil
            }
        case .finding:
            guard let finding = item.finding else { return }
            deleting = MemoryDeletion(id: item.id, isTask: false, text: item.text) {
                await model.perform(.removeFinding(
                    project: item.project, match: finding.stableId.map { "fid:\($0)" } ?? finding.text
                ), in: item.storeId)
                selection = nil
            }
        case .note, .topic, .project:
            break
        }
    }

    private var deleteActions: [PhrenControlAction] {
        guard let deleting else { return [PhrenControlAction(id: "keep", title: "Keep", role: .cancel) {}] }
        return [
            PhrenControlAction(id: "delete", title: "Delete", role: .destructive) { Task { await deleting.run() } },
            PhrenControlAction(id: "keep", title: "Keep", role: .cancel) {},
        ]
    }

    private var actionTitle: String {
        guard let item = actionItem else { return "" }
        return item.text.count > 80 ? String(item.text.prefix(77)) + "..." : item.text
    }

    private var rowActions: [PhrenControlAction] {
        guard let item = actionItem else { return [] }
        let writable = model.canWrite(storeId: item.storeId, project: item.project)
        var actions: [PhrenControlAction] = []
        if item.nodeID != nil {
            actions.append(PhrenControlAction(id: "graph", title: "Show on graph", icon: "point.3.connected.trianglepath.dotted") { open(item) })
        }
        switch item.kind {
        case .task:
            if let row = taskRow(item) {
                actions.append(PhrenControlAction(id: "details", title: "Task details", icon: "doc.text") { taskRoute = row })
                if writable {
                    for move in TaskMove.allCases where move.section != row.task.section {
                        actions.append(PhrenControlAction(id: move.rawValue.lowercased(), title: move.rawValue, icon: move.symbol) {
                            self.move(item, using: move)
                        })
                    }
                    actions.append(PhrenControlAction(id: "edit", title: "Edit", icon: "pencil") { edit(item) })
                    actions.append(PhrenControlAction(id: "delete", title: "Delete", icon: "trash", role: .destructive) { confirmDelete(item) })
                }
            }
        case .finding, .note:
            actions.append(PhrenControlAction(id: "project", title: "Open \(item.project)", icon: "square.grid.2x2") {
                projectRoute = ProjectRoute(storeId: item.storeId, project: item.project)
            })
            if writable, item.kind == .finding {
                actions.append(PhrenControlAction(id: "edit", title: "Edit", icon: "pencil") { edit(item) })
                actions.append(PhrenControlAction(id: "delete", title: "Delete", icon: "trash", role: .destructive) { confirmDelete(item) })
            }
        case .topic, .project:
            break
        }
        return actions
    }

    // MARK: - Selection

    private func receiveSelection(_ node: GraphNodeRef?) {
        // The local renderer must not route a stale selection into another store.
        guard let node else { selection = nil; return }
        guard node.store == selectedStore, visible?.nodes.contains(where: { $0.id == node.id }) == true else { return }
        searchFocused = false
        selection = node
    }

    private func selectNode(_ id: String) {
        guard let node = visible?.nodes.first(where: { $0.id == id }) else { return }
        searchFocused = false
        selection = GraphNodeRef(node: node)
        command = GraphCommand(action: .focus(node.id))
    }

    private func handleGraphAction(_ action: GraphAction) {
        switch action {
        case .select(let id):
            selectNode(id)
        case .focus(let id):
            focusedNodeID = id
            selection = nil
            command = GraphCommand(action: .reveal(id))
        case .openProject(let id):
            guard let selection, selection.id == id, let storeId = selection.store, let project = selection.project else { return }
            projectRoute = ProjectRoute(storeId: storeId, project: project)
        case .share(let id):
            guard let selection, selection.id == id else { return }
            shareText = selection.sourceText ?? selection.label ?? selection.id
        case .edit(let id):
            guard let selection, selection.id == id else { return }
            editNode(selection)
        case .delete(let id):
            guard let selection, selection.id == id else { return }
            deleteNode(selection)
        case .close:
            selection = nil
        }
    }

    private func clearFocus() {
        focusedNodeID = nil
        selection = nil
        command = GraphCommand(action: .reset)
    }

    /// The dossier's Edit: the row's own action when the list has the node,
    /// else the graph's text-matched fallback (a journal finding, a capped one).
    private func editNode(_ node: GraphNodeRef) {
        if let item = contents.first(where: { $0.nodeID == node.id }) { edit(item); return }
        guard let storeId = node.store, let project = node.project, node.isTask || node.isFinding else { return }
        let match = node.fullLabel ?? node.text ?? ""
        editing = MemoryEdit(id: node.id, title: node.isTask ? "Edit task" : "Edit finding", text: match) { text in
            if node.isTask {
                await model.perform(.updateTask(project: project, match: Self.taskMatch(node), text: text, priority: nil, section: nil), in: storeId)
            } else {
                await model.perform(.editFinding(project: project, match: match, newText: text), in: storeId)
            }
            selection = nil
        }
    }

    private func deleteNode(_ node: GraphNodeRef) {
        if let item = contents.first(where: { $0.nodeID == node.id }) { confirmDelete(item); return }
        guard let storeId = node.store, let project = node.project, node.isTask || node.isFinding else { return }
        let match = node.fullLabel ?? node.text ?? ""
        deleting = MemoryDeletion(id: node.id, isTask: node.isTask, text: match) {
            if node.isTask {
                await model.perform(.removeTask(project: project, match: Self.taskMatch(node)), in: storeId)
            } else {
                await model.perform(.removeFinding(project: project, match: match), in: storeId)
            }
            selection = nil
        }
    }

    private static func taskMatch(_ node: GraphNodeRef) -> String {
        guard let range = node.id.range(of: ":task:") else { return node.fullLabel ?? node.text ?? "" }
        return String(node.id[range.upperBound...])
    }

    /// Back from the dossier to the list, at the selected row; a project
    /// node narrows the scope to that project instead.
    private func showInList() {
        guard let selected = selection else { return }
        selection = nil
        command = GraphCommand(action: .clear)
        query = ""
        searchFocused = false
        if selected.isProject {
            project = selected.project ?? ""
            return
        }
        guard let target = contents.first(where: { $0.nodeID == selected.id }) else { return }
        topic = nil
        if MemoryBrowsing.filter([target], content: content, topic: nil).isEmpty { content = .all }
        if height == .collapsed { height = .half }
        highlightedID = target.id
        scrollTarget = target.id
    }

    // MARK: - Loading

    private func rebuild() async {
        let request = refreshKey
        do {
            let next = try await model.graphPayload(storeId: request.store, focusProject: request.project)
            try Task.checkCancellation()
            guard request.store == selectedStore, request.project == selectedProject else { return }
            payload = next
            payloadRevision = UUID()
            let scope = "\(request.store)/\(request.project ?? "*")"
            if let focusedNodeID, !next.nodes.contains(where: { $0.id == focusedNodeID }) { self.focusedNodeID = nil }
            if renderedScope != scope {
                command = GraphCommand(action: .reset)
                renderedScope = scope
            }
            if let selection, let updated = next.nodes.first(where: { $0.id == selection.id }) {
                self.selection = GraphNodeRef(node: updated)
            } else {
                selection = nil
            }
        } catch is CancellationError {
            // A newer store/project request owns the screen.
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func present() async {
        guard let payload else { return }
        let filter = content.graphFilter
        let focus = focusedNodeID
        do {
            let presentation = try await Task.detached(priority: .userInitiated) {
                let filtered = payload.filtered(by: filter)
                let visible = focus.map { filtered.neighborhood(of: $0, steps: 1) } ?? filtered
                return (visible, try visible.jsonString(), MemoryBrowsing.NodeIndex(payload: visible))
            }.value
            try Task.checkCancellation()
            visible = presentation.0
            payloadJSON = presentation.1
            nodes = presentation.2
            nodesRevision = UUID()
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func search() async {
        let request = searchRequest
        guard !request.query.isEmpty else {
            results = []
            searching = false
            return
        }
        searching = true
        do {
            try await Task.sleep(for: .milliseconds(120))
            let index = model.searchIndex
            let hits = await Task.detached(priority: .userInitiated) {
                index.search(request.query, store: request.store, project: request.project)
            }.value
            try Task.checkCancellation()
            let graphMatches = visible?.search(request.query) ?? []
            results = MemoryBrowsing.results(hits: hits, graphMatches: graphMatches, contents: contents, storeId: request.store)
            searching = false
            searchFocused = false
            height = .full
        } catch {}
    }

    private struct RefreshKey: Equatable {
        let store: String
        let project: String?
        let revision: UUID
    }

    private struct ContentsKey: Equatable {
        let store: String
        let project: String?
        let revision: UUID
        let nodes: UUID
    }

    private struct PresentationKey: Equatable {
        let revision: UUID
        let filter: GraphPayload.ContentFilter
        let focus: String?
    }

    private struct SearchRequest: Equatable {
        let query: String
        let store: String
        let project: String?
        let revision: UUID
        let nodes: UUID
    }
}

private struct MemoryEdit: Identifiable {
    let id: String
    let title: String
    let text: String
    let save: (String) async -> Void
}

private struct MemoryDeletion: Identifiable {
    let id: String
    let isTask: Bool
    let text: String
    let run: () async -> Void
}
