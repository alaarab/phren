import SwiftUI
import PhrenKit

struct TasksView: View {
    var body: some View {
        PhrenNavigationStack {
            VStack(spacing: 0) {
                LiveStatusBar()
                ActionErrorBanner()
                TaskListView(scope: .all)
            }
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct TaskListRow: Identifiable, Hashable {
    let storeId: String
    let storeName: String
    let project: String
    let task: PhrenTask
    var id: String { "\(storeId)/\(project)/\(task.stableId ?? task.id)" }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id && lhs.storeName == rhs.storeName && lhs.task == rhs.task }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// The complete, reviewable instruction handed to an agent started from a
/// task. Keep this formatting in one place so every launch sends the same
/// store/project identity and the task's full text.
struct TaskAgentRequest: Equatable {
    let row: TaskListRow

    var title: String {
        TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line))
    }

    var prompt: String {
        var parts = [
            "Work on this Phren task and continue until it is complete:",
            "Store: \(row.storeId)\nProject: \(row.project)",
            "Task:\n\(title)"
        ]
        if let context = row.task.context?.trimmingCharacters(in: .whitespacesAndNewlines), !context.isEmpty {
            parts.append("Context:\n\(context)")
        }
        return parts.joined(separator: "\n\n")
    }
}

/// Task list: cross-store + cross-project in the Tasks tab, or scoped to one
/// store's project inside project detail.
struct TaskListView: View {
    enum Scope: Equatable {
        case all
        case project(storeId: String, project: String)
    }

    let scope: Scope

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var tasks = TasksModel()
    @State private var showAdd = false
    @State private var showStatus = false
    @State private var editing: TaskListRow?
    @State private var reading: TaskListRow?
    @AppStorage("tasks.status") private var status: TaskStatus = .open
    @AppStorage("tasks.sort.v1") private var sort: TaskSort = .manual
    /// Projects the person folded in the cross-project list, encoded into
    /// one AppStorage string so a fold is remembered across launches. The
    /// chips keep saying how much open work sits inside a folded section.
    @AppStorage(TasksCollapse.storageKey) private var collapsedRaw = ""
    @FocusState private var searchFocused: Bool

    private var collapsedProjects: Set<String> { TasksCollapse.decode(collapsedRaw) }

    private func setCollapsed(_ projects: Set<String>) {
        collapsedRaw = TasksCollapse.encode(projects)
    }

    private func toggleSection(_ project: String) {
        var folded = collapsedProjects
        if folded.contains(project) { folded.remove(project) } else { folded.insert(project) }
        setCollapsed(folded)
    }

    private var isProjectScoped: Bool {
        if case .project = scope { return true }
        return false
    }

    /// Scoped to a project phren never lets the phone write (`global`). The +
    /// is hidden rather than disabled: a read-only tier has no "fix your
    /// token" story, so a greyed control would only pose a question with no
    /// answer.
    private var isReadOnlyScope: Bool {
        guard case .project(_, let project) = scope else { return false }
        return LocalStore.isReadOnlyProject(project)
    }

    private struct StoreRevision: Equatable {
        let id: String
        let revision: UUID
        let name: String
    }
    private struct RowsKey: Equatable {
        let stores: [StoreRevision]
        let storeFilter: String?
        let scope: Scope
        let project: String?
        let query: String
        let priority: PhrenTask.Priority?
        let age: TaskAge
        let sort: TaskSort
        let status: TaskStatus
    }
    private var rowsKey: RowsKey {
        RowsKey(stores: model.storeContexts.map {
            StoreRevision(id: $0.id, revision: $0.snapshot.revision, name: $0.descriptor.displayName)
        }, storeFilter: model.storeFilter, scope: scope, project: tasks.selectedProject,
                query: tasks.query, priority: tasks.priority, age: tasks.age, sort: sort, status: status)
    }

    /// Add targets: every writable (store, project) pair. Derived from the
    /// project list (not just existing task docs) so a project can receive
    /// its first task — the write path creates tasks.md if missing.
    private var addTargets: [(storeId: String, storeName: String, project: String)] {
        model.writableProjects.map { ($0.storeId, $0.storeName, $0.project.name) }
    }

