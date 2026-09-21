import PhrenKit
import SwiftUI

/// The Memory tab: map or list, one search, and two drop-down filters. The map
/// is the shared graph renderer with its own node dossier; the list is the same
/// rows the v1 panel drew. Selecting a node opens the dossier; a row in the
/// list switches to the map with that node selected.
struct MemoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var storeId = ""
    @AppStorage(MemorySettings.modeKey) private var modeRaw = MemoryMode.map.rawValue
    @AppStorage(MemorySettings.kindsKey) private var kindsRaw = ""
    @AppStorage(MemorySettings.projectsKey) private var projectsRaw = ""
    @State private var showingSearch = false
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
    @State private var results: [MemoryItem] = []
    @State private var searching = false
    @State private var scrollTarget: String?
    @State private var highlightedID: String?
    @State private var editing: MemoryEdit?
    @State private var deleting: MemoryDeletion?
    @State private var actionItem: MemoryItem?
    @State private var editingTask: TaskListRow?
    @State private var kindsPresented = false
    @State private var projectsPresented = false
    @State private var projectRoute: ProjectRoute?
    @State private var taskRoute: TaskListRow?
    @State private var shareText: String?
    @State private var moving = false

    private var selectedStore: String {
        storeId.isEmpty ? (model.storeFilter ?? model.storeDescriptors.first?.id ?? "") : storeId
    }
    private var projects: [String] { model.snapshot(for: selectedStore).projects.map(\.name).sorted() }
    private var snapshot: LocalStore.Snapshot { model.snapshot(for: selectedStore) }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var mode: MemoryMode { MemoryMode(rawValue: modeRaw) ?? .map }
    private var kinds: Set<MemoryKind> { MemorySettings.decodeKinds(kindsRaw) }
    private var projectFilter: Set<String> { MemorySettings.decodeProjects(projectsRaw) }
    private var showsKindChips: Bool { kinds == Set(MemoryKind.allCases) }
    /// Grouped by project unless exactly one project is chosen.
    private var groupByProject: Bool { projectFilter.count != 1 }

    private var modeBinding: Binding<MemoryMode> {
        Binding(get: { mode }, set: { newValue in
            modeRaw = newValue.rawValue
            if newValue == .list { selection = nil; command = GraphCommand(action: .clear) }
        })
    }
    private var kindsBinding: Binding<Set<MemoryKind>> {
        Binding(get: { kinds }, set: { kindsRaw = MemorySettings.encodeKinds($0) })
    }
    private var projectsBinding: Binding<Set<String>> {
        Binding(get: { projectFilter }, set: { projectsRaw = MemorySettings.encodeProjects($0) })
    }

    private var refreshProject: String? { projectFilter.count == 1 ? projectFilter.first : nil }
    private var refreshKey: RefreshKey {
        RefreshKey(store: selectedStore, project: refreshProject, revision: snapshot.revision)
    }
    private var contentsKey: ContentsKey {
        ContentsKey(store: selectedStore, revision: snapshot.revision, nodes: nodesRevision)
    }
    private var presentationKey: PresentationKey {
        PresentationKey(revision: payloadRevision, filter: MemoryBrowsing.graphFilter(kinds: kinds),
                        focus: focusedNodeID, projects: projectFilter)
    }
    private var searchRequest: SearchRequest {
        SearchRequest(query: trimmedQuery, store: selectedStore, project: refreshProject,
                      revision: model.searchRevision, nodes: nodesRevision)
    }

    /// The scope's contents, narrowed to the chosen projects. Topic rows are a
    /// derived grouping, so they stay in view whatever the project filter.
    private var scopedContents: [MemoryItem] {
        guard !projectFilter.isEmpty else { return contents }
        return contents.filter { $0.kind == .topic || projectFilter.contains($0.project) }
    }

    private var displayRows: [MemoryItem] {
        if mode == .list, !trimmedQuery.isEmpty { return results }
        return MemoryBrowsing.filter(scopedContents, kinds: kinds)
    }

    private var counts: MemoryCounts { MemoryBrowsing.counts(displayRows) }

    private var selectedProjectLabel: String? {
        projectFilter.count == 1 ? projectFilter.first : nil
    }

    private var emptyText: String {
        if !trimmedQuery.isEmpty { return "No matches" }
        if scopedContents.isEmpty {
            return selectedProjectLabel.map { "Nothing saved for \($0) yet" } ?? "Nothing saved in \(selectedStore) yet"
        }
        return "No rows for these filters"
    }

    var body: some View {
        PhrenNavigationStack {
            VStack(spacing: 0) {
                ActionErrorBanner()
                if showingSearch {
                    PhrenSearchField(text: $query, placeholder: "Search memory", identifier: "memory-search",
                                     focus: $searchFocused, onSubmit: submitSearch)
                        .padding(.horizontal, PhrenTheme.Space.large)
                        .padding(.bottom, PhrenTheme.Space.small)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                filterLine
                content
            }
            .background(PhrenTheme.bg)
            .navigationTitle("Memory")
            .navigationBarTitleDisplayMode(.inline)
            .disablesPanToGoBack()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingSearch.toggle()
                        if showingSearch { searchFocused = true } else { query = "" }
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .accessibilityLabel(showingSearch ? "Close search" : "Search memory")
                    .accessibilityIdentifier("memory-search-toggle")
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: showingSearch)
            .navigationDestination(item: $projectRoute) { route in
                ProjectDetailView(storeId: route.storeId, project: route.project)
            }
            .navigationDestination(item: $taskRoute) { row in
                TaskDetailsSheet(row: row)
            }
            .task(id: refreshKey) { await rebuild() }
            .task(id: presentationKey) { await present() }
            .task(id: searchRequest) { await search() }
            .onChange(of: contentsKey, initial: true) { _, _ in refreshContents() }
            .onChange(of: query) { _, value in
                if value.isEmpty, showingSearch { showingSearch = false; searchFocused = false }
            }
            .onChange(of: projectsRaw) { _, _ in
                selection = nil
                focusedNodeID = nil
                highlightedID = nil
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
        .phrenMultiSelectSheet(isPresented: $kindsPresented, title: "Kinds", options: kindOptions,
                               selection: kindsBinding, rowPrefix: "memory-kind", requiresSelection: true)
        .phrenMultiSelectSheet(isPresented: $projectsPresented, title: "Projects", options: projectOptions,
                               selection: projectsBinding, rowPrefix: "memory-project", leading: storeChooser)
        .phrenActionSheet(isPresented: $actionItem.isPresent(), title: actionTitle, actions: rowActions,
                          identifier: "memory-actions")
        .phrenDialog(isPresented: $deleting.isPresent(),
                     title: deleting?.isTask == true ? "Delete this task?" : "Delete this finding?",
                     message: deleting?.text ?? "", actions: deleteActions, identifier: "memory-delete")
    }

    // MARK: - Filter line

    private var filterLine: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            PhrenMultiSelect(options: kindOptions, selection: kindsBinding, allLabel: "All kinds",
                             identifier: "memory-kinds", isPresented: $kindsPresented)
            PhrenMultiSelect(options: projectOptions, selection: projectsBinding, allLabel: "All projects",
                             identifier: "memory-projects", isPresented: $projectsPresented)
            PhrenIconSegment(items: [.init(value: MemoryMode.map, icon: "point.3.connected.trianglepath.dotted", label: "Map"),
                                     .init(value: MemoryMode.list, icon: "list.bullet", label: "List")],
                             selection: modeBinding, identifier: { "memory-mode:\($0.rawValue)" })
                .fixedSize()
                .phrenContainerMarker("memory-mode", label: "Memory mode", value: mode.rawValue)
        }
        .padding(.horizontal, PhrenTheme.Space.large)
        .frame(minHeight: 44)
    }

    private var kindOptions: [PhrenOption<MemoryKind>] {
        MemoryKind.allCases.map { PhrenOption(id: $0.id, value: $0, title: $0.rawValue) }
    }

    private var projectOptions: [PhrenOption<String>] {
        projects.map { PhrenOption(id: $0, value: $0, title: $0) }
    }

    /// The store chooser is the projects sheet's first section when this phone
    /// carries more than one store.
    private var storeChooser: AnyView? {
        guard model.hasMultipleStores else { return nil }
        return AnyView(
            VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                Text("Store").plainListSectionLabel()
                ForEach(model.storeDescriptors) { store in
                    PhrenOptionRow(title: store.id, selected: store.id == selectedStore, mark: .check) {
                        switchStore(store.id)
                    }
                    .phrenIdentifier("memory-store:\(store.id)")
                }
                Divider().overlay(PhrenTheme.border)
            }
        )
    }

    private func switchStore(_ id: String) {
        guard id != selectedStore else { return }
        selection = nil
        focusedNodeID = nil
        highlightedID = nil
        storeId = id
        projectsRaw = ""
        payload = nil
        visible = nil
        payloadJSON = nil
        error = nil
    }

    // MARK: - Content

    @ViewBuilder private var content: some View {
        switch mode {
        case .map: map
        case .list: list
        }
    }

    private var map: some View {
        ZStack(alignment: .topTrailing) {
            PhrenTheme.bg
            if let visible, let json = payloadJSON, !visible.nodes.isEmpty {
                GraphWebView(payloadJSON: json, command: command,
                             onSelect: receiveSelection, onAction: handleGraphAction,
                             onError: { error = $0 })
                    .id(rendererID)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Interactive memory graph")
                cameraControls.padding(PhrenTheme.Space.medium)
                if selection != nil {
                    showInListButton
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(PhrenTheme.Space.medium)
                }
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

    private var list: some View {
        MemoryPanel(rows: displayRows, counts: counts, countKinds: kinds,
                    groupByProject: groupByProject, showKind: showsKindChips, emptyText: emptyText,
                    highlightedID: highlightedID, scrollTarget: $scrollTarget,
                    canWrite: { model.canWrite(storeId: $0.storeId, project: $0.project) && !moving },
                    onSelect: open, onMove: move, onEdit: edit, onDelete: confirmDelete,
                    onActions: { actionItem = $0 })
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var showInListButton: some View {
        Button(action: showInList) {
            HStack(spacing: PhrenTheme.Space.xs) {
                Image(systemName: "list.bullet").font(PhrenTypography.icon(12, weight: .semibold)).accessibilityHidden(true)
                Text("Show in list")
            }
            .font(PhrenTypography.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.accent)
            .padding(.horizontal, PhrenTheme.Space.medium).frame(minHeight: 44)
            .background(PhrenTheme.surface.opacity(0.92), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain).accessibilityLabel("Show in list").phrenIdentifier("memory-show-in-list")
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

    private func refreshContents() {
        contents = MemoryBrowsing.contents(snapshot: snapshot, storeId: selectedStore, project: nil, nodes: nodes)
    }

    private func submitSearch() {
        searchFocused = false
        if trimmedQuery.isEmpty { showingSearch = false; return }
        if mode == .map, let node = visible?.search(trimmedQuery).first { selectNode(node.id) }
    }

    // MARK: - Rows

    private func open(_ item: MemoryItem) {
        highlightedID = nil
        switch item.kind {
        case .topic:
            if let finding = contents.first(where: {
                $0.kind == .finding && ($0.typeTag ?? "general") == item.key && $0.nodeID != nil
            }) {
                showOnMap(finding)
            }
        case .project:
            if item.nodeID != nil { showOnMap(item) }
        case .note:
            projectRoute = ProjectRoute(storeId: item.storeId, project: item.project)
        case .finding:
            if item.nodeID != nil { showOnMap(item) } else { projectRoute = ProjectRoute(storeId: item.storeId, project: item.project) }
        case .task:
            if item.nodeID != nil { showOnMap(item) } else { projectRoute = ProjectRoute(storeId: item.storeId, project: item.project) }
        }
    }

    /// A list row selects its node on the map.
    private func showOnMap(_ item: MemoryItem) {
        guard let id = item.nodeID else { return }
        modeRaw = MemoryMode.map.rawValue
        selectNode(id)
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

    /// Back from the map to the list, at the selected row; the filters widen
    /// when they would otherwise hide it.
    private func showInList() {
        guard let selected = selection else { return }
        modeRaw = MemoryMode.list.rawValue
        selection = nil
        command = GraphCommand(action: .clear)
        query = ""
        showingSearch = false
        focusedNodeID = nil
        guard let target = contents.first(where: { $0.nodeID == selected.id }) else { return }
        if !MemoryBrowsing.filter(scopedContents, kinds: kinds).contains(where: { $0.id == target.id }) {
            kindsRaw = ""
            projectsRaw = ""
        }
        highlightedID = target.id
        scrollTarget = target.id
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

    // MARK: - Loading

    private func rebuild() async {
        let request = refreshKey
        do {
            let next = try await model.graphPayload(storeId: request.store, focusProject: request.project)
            try Task.checkCancellation()
            guard request.store == selectedStore, request.project == refreshProject else { return }
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
        let filter = MemoryBrowsing.graphFilter(kinds: kinds)
        let focus = focusedNodeID
        let chosen = projectFilter
        do {
            let presentation = try await Task.detached(priority: .userInitiated) {
                let scoped = chosen.isEmpty ? payload : payload.keeping(projects: chosen)
                let filtered = scoped.filtered(by: filter)
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
        } catch {}
    }

    private struct RefreshKey: Equatable {
        let store: String
        let project: String?
        let revision: UUID
    }

    private struct ContentsKey: Equatable {
        let store: String
        let revision: UUID
        let nodes: UUID
    }

    private struct PresentationKey: Equatable {
        let revision: UUID
        let filter: GraphPayload.ContentFilter
        let focus: String?
        let projects: Set<String>
    }

    private struct SearchRequest: Equatable {
        let query: String
        let store: String
        let project: String?
        let revision: UUID
        let nodes: UUID
    }
}

enum MemoryMode: String {
    case map, list
}

/// The remembered mode and filters, kept per phone.
enum MemorySettings {
    static let modeKey = "memory.mode.v1"
    static let kindsKey = "memory.kinds.v1"
    static let projectsKey = "memory.projects.v1"

    /// An empty string is every kind, so a fresh phone reads as All kinds.
    static func decodeKinds(_ raw: String) -> Set<MemoryKind> {
        let parsed = Set(raw.split(separator: ",").compactMap { MemoryKind(rawValue: String($0)) })
        return parsed.isEmpty ? Set(MemoryKind.allCases) : parsed
    }

    static func encodeKinds(_ kinds: Set<MemoryKind>) -> String {
        kinds.map(\.rawValue).sorted().joined(separator: ",")
    }

    static func decodeProjects(_ raw: String) -> Set<String> {
        Set(raw.split(separator: ",").map(String.init))
    }

    static func encodeProjects(_ projects: Set<String>) -> String {
        projects.sorted().joined(separator: ",")
    }
}

extension GraphPayload {
    /// The projects slice of the same store payload, keeping every link whose
    /// endpoints survive.
    func keeping(projects: Set<String>) -> GraphPayload {
        let nodes = nodes.filter { projects.contains($0.project) }
        let ids = Set(nodes.map(\.id))
        return GraphPayload(nodes: nodes, links: links.filter { ids.contains($0.source) && ids.contains($0.target) },
                            topics: topics, total: nodes.count)
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
