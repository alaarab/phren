import PhrenKit
import SwiftUI

/// Native phone controls around the shared terminal/VS Code graph contract.
struct GraphView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var focusProject: String?
    var initialStoreId: String?
    @State private var storeId = ""
    @State private var project = ""
    @State private var filter: GraphPayload.ContentFilter = .all
    @State private var payload: GraphPayload?
    @State private var payloadRevision = UUID()
    @State private var filtered: GraphPayload?
    @State private var visible: GraphPayload?
    @State private var payloadJSON: String?
    @State private var error: String?
    @State private var selection: GraphNodeRef?
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
        VStack(spacing: 0) {
            LiveStatusBar()
            controls
            ZStack(alignment: .bottomTrailing) {
                if let visible, let json = payloadJSON, !visible.nodes.isEmpty {
                    GraphWebView(payloadJSON: json, command: command,
                                 onSelect: receiveSelection,
                                 onError: { error = $0 })
                        .id(rendererID)
                        .accessibilityLabel("Interactive memory graph")
                    cameraControls.padding(12)
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
        .background(PhrenTheme.bg)
        .navigationTitle("Memory graph")
        .navigationBarTitleDisplayMode(.inline)
        // A graph drag must never become an interactive navigation pop.
        // Hiding the system back item removes its swipe gesture; keep an
        // explicit, accessible way out in the leading toolbar instead.
        .navigationBarBackButtonHidden(true)
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
                Menu {
                    Button("Save this view", systemImage: "bookmark") {
                        suggestedViewName = focusedNodeID.flatMap { id in filtered?.nodes.first { $0.id == id }?.label }
                            ?? selectedProject ?? "All projects"
                        savedViewName = ""
                        namingView = true
                    }.disabled(payload == nil)
                    Button("Saved views", systemImage: "bookmark.fill") { showingSavedViews = true }
                    NavigationLink { LiveSessionsView() } label: {
                        Label("Live sessions", systemImage: "waveform.path")
                    }
                    Button("Refresh", systemImage: "arrow.clockwise") {
                        Task { await model.pullToRefresh(); await rebuild() }
                    }
                    Button("About this graph", systemImage: "info.circle") { showingInfo = true }
                } label: { Label("Graph options", systemImage: "ellipsis") }
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
                    return (filtered, visible, try visible.jsonString())
                }.value
                try Task.checkCancellation()
                filtered = presentation.0; visible = presentation.1; payloadJSON = presentation.2
            } catch is CancellationError {} catch { self.error = error.localizedDescription }
        }
        .sheet(item: $selection, onDismiss: {
            switch command?.action {
            case .reset, .reveal: break
            default: command = GraphCommand(action: .clear)
            }
        }) { node in
            GraphNodeSheet(node: node) { focus(on: node.id) }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        }
        .sheet(isPresented: $showingSavedViews) { savedViewsSheet }
        .alert("Save graph view", isPresented: $namingView) {
            TextField(suggestedViewName, text: $savedViewName)
            Button("Save") { saveCurrentView() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Save this store, project, content filter, and connection focus on this iPhone.") }
        .alert("Graph view", isPresented: $notice.isPresent()) {
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
        .sheet(isPresented: $showingInfo) {
            NavigationStack {
                PhrenList {
                    Section("Explore") {
                        Text("Drag to rotate. Pinch to zoom. Tap a node to read its details or open its project.")
                        Text("Search finds content in this view. Choose a project to load more of its findings and tasks. Open a node's details and choose Focus connections to follow one or two steps of actual links.")
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
                Menu {
                    ForEach(model.storeDescriptors) { store in
                        Button(store.id) {
                            clearFocus()
                            storeId = store.id
                            project = "*"
                            payload = nil
                        }
                    }
                } label: {
                    Label(selectedStore, systemImage: "externaldrive")
                        .lineLimit(1)
                }
                .accessibilityLabel("Store: \(selectedStore)")
                Spacer(minLength: 10)
                Menu {
                    Button("All projects") { clearFocus(); project = "*" }
                    ForEach(projects, id: \.self) { name in Button(name) { clearFocus(); project = name } }
                } label: {
                    Label(selectedProject ?? "All projects", systemImage: "square.grid.2x2").lineLimit(1)
                }
                .accessibilityLabel("Project: \(selectedProject ?? "All projects")")
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            Picker("Graph content", selection: Binding(get: { filter }, set: { filter = $0; clearFocus() })) {
                ForEach(GraphPayload.ContentFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)

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
                    Menu("\(connectionSteps) \(connectionSteps == 1 ? "step" : "steps")") {
                        ForEach(1...2, id: \.self) { steps in
                            Button("\(steps) \(steps == 1 ? "step" : "steps") of connections") {
                                connectionSteps = steps
                                resetSelection()
                            }
                        }
                    }.font(.caption)
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
                    command = GraphCommand(action: .focus(node.id))
                    selection = GraphNodeRef(node: node)
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

    private struct PresentationKey: Equatable {
        let revision: UUID
        let filter: GraphPayload.ContentFilter
        let focus: String?
        let steps: Int
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

private struct GraphNodeSheet: View {
    @Environment(AppModel.self) private var model
    let node: GraphNodeRef
    let onFocus: () -> Void

    var body: some View {
        NavigationStack {
            PhrenList {
                Section {
                    DocumentPreview(content: node.sourceText ?? node.label ?? node.id)
                    if let store = node.store { LabeledContent("Store", value: model.storeName(for: store)) }
                    if let project = node.project { LabeledContent("Project", value: project) }
                    if node.id.hasPrefix("journal:") { Label("Team journal", systemImage: "person.2") }
                }
                if let project = node.project, let storeId = node.store {
                    Section {
                        Button("Focus connections", systemImage: "point.3.connected.trianglepath.dotted", action: onFocus)
                        NavigationLink("Open project") { ProjectDetailView(storeId: storeId, project: project) }
                        ShareLink(item: node.sourceText ?? node.label ?? node.id) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                    }
                    ProjectSessionActions(storeId: storeId, project: project, presentation: .section)
                }
            }
            .navigationTitle(node.isTask ? "Task" : (node.isFinding ? "Finding" : "Project"))
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: ArchiveRoute.self) { route in
                ArchiveBrowserView(storeId: route.storeId, project: route.project)
            }
            .navigationDestination(for: ArchiveTopicRoute.self) { route in
                ArchiveTopicView(storeId: route.storeId, topic: route.topic)
            }
        }
    }
}
