import PhrenKit
import SwiftUI
import UIKit

/// Native phone controls around the shared terminal/VS Code graph contract.
struct GraphView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var focusProject: String?
    var initialStoreId: String?
    @State private var storeId = ""
    @State private var project = ""
    @State private var filter: GraphPayload.ContentFilter = .all
    @State private var payload: GraphPayload?
    @State private var payloadRevision = UUID()
    @State private var filtered: GraphPayload?
    @State private var visible: GraphPayload?
    @State private var error: String?
    @State private var selection: GraphNodeRef?
    @State private var editingNode: GraphNodeRef?
    @State private var deletingNode: GraphNodeRef?
    @State private var command: GraphCommand?
    @State private var query = ""
    @State private var showingSearch = false
    @State private var showingInfo = false
    @State private var rendererID = UUID()
    @State private var renderedStore: String?
    @State private var renderedProject: String?
    @State private var focusedNodeID: String?
    @State private var connectionSteps = 1
    @State private var focusHistory: [String] = []
    @State private var showingSavedViews = false
    @State private var namingView = false
    @State private var savedViewName = ""
    @State private var suggestedViewName = "Graph"
    @State private var notice: String?
    @State private var restoringView: GraphSavedView?
    @State private var projectRoute: ProjectRoute?
    @State private var shareText: String?
    @State private var showingOptions = false
    @State private var showingStores = false
    @State private var showingProjects = false
    @State private var showingSteps = false
    @State private var showingLiveSessions = false
    @AppStorage("graph.savedViews.v1") private var savedViewData = Data()
    @FocusState private var searchFocused: Bool

    private var selectedStore: String {
        storeId.isEmpty ? (initialStoreId ?? model.storeFilter ?? model.storeDescriptors.first?.id ?? "") : storeId
    }
    private var selectedProject: String? {
        let value = project.isEmpty ? focusProject : (project == "*" ? nil : project)
        return value
    }
    private var projects: [String] { model.snapshot(for: selectedStore).projects.map(\.name).sorted() }
    private var savedViews: [GraphSavedView] {
        (try? JSONDecoder().decode([GraphSavedView].self, from: savedViewData)) ?? []
    }
    private var refreshKey: RefreshKey {
        RefreshKey(store: selectedStore, project: selectedProject, revision: model.snapshot(for: selectedStore).revision)
    }

    var body: some View {
        GeometryReader { _ in
            VStack(spacing: 0) {
                LiveStatusBar()
                controls
                ZStack(alignment: .bottomTrailing) {
                    if let visible, !visible.nodes.isEmpty {
                        GraphWebView(payload: visible, command: command,
                                     onSelect: receiveSelection,
                                     onAction: handleGraphAction,
                                     onError: { error = $0 })
                            .id(rendererID)
                            .accessibilityLabel("Interactive memory graph")
                        cameraControls
                            .padding(12)
                            .frame(maxWidth: .infinity, maxHeight: .infinity,
                                   alignment: selection == nil ? .bottomTrailing : .topTrailing)
                            .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.28),
                                       value: selection?.id)
                    } else if visible != nil {
                        PhrenEmptyState(title: "No graph content yet",
                                        message: "Findings, tasks, and projects appear here after your store syncs.")
                    } else if error == nil {
                        ProgressView("Loading graph…").frame(maxWidth: .infinity, maxHeight: .infinity)
                    }

                    if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        searchResults
                    }
                    if let error {
                        VStack(spacing: 12) {
                            PhrenEmptyState(title: "Graph unavailable", message: error)
                            Button("Try again") {
                                self.error = nil
                                rendererID = UUID()
                                Task { await rebuild() }
                            }.buttonStyle(.borderedProminent).tint(PhrenTheme.accentSolid)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(PhrenTheme.bg)
                    }
                }
            }
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Memory graph")
        .navigationBarTitleDisplayMode(.inline)
        // A graph drag must never become an interactive navigation pop.
        // Hiding the system back item removes its swipe gesture; keep an
        // explicit, accessible way out in the leading toolbar instead.
        .navigationBarBackButtonHidden(true)
        .disablesNavigationPopGestures()
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { dismiss() } label: {
                    Label("Back", systemImage: "chevron.left")
                }
                .accessibilityIdentifier("graph-back")
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    showingSearch.toggle()
                    searchFocused = showingSearch
                    if !showingSearch { query = "" }
                } label: { Label("Search graph", systemImage: "magnifyingglass") }
                Button { showingOptions = true } label: { Label("Graph options", systemImage: "ellipsis") }
                    .accessibilityIdentifier("graph-options")
            }
        }
        .task(id: refreshKey) { await rebuild() }
        .task(id: PresentationKey(revision: payloadRevision, filter: filter, focus: focusedNodeID, steps: connectionSteps)) {
            guard let payload else { return }
            let filter = filter, focus = focusedNodeID, steps = connectionSteps
            do {
                let presentation = try await Task.detached(priority: .userInitiated) {
                    let filtered = payload.filtered(by: filter)
                    let visible = focus.map { filtered.neighborhood(of: $0, steps: steps) } ?? filtered
                    return (filtered, visible)
                }.value
                try Task.checkCancellation()
                filtered = presentation.0; visible = presentation.1
            } catch is CancellationError {} catch { self.error = error.localizedDescription }
        }
        .onChange(of: selection?.id) { previous, current in
            guard previous != nil, current == nil else { return }
            switch command?.action {
            case .reset, .reveal: break
            default: command = GraphCommand(action: .clear)
            }
        }
        .navigationDestination(for: ArchiveRoute.self) { route in
            ArchiveBrowserView(storeId: route.storeId, project: route.project)
        }
        .navigationDestination(for: ArchiveTopicRoute.self) { route in
            ArchiveTopicView(storeId: route.storeId, topic: route.topic)
        }
        .navigationDestination(item: $projectRoute) { route in
            ProjectDetailView(storeId: route.storeId, project: route.project)
        }
        .sheet(isPresented: $showingSavedViews) { savedViewsSheet }
        .sheet(isPresented: $shareText.isPresent()) {
            ActivityView(activityItems: [shareText ?? ""])
        }
        .sheet(item: $editingNode) { node in
            TextEntrySheet(
                title: node.isTask ? "Edit task" : "Edit finding",
                initialText: node.fullLabel ?? node.text ?? "",
                confirmLabel: "Save"
            ) { text, _ in
                await applyEdit(node, text: text)
            }
        }
        .phrenDialog(
            isPresented: $deletingNode.isPresent(),
            title: deletingNode?.isTask == true ? "Delete this task?" : "Delete this finding?",
            message: "This removes it from the store on sync.",
            actions: deleteActions,
            identifier: "graph-delete-dialog"
        )
        .sheet(isPresented: $namingView) {
            NavigationStack {
                PhrenScreen {
                    PhrenGroup("Name") {
                        TextField(suggestedViewName, text: $savedViewName)
                            .accessibilityIdentifier("graph-view-name")
                    }
                }
                .navigationTitle("Save graph view")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { namingView = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { saveCurrentView(); namingView = false }
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .phrenDialog(
            isPresented: $notice.isPresent(),
            title: "Graph view",
            message: notice ?? "",
            actions: [.init(id: "ok", title: "OK", role: .cancel) { notice = nil }],
            identifier: "graph-notice-dialog"
        )
        .phrenActionSheet(isPresented: $showingOptions, title: "Graph options", actions: graphOptionsActions,
                          identifier: "graph-options-sheet")
        .phrenSingleSelectSheet(isPresented: $showingStores, title: "Store", options: storeOptions,
                                selection: storeSelection, rowPrefix: "graph-store")
        .phrenSingleSelectSheet(isPresented: $showingProjects, title: "Project", options: projectOptions,
                                selection: projectSelection, rowPrefix: "graph-project")
        .phrenSingleSelectSheet(isPresented: $showingSteps, title: "Connections", options: stepOptions,
                                selection: stepsSelection, rowPrefix: "graph-steps")
        .navigationDestination(isPresented: $showingLiveSessions) { LiveSessionsView() }
        .sheet(isPresented: $showingInfo) {
            NavigationStack {
                PhrenList {
                    Section("Explore") {
                        Text("Drag to rotate. Pinch to zoom. Tap a node to read its details or open its project.")
                        Text("Search finds content in this view. Choose a project to load more of its findings and tasks. Open a node's details and choose Focus to follow one or two steps of actual links.")
                        Text("Save views from the options menu. Bookmarks stay on this iPhone and restore the view using the latest synced data.")
                    }
                    Section("Your data") {
                        Text("The graph uses the same 3D renderer as the VS Code extension and the graph format shared with the terminal.")
                        Text("It reads cached findings, team journals, and active or queued tasks. Archived documents and computer-only fragment indexes are not downloaded for this view.")
                        Text("One store is shown at a time. Live sync updates the graph while it is open.")
                    }
                }
                .navigationTitle("About the graph")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingInfo = false } } }
            }.presentationDetents([.medium, .large])
        }
    }

    private var controls: some View {
        VStack(spacing: 8) {
            HStack {
                Button { showingStores = true } label: {
                    Label(selectedStore, systemImage: "externaldrive")
                        .lineLimit(1)
                }
                .frame(minHeight: 44)
                .accessibilityLabel("Store: \(selectedStore)")
                .phrenIdentifier("graph-store")
                Spacer(minLength: 10)
                Button { showingProjects = true } label: {
                    Label(selectedProject ?? "All projects", systemImage: "square.grid.2x2").lineLimit(1)
                }
                .frame(minHeight: 44)
                .accessibilityLabel("Project: \(selectedProject ?? "All projects")")
                .phrenIdentifier("graph-project")
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            PhrenTextSegment(items: GraphPayload.ContentFilter.allCases.map {
                PhrenOption(id: $0.rawValue, value: $0, title: $0.rawValue)
            }, selection: Binding(get: { filter }, set: { filter = $0; clearFocus() }), identifier: "graph-content")

            if let focusedNodeID, let anchor = filtered?.nodes.first(where: { $0.id == focusedNodeID }) {
                HStack {
                    if !focusHistory.isEmpty {
                        Button {
                            self.focusedNodeID = focusHistory.removeLast()
                            resetSelection()
                        } label: { Label("Previous focus", systemImage: "chevron.left").labelStyle(.iconOnly) }
                        .frame(minWidth: 44, minHeight: 44)
                    }
                    Text(anchor.label).font(.caption).lineLimit(1)
                    Spacer(minLength: 4)
                    Button("\(connectionSteps) \(connectionSteps == 1 ? "step" : "steps")") { showingSteps = true }
                        .frame(minHeight: 44)
                        .phrenIdentifier("graph-steps")
                        .font(.caption)
                    Button { clearFocus() } label: { Label("Show full view", systemImage: "xmark.circle.fill").labelStyle(.iconOnly) }
                        .frame(minWidth: 44, minHeight: 44)
                }
            }

            if showingSearch {
                HStack {
                    TextField("Search findings, tasks, projects", text: $query)
                        .textFieldStyle(.roundedBorder).focused($searchFocused)
                        .autocorrectionDisabled().submitLabel(.search)
                    if !query.isEmpty {
                        Button { query = "" } label: { Label("Clear search", systemImage: "xmark.circle.fill").labelStyle(.iconOnly) }
                    }
                }
            }
        }.padding(.horizontal).padding(.bottom, 12)
    }

    private var cameraControls: some View {
        VStack(spacing: 2) {
            cameraButton("Zoom in", icon: "plus", action: .zoomIn)
            cameraButton("Zoom out", icon: "minus", action: .zoomOut)
            cameraButton("Fit graph", icon: "arrow.up.left.and.arrow.down.right", action: .reset)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(PhrenTheme.border, lineWidth: 1))
    }

    private func cameraButton(_ title: String, icon: String, action: GraphCommand.Action) -> some View {
        Button { command = GraphCommand(action: action) } label: {
            Image(systemName: icon).frame(width: 44, height: 44)
        }.accessibilityLabel(title)
    }

    private var searchResults: some View {
        let results = visible?.search(query) ?? []
        return PhrenList {
            if results.isEmpty {
                Text("No matches in this view. Try another phrase or change the project or content filter.")
                    .foregroundStyle(.secondary)
            }
            ForEach(results) { node in
                Button {
                    query = ""
                    searchFocused = false
                    select(node)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(node.fullLabel).lineLimit(3).foregroundStyle(.primary)
                        Text(node.project).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }.scrollDismissesKeyboard(.interactively)
    }

    private func receiveSelection(_ node: GraphNodeRef?) {
        // The local renderer must not route a stale selection into another store.
        guard let node else { selection = nil; return }
        guard node.store == selectedStore,
              visible?.nodes.contains(where: { $0.id == node.id }) == true else { return }
        selection = node
    }

    private func handleGraphAction(_ action: GraphAction) {
        switch action {
        case .select(let id):
            guard let node = visible?.nodes.first(where: { $0.id == id }) else { return }
            select(node)
        case .focus(let id):
            focus(on: id)
        case .openProject(let id):
            guard let selection, selection.id == id,
                  let storeId = selection.store, let project = selection.project else { return }
            projectRoute = ProjectRoute(storeId: storeId, project: project)
        case .share(let id):
            guard let selection, selection.id == id else { return }
            shareText = selection.sourceText ?? selection.label ?? selection.id
        case .edit(let id):
            guard let selection, selection.id == id,
                  selection.store != nil, selection.project != nil else { return }
            editingNode = selection
        case .delete(let id):
            guard let selection, selection.id == id,
                  selection.store != nil, selection.project != nil else { return }
            deletingNode = selection
        case .close:
            selection = nil
        }
    }

    private func select(_ node: GraphPayload.Node) {
        selection = GraphNodeRef(node: node)
        command = GraphCommand(action: .focus(node.id))
    }

    /// Findings and tasks carry their markdown line back to the store: findings
    /// match on their text (a graph finding has no stable id), tasks on the id
    /// embedded in the node id (`<project>:task:<taskId>`).
    private func applyEdit(_ node: GraphNodeRef, text: String) async {
        guard let storeId = node.store, let project = node.project,
              node.isTask || node.isFinding else { return }
        if node.isTask {
            await model.perform(
                .updateTask(project: project, match: matchFor(node), text: text, priority: nil, section: nil),
                in: storeId
            )
        } else if node.isFinding {
            await model.perform(
                .editFinding(project: project, match: node.fullLabel ?? node.text ?? "", newText: text),
                in: storeId
            )
        }
        selection = nil
        await rebuild()
    }

    private func applyDelete(_ node: GraphNodeRef) async {
        guard let storeId = node.store, let project = node.project,
              node.isTask || node.isFinding else { return }
        if node.isTask {
            await model.perform(.removeTask(project: project, match: matchFor(node)), in: storeId)
        } else if node.isFinding {
            await model.perform(
                .removeFinding(project: project, match: node.fullLabel ?? node.text ?? ""),
                in: storeId
            )
        }
        selection = nil
        await rebuild()
    }

    private func matchFor(_ node: GraphNodeRef) -> String {
        guard let range = node.id.range(of: ":task:") else { return node.fullLabel ?? node.text ?? "" }
        return String(node.id[range.upperBound...])
    }

    private func resetSelection() {
        selection = nil
        query = ""
        error = nil
        command = GraphCommand(action: focusedNodeID.map(GraphCommand.Action.reveal) ?? .reset)
    }

    private func clearFocus() {
        focusedNodeID = nil
        focusHistory = []
        resetSelection()
    }

    private func focus(on id: String) {
        if let current = focusedNodeID, current != id { focusHistory.append(current) }
        focusedNodeID = id
        resetSelection()
    }

    private var savedViewsSheet: some View {
        NavigationStack {
            PhrenList {
                if savedViews.isEmpty { Text("Save a view from the graph's options menu to return to it here.").foregroundStyle(.secondary) }
                ForEach(savedViews) { view in
                    Button {
                        guard model.storeDescriptors.contains(where: { $0.id == view.storeID }) else {
                            showingSavedViews = false
                            notice = "Add \(view.storeID) in Settings before opening this saved view."
                            return
                        }
                        restoringView = view
                        clearFocus()
                        payload = nil
                        storeId = view.storeID
                        project = view.project ?? "*"
                        filter = view.filter
                        showingSavedViews = false
                        Task { await rebuild() }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(view.name).foregroundStyle(.primary)
                            Text("\(view.storeID) · \(view.project ?? "All projects") · \(view.filter.rawValue)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { offsets in
                    var views = savedViews
                    views.remove(atOffsets: offsets)
                    persist(views)
                }
            }
            .navigationTitle("Saved views")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingSavedViews = false } } }
        }
    }

    private func saveCurrentView() {
        let entered = savedViewName.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = entered.isEmpty ? suggestedViewName : entered
        var views = savedViews
        views.append(GraphSavedView(name: name, storeID: selectedStore, project: selectedProject,
                                    filter: filter, nodeID: focusedNodeID, steps: connectionSteps))
        persist(views)
    }

    private func persist(_ views: [GraphSavedView]) {
        do {
            // Preserve unsupported/corrupted bookmarks instead of overwriting them.
            if !savedViewData.isEmpty { _ = try JSONDecoder().decode([GraphSavedView].self, from: savedViewData) }
            savedViewData = try JSONEncoder().encode(views)
        } catch { notice = "Saved views couldn't be updated: \(error.localizedDescription)" }
    }

    private func rebuild() async {
        let request = refreshKey
        do {
            let next = try await model.graphPayload(storeId: request.store, focusProject: request.project)
            try Task.checkCancellation()
            guard request.store == selectedStore, request.project == selectedProject else { return }
            payload = next
            payloadRevision = UUID()
            let currentIDs = Set(next.filtered(by: filter).nodes.map(\.id))
            focusHistory = focusHistory.filter { currentIDs.contains($0) }
            if let restoringView, restoringView.storeID == request.store, restoringView.project == request.project {
                focusedNodeID = restoringView.nodeID
                connectionSteps = min(2, max(1, restoringView.steps))
                command = GraphCommand(action: focusedNodeID.map(GraphCommand.Action.reveal) ?? .reset)
                self.restoringView = nil
                if let project = request.project, !projects.contains(project) {
                    self.project = "*"
                    notice = "The saved project is no longer available. Showing all projects in this store."
                    return
                }
            }
            if let focusedNodeID, !currentIDs.contains(focusedNodeID) {
                clearFocus()
                notice = "The focused node is no longer in this view. Showing the current graph."
            }
            if renderedStore != request.store || renderedProject != request.project {
                command = GraphCommand(action: focusedNodeID.map(GraphCommand.Action.reveal) ?? .reset)
                renderedStore = request.store
                renderedProject = request.project
            }
            if let selection, let updated = next.nodes.first(where: { $0.id == selection.id }) {
                self.selection = GraphNodeRef(node: updated)
            } else { selection = nil }
        } catch is CancellationError {
            // A newer store/project request owns the screen.
        } catch {
            self.error = error.localizedDescription
        }
    }

    private struct RefreshKey: Hashable {
        let store: String
        let project: String?
        let revision: UUID
    }

    private var deleteActions: [PhrenDialog.Action] {
        guard let node = deletingNode else {
            return [.init(id: "cancel", title: "Cancel", role: .cancel) {}]
        }
        return [
            .init(id: "delete", title: "Delete", role: .destructive) { Task { await applyDelete(node) } },
            .init(id: "cancel", title: "Cancel", role: .cancel) {},
        ]
    }

    private struct PresentationKey: Equatable {
        let revision: UUID
        let filter: GraphPayload.ContentFilter
        let focus: String?
        let steps: Int
    }

    private var graphOptionsActions: [PhrenControlAction] {
        [
            PhrenControlAction(id: "save", title: "Save this view", icon: "bookmark", isEnabled: payload != nil) {
                suggestedViewName = focusedNodeID.flatMap { id in filtered?.nodes.first { $0.id == id }?.label }
                    ?? selectedProject ?? "All projects"
                savedViewName = ""
                namingView = true
            },
            PhrenControlAction(id: "saved", title: "Saved views", icon: "bookmark.fill") { showingSavedViews = true },
            PhrenControlAction(id: "live", title: "Live sessions", icon: "waveform.path") { showingLiveSessions = true },
            PhrenControlAction(id: "refresh", title: "Refresh", icon: "arrow.clockwise") {
                Task { await model.pullToRefresh(); await rebuild() }
            },
            PhrenControlAction(id: "about", title: "About this graph", icon: "info.circle") { showingInfo = true },
        ]
    }

    private var storeOptions: [PhrenOption<String>] {
        model.storeDescriptors.map { PhrenOption(id: $0.id, value: $0.id, title: $0.id) }
    }

    private var storeSelection: Binding<String> {
        Binding(get: { selectedStore }, set: { id in
            clearFocus()
            storeId = id
            project = "*"
            payload = nil
        })
    }

    private var projectOptions: [PhrenOption<String>] {
        [PhrenOption(id: "all", value: "*", title: "All projects")]
            + projects.map { PhrenOption(id: $0, value: $0, title: $0) }
    }

    private var projectSelection: Binding<String> {
        Binding(get: { project.isEmpty ? (focusProject ?? "*") : project }, set: { value in
            clearFocus()
            project = value
        })
    }

    private var stepOptions: [PhrenOption<Int>] {
        (1...2).map { PhrenOption(id: "\($0)", value: $0, title: "\($0) \($0 == 1 ? "step" : "steps") of connections") }
    }

    private var stepsSelection: Binding<Int> {
        Binding(get: { connectionSteps }, set: { value in
            connectionSteps = value
            resetSelection()
        })
    }
}

struct GraphNodeRef: Codable, Equatable, Identifiable {
    var id: String
    var kind: String?
    var group: String?
    var project: String?
    var store: String?
    var label: String?
    var fullLabel: String?
    var text: String?
    var scoreKey: String?
    var editedText: String?
    var editedSection: String?
    var editedPriority: String?

    var isTask: Bool { kind == "task" || (group?.hasPrefix("task-") ?? false) }
    var isFinding: Bool { kind == "finding" || (group?.hasPrefix("topic:") ?? false) }
    var sourceText: String? { fullLabel ?? text }

    init(node: GraphPayload.Node) {
        id = node.id
        group = node.group
        project = node.project
        store = node.store
        label = node.label
        fullLabel = node.fullLabel
        scoreKey = node.scoreKey
    }
}

struct ProjectRoute: Identifiable, Hashable {
    let storeId: String
    let project: String
    var id: String { "\(storeId):\(project)" }
}

struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
