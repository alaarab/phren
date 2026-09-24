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
    @State private var showFilters = false
    @State private var showSort = false
    @State private var actionRow: TaskListRow?
    @State private var editing: TaskListRow?
    @State private var reading: TaskListRow?
    @State private var launchingAgent: TaskListRow?
    @State private var moveNotice: TaskMoveNotice?
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
    /// its first task; the write path creates tasks.md if missing.
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
            if let moveNotice { moveNoticeLine(moveNotice) }
            if tasks.showSearch && !tasks.isSelecting {
                PhrenSearchField(text: $tasks.query, placeholder: "Search tasks", identifier: "task-search-field",
                                 focus: $searchFocused, onSubmit: { searchFocused = false })
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
        .onChange(of: status) { _, newStatus in
            tasks.selectedIDs.removeAll()
            if let moveNotice, moveNotice.destination.sections.allSatisfy(newStatus.sections.contains) {
                self.moveNotice = nil
            }
        }
        .task(id: noticeTimerID) {
            guard let id = noticeTimerID else { return }
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            if moveNotice?.id == id { moveNotice = nil }
        }
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
            TaskEditSheet(row: row, onMoved: taskMoved)
        }
        .navigationDestination(item: $reading) { row in
            TaskDetailsSheet(row: row, onMoved: taskMoved)
        }
        .sheet(item: $launchingAgent) { row in
            LaunchSessionView(storeID: row.storeId, project: row.project,
                              taskRequest: TaskAgentRequest(row: row), onTaskMoved: taskMoved)
        }
        .phrenSingleSelectSheet(isPresented: $showStatus, title: "Task status",
                                options: statusOptions, selection: $status,
                                rowPrefix: "tasks-status")
        .phrenActionSheet(isPresented: $showFilters, title: "Task filters", actions: filterActions,
                          identifier: "task-filters-sheet")
        .phrenSingleSelectSheet(isPresented: $showSort, title: "Sort tasks", options: sortOptions,
                                selection: $sort, rowPrefix: "task-sort")
        .phrenActionSheet(isPresented: $actionRow.isPresent(), title: "Task actions", actions: rowActions,
                          identifier: "task-actions-sheet")
    }

    /// The filter sheet's rows: the four pickers as radio actions, each
    /// committing and closing on tap.
    private var filterActions: [PhrenControlAction] {
        var actions: [PhrenControlAction] = [
            PhrenControlAction(id: "any-priority", title: "Any priority", icon: "flag",
                               isSelected: tasks.priority == nil) { tasks.priority = nil },
        ]
        actions += PhrenTask.Priority.allCases.map { value in
            PhrenControlAction(id: "priority-\(value.rawValue)", title: value.rawValue.capitalized, icon: "flag",
                               isSelected: tasks.priority == value) { tasks.priority = value }
        }
        actions += TaskAge.allCases.map { value in
            PhrenControlAction(id: "age-\(value.rawValue)", title: value.rawValue, icon: "calendar",
                               isSelected: tasks.age == value) { tasks.age = value }
        }
        if !isProjectScoped {
            actions.append(PhrenControlAction(id: "all-projects", title: "All projects", icon: "square.grid.2x2",
                                              isSelected: tasks.selectedProject == nil) { tasks.selectedProject = nil })
            actions += tasks.projectNames.map { name in
                PhrenControlAction(id: "project-\(name)", title: name, icon: "square.grid.2x2",
                                   isSelected: tasks.selectedProject == name) { tasks.selectedProject = name }
            }
            if model.hasMultipleStores {
                actions.append(PhrenControlAction(id: "all-stores", title: "All stores", icon: "externaldrive",
                                                  isSelected: model.storeFilter == nil) { model.storeFilter = nil })
                actions += model.storeDescriptors.map { store in
                    PhrenControlAction(id: "store-\(store.id)", title: store.displayName, icon: "externaldrive",
                                       isSelected: model.storeFilter == store.id) { model.storeFilter = store.id }
                }
            }
        }
        if hasFilters {
            actions.append(PhrenControlAction(id: "clear", title: "Clear filters", icon: "xmark.circle") { clearFilters() })
        }
        return actions
    }

    private var sortOptions: [PhrenOption<TaskSort>] {
        TaskSort.allCases.map { PhrenOption(id: $0.rawValue, value: $0, title: $0.rawValue) }
    }

    private var rowActions: [PhrenControlAction] {
        guard let row = actionRow, !tasks.isSelecting,
              !tasks.isMoving, model.canWrite(storeId: row.storeId, project: row.project) else { return [] }
        var actions: [PhrenControlAction] = []
        if !row.task.checked {
            actions.append(PhrenControlAction(id: "start", title: "Start", icon: "play",
                                              caption: "Start an agent on this task") { start(row) })
        }
        actions += TaskMove.allCases.filter { $0.section != row.task.section }.map { action in
            PhrenControlAction(id: action.id, title: action.rawValue, icon: action.symbol) {
                move([row], using: action)
            }
        }
        actions.append(PhrenControlAction(id: "edit", title: "Edit", icon: "pencil") { editing = row })
        actions.append(PhrenControlAction(id: "delete", title: "Delete", icon: "trash", role: .destructive) { delete(row) })
        return actions
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

    /// One section header: the project name in its own color, Active and
    /// Queue chips, and a chevron. The whole row is the fold target, at
    /// least 44 points tall; at accessibility sizes the name leads and the
    /// chips wrap beneath it.
    private func sectionHeader(_ group: TaskSectionGroup) -> some View {
        let folded = collapsedProjects.contains(group.project)
        return ZStack(alignment: .topLeading) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { toggleSection(group.project) }
            } label: {
                sectionHeaderLabel(group, folded: folded)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(group.project), \(countPhrase(group))")
            .accessibilityAddTraits([.isButton, .isHeader])
            .accessibilityIdentifier("tasks-section-toggle:\(group.project)")
        }
        .accessibilityElement(children: .contain)
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
                Button { showFilters = true } label: {
                    Image(systemName: hasFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(hasFilters ? "Task filters, applied" : "Task filters")
                .accessibilityIdentifier("task-filters")
                Button { showSort = true } label: {
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
    /// writable; explain why, rather than leaving the empty state silent
    /// about a control the user can see but can't press.
    private var emptyMessage: String {
        if !isProjectScoped && addTargets.isEmpty {
            return "No writable store yet. Your GitHub token needs Contents: Read and write on the store repo before you can add tasks."
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
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        return VStack(spacing: 0) {
            if tasks.selectedIDs.count == 1,
               let row = tasks.visibleRows.first(where: { tasks.selectedIDs.contains($0.id) }), !row.task.checked {
                Button { start(row) } label: {
                    PhrenRow(icon: "play", title: "Start", chevron: false)
                }
                .phrenIdentifier("task-bulk-Start")
                .disabled(tasks.isMoving)
            }
            layout {
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
        }
        .buttonStyle(.plain)
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
                else { move([row], using: row.task.checked ? .active : .done) }
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
                    if !row.task.checked {
                        Button { start(row) } label: { Label("Start", systemImage: "play") }
                            .tint(PhrenTheme.accent)
                            .phrenIdentifier("task-swipe-start:\(row.id)")
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
            .overlay(alignment: .trailing) {
                if canWrite && !tasks.isSelecting {
                    PhrenIconButton(icon: "ellipsis", label: "Task actions") { actionRow = row }
                        .phrenIdentifier("task-actions:\(row.id)")
                        .padding(.trailing, 4)
                }
            }
        }
    }

    private func move(_ rows: [TaskListRow], using action: TaskMove) {
        let rows = rows.filter { $0.task.section != action.section }
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
            showMoveNotice(rows.filter { !failed.contains($0.id) }, to: action.section)
            if wasSelecting && failed.isEmpty {
                tasks.isSelecting = false
            }
        }
    }

    private func start(_ row: TaskListRow) {
        guard !tasks.isMoving, tasks.selectedIDs.count <= 1,
              let current = currentWritableRows().first(where: { $0.id == row.id }), !current.task.checked else { return }
        launchingAgent = current
    }

    private func taskMoved(_ row: TaskListRow, to section: PhrenTask.Section) {
        showMoveNotice([row], to: section)
    }

    private func showMoveNotice(_ rows: [TaskListRow], to section: PhrenTask.Section) {
        moveNotice = TaskMoveNotice(rows: rows, to: section, from: status)
    }

    /// Let the person see the notice after returning from an editor or chat.
    private var noticeTimerID: UUID? {
        reading == nil && editing == nil && launchingAgent == nil ? moveNotice?.id : nil
    }

    private func moveNoticeLine(_ notice: TaskMoveNotice) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 8))
        return layout {
            Text(notice.message)
                .font(PhrenTypography.caption)
                .foregroundStyle(PhrenTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .phrenIdentifier("task-move-notice")
            Button {
                status = notice.destination
                setCollapsed(collapsedProjects.subtracting(notice.projects))
                tasks.selectedIDs.removeAll()
                tasks.isSelecting = false
                moveNotice = nil
            } label: {
                Text("View \(notice.destination.title)")
                    .font(PhrenTypography.subheadline)
                    .foregroundStyle(PhrenTheme.accent)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .background(PhrenTheme.surfaceRaised, in: Capsule())
            }
            .buttonStyle(.plain)
            .phrenIdentifier("task-move-follow")
        }
        .padding(.horizontal, 16)
        .background(PhrenTheme.surface)
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