    var body: some View {
        @Bindable var tasks = tasks
        let visibleRows = tasks.visibleRows
        let writableRows = visibleRows.filter { model.canWrite(storeId: $0.storeId, project: $0.project) }
        VStack(spacing: 0) {
            controls(visibleCount: visibleRows.count,
                     writableCount: writableRows.filter { !collapsedProjects.contains($0.project) }.count)
            if tasks.showSearch && !tasks.isSelecting {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(PhrenTheme.textMuted)
                    TextField("Search tasks", text: $tasks.query)
                        .focused($searchFocused)
                        .submitLabel(.search)
                        .onSubmit { searchFocused = false }
                        .accessibilityIdentifier("task-search-field")
                    if !tasks.query.isEmpty {
                        Button { tasks.query = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .accessibilityLabel("Clear search")
                    }
                }
                .font(.callout)
                .padding(10)
                .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
            }
            PhrenList(plain: true) {
                if !visibleRows.isEmpty, !isProjectScoped, tasks.selectedProject == nil {
                    // Across projects the list reads per project: the chosen
                    // status's busiest work first, each with its own counts,
                    // foldable to skim the rest. The top All control folds or
                    // unfolds every section at once.
                    let groups = tasks.visibleGroups
                    allSectionsControl(groups)
                    ForEach(groups) { group in
                        sectionHeader(group)
                        if !collapsedProjects.contains(group.project) { taskRows(group.rows) }
                    }
                } else if !visibleRows.isEmpty {
                    Text(status.title)
                        .plainListSectionLabel()
                    taskRows(visibleRows)
                } else if status == .active && !hasFilters {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            Image(systemName: "checkmark.circle")
                                .font(.title2).foregroundStyle(PhrenTheme.success)
                                .accessibilityHidden(true)
                            Text("No active tasks").font(.headline)
                            Text("Start work from your backlog, or add a task.")
                                .font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                        }
                        .padding(.vertical, 10)
                        let backlogCount = tasks.backlogCount
                        if backlogCount > 0 {
                            Button("View backlog (\(backlogCount))") { status = .backlog }
                        }
                    }
                }
            }
            .contentMargins(.top, 8, for: .scrollContent)
            .overlay {
                if visibleRows.isEmpty && (status != .active || hasFilters) {
                    VStack(spacing: 8) {
                        PhrenEmptyState(title: hasFilters ? "No matching tasks" : status.emptyListTitle,
                                        message: hasFilters ? "Try another filter or task status." : emptyMessage)
                        if hasFilters { Button("Clear filters", action: clearFilters) }
                    }
                }
            }
            .refreshable { await model.pullToRefresh() }
            .phrenScreen()
        }
        .background(PhrenTheme.bg)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if tasks.isSelecting { selectionActions }
        }
        .onChange(of: status) { _, _ in tasks.selectedIDs.removeAll() }
        .onChange(of: rowsKey, initial: true) { _, _ in
            tasks.update(status: status, sort: sort, scope: scope, model: model)
        }
        .toolbar {
            if !isReadOnlyScope {
                ToolbarItem(placement: .topBarLeading) {
                    Button(tasks.isSelecting ? "Cancel" : "Select") {
                        tasks.isSelecting.toggle()
                        tasks.selectedIDs.removeAll()
                        searchFocused = false
                    }
                    .accessibilityIdentifier("task-selection-mode")
                    .disabled(tasks.isMoving || (!tasks.isSelecting && writableRows.isEmpty))
                }
            }
            if !isReadOnlyScope && !tasks.isSelecting {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAdd = true } label: { Image(systemName: "plus") }
                        .disabled(!isProjectScoped && addTargets.isEmpty)
                }
            }
        }
        .sheet(isPresented: $showAdd) {
            AddTaskSheet(scope: scope, targets: addTargets)
        }
        .sheet(item: $editing) { row in
            TaskEditSheet(row: row)
        }
        .navigationDestination(item: $reading) { row in
            TaskDetailsSheet(row: row)
        }
        .phrenSingleSelectSheet(isPresented: $showStatus, title: "Task status",
                                options: statusOptions, selection: $status,
                                rowPrefix: "tasks-status")
    }

    private var hasFilters: Bool {
        !tasks.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || tasks.priority != nil || tasks.age != .all
            || (!isProjectScoped && (tasks.selectedProject != nil || model.storeFilter != nil))
    }

    private func clearFilters() {
        tasks.query = ""
        tasks.priority = nil
        tasks.age = .all
        if !isProjectScoped {
            tasks.selectedProject = nil
            model.storeFilter = nil
        }
    }

    /// One section header: the project name in its own colour, Active and
    /// Queue chips, and a chevron. The whole row is the fold target, at
    /// least 44 points tall; at accessibility sizes the name leads and the
    /// chips wrap beneath it.
    private func sectionHeader(_ group: TaskSectionGroup) -> some View {
        let folded = collapsedProjects.contains(group.project)
        return Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { toggleSection(group.project) }
        } label: {
            sectionHeaderLabel(group, folded: folded)
                .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(group.project), \(countPhrase(group))")
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("tasks-section-toggle:\(group.project)")
        .phrenContainerMarker("tasks-section:\(group.project)", label: group.project,
                              value: countPhrase(group))
        .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }

    /// The counts this status's chips carry, as one spoken phrase: the
    /// sections the filter draws, each with its project's own number.
    private func countPhrase(_ group: TaskSectionGroup) -> String {
        var parts: [String] = []
        if status.sections.contains(.active) { parts.append("\(group.activeCount) active") }
        if status.sections.contains(.queue) { parts.append("\(group.queueCount) queue") }
        if status.sections.contains(.done) { parts.append("\(group.doneCount) done") }
        return parts.joined(separator: ", ")
    }

    /// The chips beside a header: one per section the status draws, each
    /// omitted when its count is zero.
    @ViewBuilder
    private func countChips(_ group: TaskSectionGroup) -> some View {
        if status.sections.contains(.active), group.activeCount > 0 {
            PhrenChip(text: "\(group.activeCount) active", color: PhrenTheme.success)
        }
        if status.sections.contains(.queue), group.queueCount > 0 {
            PhrenChip(text: "\(group.queueCount) queue", color: PhrenTheme.textSecondary)
        }
        if status.sections.contains(.done), group.doneCount > 0 {
            PhrenChip(text: "\(group.doneCount) done", color: PhrenTheme.textMuted)
        }
    }

    @ViewBuilder
    private func sectionHeaderLabel(_ group: TaskSectionGroup, folded: Bool) -> some View {
        let name = Text(group.project)
            .foregroundStyle(PhrenTheme.projectColor(storeId: group.storeId, project: group.project))
            .plainListSectionTypography()
            .padding(.leading, 14)
        let chevron = Image(systemName: "chevron.down")
            .font(.caption2.weight(.semibold)).foregroundStyle(PhrenTheme.textDim)
            .rotationEffect(.degrees(folded ? -90 : 0))
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    name
                    Spacer(minLength: 0)
                    chevron.padding(.trailing, 14)
                }
                PhrenFlowLayout(spacing: PhrenTheme.Space.small) {
                    countChips(group)
                }
                .padding(.leading, 14)
            }
        } else {
            HStack(spacing: 8) {
                name
                countChips(group)
                Spacer(minLength: 0)
                chevron.padding(.trailing, 14)
            }
        }
    }

    /// Above the sections: fold every visible section, or unfold them when
    /// all visible ones are already folded. Folds on projects filtered off
    /// screen are left alone either way.
    private func allSectionsControl(_ groups: [TaskSectionGroup]) -> some View {
        let visible = Set(groups.map(\.project))
        let allFolded = !visible.isEmpty && visible.allSatisfy { collapsedProjects.contains($0) }
        return Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                setCollapsed(allFolded ? collapsedProjects.subtracting(visible)
                                       : collapsedProjects.union(visible))
            }
        } label: {
            HStack(spacing: 8) {
                Text("All").plainListSectionTypography().padding(.leading, 14)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold)).foregroundStyle(PhrenTheme.textDim)
                    .rotationEffect(.degrees(allFolded ? -90 : 0))
                    .padding(.trailing, 14)
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(allFolded ? "Expand all sections" : "Collapse all sections")
        .accessibilityIdentifier("tasks-section-all")
        .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }

    /// The status drop-down's five rows: Open (Active plus Queue), Active,
    /// Backlog, Done, All. Their ids become `tasks-status:<value>`.
    private var statusOptions: [PhrenOption<TaskStatus>] {
        TaskStatus.allCases.map { PhrenOption(id: $0.rawValue, value: $0, title: $0.title) }
    }

    private func controls(visibleCount: Int, writableCount: Int) -> some View {
        @Bindable var tasks = tasks
        @Bindable var model = model
        return HStack(spacing: 0) {
            PhrenSingleSelect(options: statusOptions, selection: $status,
                              placeholder: "Task status", identifier: "tasks-status",
                              isPresented: $showStatus)
                .disabled(tasks.isMoving)
            Text(tasks.isSelecting ? "\(tasks.selectedIDs.count)/\(visibleCount)" : visibleCount.formatted())
                .padding(.horizontal, PhrenTheme.Space.small)
                .foregroundStyle(PhrenTheme.textMuted)
            Spacer(minLength: 4)
            if tasks.isSelecting {
                Button(tasks.selectedIDs.count == writableCount ? "Deselect all" : "Select all") {
                    // Only rows the person can see: a folded section's work
                    // must not join a bulk move.
                    let writableRows = currentWritableRows().filter { !collapsedProjects.contains($0.project) }
                    tasks.selectedIDs = tasks.selectedIDs.count == writableRows.count ? [] : Set(writableRows.map(\.id))
                }
                .disabled(tasks.isMoving)
                .frame(minHeight: 44)
                .padding(.horizontal, 8)
            } else {
                Button {
                    tasks.showSearch.toggle()
                    searchFocused = tasks.showSearch
                    if !tasks.showSearch { tasks.query = "" }
                } label: {
                    Image(systemName: "magnifyingglass").frame(width: 44, height: 44)
                }
                .accessibilityLabel(tasks.showSearch ? "Hide task search" : "Search tasks")
                .accessibilityIdentifier("task-search-toggle")
                Menu {
                    Picker("Priority", selection: $tasks.priority) {
                        Text("Any priority").tag(PhrenTask.Priority?.none)
                        ForEach(PhrenTask.Priority.allCases, id: \.self) { value in
                            Text(value.rawValue.capitalized).tag(PhrenTask.Priority?.some(value))
                        }
                    }
                    Picker("Created", selection: $tasks.age) {
                        ForEach(TaskAge.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    if !isProjectScoped {
                        Picker("Project", selection: $tasks.selectedProject) {
                            Text("All projects").tag(String?.none)
                            ForEach(tasks.projectNames, id: \.self) { Text($0).tag(String?.some($0)) }
                        }
                        if model.hasMultipleStores {
                            Picker("Store", selection: $model.storeFilter) {
                                Text("All stores").tag(String?.none)
                                ForEach(model.storeDescriptors) { Text($0.displayName).tag(String?.some($0.id)) }
                            }
                        }
                    }
                    if hasFilters { Button("Clear filters", action: clearFilters) }
                } label: {
                    Image(systemName: hasFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(hasFilters ? "Task filters, applied" : "Task filters")
                .accessibilityIdentifier("task-filters")
                Menu {
                    Picker("Sort tasks", selection: $sort) {
                        ForEach(TaskSort.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Sort tasks, \(sort.rawValue)")
                .accessibilityIdentifier("task-sort")
            }
        }
        .font(.subheadline)
        .buttonStyle(.plain)
        .foregroundStyle(PhrenTheme.accent)
        .padding(.leading, 20)
        .padding(.trailing, 8)
        .accessibilityElement(children: .contain)
        .phrenContainerMarker("task-controls", label: "Task controls")
    }

    /// The + button is disabled cross-store when no (store, project) pair is
    /// writable — explain why, rather than leaving the empty state silent
    /// about a control the user can see but can't press.
    private var emptyMessage: String {
        if !isProjectScoped && addTargets.isEmpty {
            return "No writable store yet — your GitHub token needs Contents: Read and write on the store repo before you can add tasks."
        }
        return "Add a task with the + button."
    }

    /// Actions resolve the current selection at tap time, since sync or store
    /// permissions may have changed since the last render.
    private func currentWritableRows() -> [TaskListRow] {
        tasks.rows(for: status, sort: sort, scope: scope, model: model)
            .filter { model.canWrite(storeId: $0.storeId, project: $0.project) }
    }

    private var selectionActions: some View {
        HStack(spacing: 8) {
            ForEach(TaskMove.allCases, id: \.self) { action in
                Button {
                    move(currentWritableRows().filter { tasks.selectedIDs.contains($0.id) }, using: action)
                } label: {
                    Label(action.rawValue, systemImage: action.symbol)
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .accessibilityIdentifier("task-bulk-\(action.rawValue)")
                .disabled(tasks.selectedIDs.isEmpty || tasks.isMoving || status.sections == [action.section])
            }
        }
        .padding(.horizontal, 12)
        .background(PhrenTheme.surface)
        .tint(PhrenTheme.accent)
    }

    private func select(_ row: TaskListRow) {
        guard !tasks.isMoving, model.canWrite(storeId: row.storeId, project: row.project) else { return }
        if !tasks.selectedIDs.insert(row.id).inserted { tasks.selectedIDs.remove(row.id) }
    }

    private func taskRows(_ items: [TaskListRow]) -> some View {
        ForEach(items) { row in
            let canWrite = !tasks.isMoving && model.canWrite(storeId: row.storeId, project: row.project)
            TaskRow(
                row: row,
                showProject: !isProjectScoped,
                showStore: !isProjectScoped && model.hasMultipleStores,
                canWrite: canWrite,
                selection: tasks.isSelecting ? tasks.selectedIDs.contains(row.id) : nil,
                onRead: { if tasks.isSelecting { select(row) } else { reading = row } }
            ) {
                if tasks.isSelecting { select(row) }
                else { move([row], using: row.task.checked ? .start : .done) }
            }
            .equatable()
            .padding(.horizontal, 12).padding(.vertical, 8)
            .sessionCard()
            .overlay(alignment: .leading) {
                if let priority = row.task.priority {
                    PhrenRail(color: priority.color).padding(.vertical, 10)
                }
            }
            .separatedSessionRow()
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                if canWrite && !tasks.isSelecting {
                    if row.task.section != .active {
                        Button { move([row], using: .start) } label: { Label("Start", systemImage: "play") }
                            .tint(PhrenTheme.accent)
                    }
                    if row.task.section != .done {
                        Button { move([row], using: .done) } label: { Label("Done", systemImage: "checkmark") }
                            .tint(PhrenTheme.success)
                    }
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if canWrite && !tasks.isSelecting {
                    Button(role: .destructive) { delete(row) } label: { Label("Delete", systemImage: "trash") }
                    Button { editing = row } label: { Label("Edit", systemImage: "pencil") }
                        .tint(PhrenTheme.accent)
                    if row.task.section != .queue {
                        Button { move([row], using: .backlog) } label: { Label("Backlog", systemImage: "tray") }
                            .tint(PhrenTheme.textDim)
                    }
                }
            }
            .contextMenu {
                if canWrite && !tasks.isSelecting {
                    ForEach(TaskMove.allCases.filter { $0.section != row.task.section }, id: \.self) { action in
                        Button { move([row], using: action) } label: { Label(action.rawValue, systemImage: action.symbol) }
                    }
                    Button { editing = row } label: { Label("Edit", systemImage: "pencil") }
                    Button(role: .destructive) { delete(row) } label: { Label("Delete", systemImage: "trash") }
                }
            }
        }
    }

    private func move(_ rows: [TaskListRow], using action: TaskMove) {
        guard !tasks.isMoving, !rows.isEmpty else { return }
        tasks.isMoving = true
        let wasSelecting = tasks.isSelecting
        Task {
            var failed: Set<String> = []
            var failureMessage: String?
            for row in rows {
                do {
                    guard model.canWrite(storeId: row.storeId, project: row.project) else {
                        throw StoreWriteError.readOnly(row.storeName)
                    }
                    try await model.enqueue(action.operation(for: row), in: row.storeId)
                } catch {
                    failed.insert(row.id)
                    failureMessage = error.localizedDescription
                }
            }
            await model.refresh()
            tasks.selectedIDs = failed
            model.lastActionError = failureMessage.map { "\(failed.count) task(s) couldn't move. \($0)" }
            tasks.isMoving = false
            if wasSelecting && failed.isEmpty {
                tasks.isSelecting = false
                status = TaskStatus(action.section)
            }
        }
    }

    private func delete(_ row: TaskListRow) {
        Task {
            await model.perform(.removeTask(
                project: row.project,
                match: row.task.stableId ?? row.task.line
            ), in: row.storeId)
        }
    }
}

/// Task composer with an explicit destination picker when the target is
/// ambiguous (multiple stores/projects).
struct AddTaskSheet: View {
    struct Target: Identifiable, Hashable {
        let storeId: String
        let storeName: String
        let project: String
        var id: String { "\(storeId)|\(project)" }
    }

    let scope: TaskListView.Scope
    let targets: [Target]

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var selectedTarget: Target?

    init(scope: TaskListView.Scope, targets: [(storeId: String, storeName: String, project: String)]) {
        self.scope = scope
        self.targets = targets.map { Target(storeId: $0.storeId, storeName: $0.storeName, project: $0.project) }
    }

    private var fixedTarget: (storeId: String, project: String)? {
        if case .project(let storeId, let project) = scope { return (storeId, project) }
        if targets.count == 1 { return (targets[0].storeId, targets[0].project) }
        return nil
    }

    private func targetLabel(_ target: Target) -> String {
        model.hasMultipleStores ? "\(target.project) · \(target.storeName)" : target.project
    }

    var body: some View {
        NavigationStack {
            PhrenForm {
                TextField("Task", text: $text, axis: .vertical)
                    .lineLimit(2...6)
                if fixedTarget == nil {
                    Picker("Project", selection: $selectedTarget) {
                        Text("Choose…").tag(Target?.none)
                        ForEach(targets) { target in
                            Text(targetLabel(target)).tag(Target?.some(target))
                        }
                    }
                }
            }
            .navigationTitle("Add to Backlog")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        submit()
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || resolvedTarget() == nil)
                }
            }
        }
    }

    private func resolvedTarget() -> (storeId: String, project: String)? {
        if let fixedTarget { return fixedTarget }
        guard let selectedTarget else { return nil }
        return (selectedTarget.storeId, selectedTarget.project)
    }

    private func submit() {
        guard let target = resolvedTarget() else { return }
        let value = text
        Task {
            await model.perform(.addTask(project: target.project, text: value), in: target.storeId)
        }
    }
}

struct TaskRow: View, Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.showProject == rhs.showProject && lhs.showStore == rhs.showStore
            && lhs.canWrite == rhs.canWrite && lhs.selection == rhs.selection
    }

    let row: TaskListRow
    let showProject: Bool
    let showStore: Bool
    let canWrite: Bool
    var selection: Bool? = nil
    let onRead: () -> Void
    let onToggle: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onToggle) {
                Image(systemName: glyphName)
                    .foregroundStyle(glyphColor)
                    .font(.title3)
            }
            .buttonStyle(.plain)
            .disabled(!canWrite)
            .accessibilityLabel(selection.map { $0 ? "Deselect task" : "Select task" } ?? (row.task.checked ? "Reopen task" : "Complete task"))
            .accessibilityIdentifier("task-select:\(row.id)")

            Button(action: onRead) {
              VStack(alignment: .leading, spacing: 5) {
                Text(.init(displayLine))
                    .font(.callout)
                    .strikethrough(row.task.checked)
                    .foregroundStyle(isDone ? PhrenTheme.textMuted : PhrenTheme.text)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 6) {
                    if showProject {
                        TagChip(text: row.project, role: .project)
                    }
                    if showStore {
                        TagChip(text: row.storeId, role: .store)
                    }
                    if let priority = row.task.priority {
                        TagChip(text: priority.rawValue, color: priority.color)
                    }
                    if row.task.pinned == true {
                        Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange)
                    }
                    if let issue = row.task.githubIssue {
                        Text("#\(issue)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(PhrenTheme.textMuted)
              }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task-detail:\(row.id)")
        }
        .padding(.vertical, 2)
    }

    private var isDone: Bool { row.task.section == .done }

    /// A done row keeps an outline check, muted; selection mode still fills
    /// the mark when this row is one of the chosen ones.
    private var glyphName: String {
        if let selection { return selection ? "checkmark.circle.fill" : "circle" }
        return isDone ? "checkmark.circle" : "circle"
    }

    private var glyphColor: Color {
        selection != nil ? PhrenTheme.accent : PhrenTheme.textMuted
    }

    /// Done rows caption their done date (last activity, falling back to the
    /// creation date); open rows keep the creation caption.
    private var caption: String {
        if isDone {
            let doneDate = TaskBrowsing.creationDate(row.task.lastActivity)
                ?? TaskBrowsing.creationDate(row.task.createdAt)
            return doneDate.map { "Done " + $0.formatted(date: .abbreviated, time: .omitted) } ?? "Date unknown"
        }
        return TaskBrowsing.creationDate(row.task.createdAt).map {
            "Created " + $0.formatted(date: .abbreviated, time: .omitted)
        } ?? "Date unknown"
    }

    private var displayLine: String {
        TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line))
    }
}

extension PhrenTask.Priority {
    var color: Color {
        switch self {
        case .high: return PhrenTheme.red
        case .medium: return PhrenTheme.amber
        case .low: return PhrenTheme.textDim
        }
    }
}

/// Reading a long task never opens a text editor or changes its state.
struct TaskDetailsSheet: View {
    @Environment(AppModel.self) private var model
    @State private var editing = false
    @State private var launchingAgent = false
    let row: TaskListRow

    private var currentRow: TaskListRow {
        let task = model.snapshot(for: row.storeId).tasks[row.project]?.allItems.first {
            if let stableID = row.task.stableId { return $0.stableId == stableID }
            return $0.id == row.task.id
        }
        return TaskListRow(storeId: row.storeId, storeName: row.storeName,
                           project: row.project, task: task ?? row.task)
    }

    var body: some View {
        let row = currentRow
        PhrenList {
                if !row.task.checked {
                    Section {
                        Button {
                            launchingAgent = true
                        } label: {
                            PhrenRow(icon: "sparkles", title: "Start an agent on this task")
                        }
                        .buttonStyle(.plain)
                        .phrenIdentifier("task-start-agent")
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    } header: {
                        Text("Agent")
                    } footer: {
                        Text("Choose a computer and harness. Phren sends this task to the new agent and marks backlog work active after delivery succeeds.")
                    }
                }
                Section {
                    Text(.init(TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line))))
                        .textSelection(.enabled)
                }
                if let context = row.task.context {
                    Section("Context") { Text(.init(context)).textSelection(.enabled) }
                }
                Section {
                    LabeledContent("Project", value: row.project)
                    LabeledContent("Store", value: row.storeId)
                    LabeledContent("Status", value: row.task.section == .queue ? "Backlog" : row.task.section.rawValue)
                    LabeledContent("Created", value: TaskBrowsing.creationDate(row.task.createdAt).map {
                        $0.formatted(date: .long, time: .shortened)
                    } ?? "Date unknown")
                    if let priority = row.task.priority { LabeledContent("Priority", value: priority.rawValue) }
                }
            }
            .navigationTitle("Task details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.canWrite(storeId: row.storeId, project: row.project) {
                    ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } }
                }
            }
            .phrenScreen()
            .sheet(isPresented: $editing) { TaskEditSheet(row: row) }
            .sheet(isPresented: $launchingAgent) {
                LaunchSessionView(storeID: row.storeId, project: row.project,
                                  taskRequest: TaskAgentRequest(row: row))
            }
    }
}

struct TaskEditSheet: View {
    let row: TaskListRow

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var priority: PhrenTask.Priority?
    @State private var section: PhrenTask.Section
    @State private var pinned: Bool

    init(row: TaskListRow) {
        self.row = row
        _text = State(initialValue: TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line)))
        _priority = State(initialValue: row.task.priority)
        _section = State(initialValue: row.task.section)
        _pinned = State(initialValue: row.task.pinned ?? false)
    }

    var body: some View {
        NavigationStack {
            PhrenForm {
                TextField("Task", text: $text, axis: .vertical)
                    .lineLimit(2...6)
                PhrenSwitch("Pinned", isOn: $pinned)
                Picker("Priority", selection: $priority) {
                    Text("none").tag(PhrenTask.Priority?.none)
                    ForEach(PhrenTask.Priority.allCases, id: \.self) { p in
                        Text(p.rawValue).tag(PhrenTask.Priority?.some(p))
                    }
                }
                Picker("Section", selection: $section) {
                    ForEach(PhrenTask.Section.allCases, id: \.self) { s in
                        Text(s == .queue ? "Backlog" : s.rawValue).tag(s)
                    }
                }
            }
            .navigationTitle("Edit task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        // TasksFile.update recomputes `pinned` from the text
                        // it's given, so the tag has to be re-appended here —
                        // otherwise saving silently unpins the task.
                        var newText = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if pinned {
                            newText += " [pinned]"
                        }
                        let newPriority = priority
                        let newSection = section != row.task.section ? section : nil
                        Task {
                            await model.perform(.updateTask(
                                project: row.project,
                                match: row.task.stableId ?? row.task.line,
                                text: newText,
                                priority: newPriority?.rawValue,
                                section: newSection?.rawValue
                            ), in: row.storeId)
                        }
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
