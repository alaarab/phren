import SwiftUI
import PhrenKit

struct TasksView: View {
    var body: some View {
        NavigationStack {
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

struct TaskListRow: Identifiable {
    let storeId: String
    let storeName: String
    let project: String
    let task: PhrenTask
    var id: String { "\(storeId)/\(project)/\(task.stableId ?? task.id)" }
}

/// Task list: cross-store + cross-project in the Tasks tab, or scoped to one
/// store's project inside project detail.
struct TaskListView: View {
    enum Scope {
        case all
        case project(storeId: String, project: String)
    }

    let scope: Scope

    @Environment(AppModel.self) private var model
    @State private var selectedProject: String?
    @State private var showAdd = false
    @State private var editing: TaskListRow?
    @State private var reading: TaskListRow?
    @AppStorage("tasks.section.v1") private var section: PhrenTask.Section = .queue
    @State private var query = ""
    @State private var showSearch = false
    @State private var isSelecting = false
    @State private var selectedIDs: Set<String> = []
    @State private var isMoving = false
    @FocusState private var searchFocused: Bool
    @State private var priority: PhrenTask.Priority?
    @State private var age: TaskAge = .all
    @AppStorage("tasks.sort.v1") private var sort: TaskSort = .manual

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

    private func rows(in section: PhrenTask.Section) -> [TaskListRow] {
        var result: [TaskListRow] = []
        if case .project(let scopeStore, let scopeProject) = scope {
            // Project scope reads the store's snapshot directly — the global
            // store filter must not blank out a project-detail tab.
            if let doc = model.snapshot(for: scopeStore).tasks[scopeProject] {
                for task in doc.items(in: section) {
                    result.append(TaskListRow(storeId: scopeStore, storeName: model.storeName(for: scopeStore),
                                              project: scopeProject, task: task))
                }
            }
        } else {
            for (storeId, storeName, doc) in model.mergedTaskDocs {
                if let selectedProject, doc.project != selectedProject { continue }
                for task in doc.items(in: section) {
                    result.append(TaskListRow(storeId: storeId, storeName: storeName,
                                              project: doc.project, task: task))
                }
            }
        }
        return TaskBrowsing.rows(result, query: query, priority: priority, age: age, sort: sort)
    }

    private var projectNames: [String] {
        // Key paths can't traverse tuple elements — use a closure.
        Array(Set(model.mergedTaskDocs.map { $0.doc.project })).sorted()
    }

    /// Add targets: every writable (store, project) pair. Derived from the
    /// project list (not just existing task docs) so a project can receive
    /// its first task — the write path creates tasks.md if missing.
    private var addTargets: [(storeId: String, storeName: String, project: String)] {
        model.writableProjects.map { ($0.storeId, $0.storeName, $0.project.name) }
    }

    var body: some View {
        // Sorting and date parsing scale with the task count. Share one result
        // across this render; the next observed change computes fresh rows.
        let visibleRows = rows(in: section)
        let writableRows = visibleRows.filter { model.canWrite(storeId: $0.storeId, project: $0.project) }
        VStack(spacing: 0) {
            controls(visibleCount: visibleRows.count, writableCount: writableRows.count)
            if showSearch && !isSelecting {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(PhrenTheme.textMuted)
                    TextField("Search tasks", text: $query)
                        .focused($searchFocused)
                        .submitLabel(.search)
                        .onSubmit { searchFocused = false }
                        .accessibilityIdentifier("task-search-field")
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .accessibilityLabel("Clear search")
                    }
                }
                .font(.callout)
                .padding(10)
                .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
            }
            PhrenList {
                if !visibleRows.isEmpty {
                    taskRows(visibleRows)
                } else if section == .active && !hasFilters {
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
                        let backlogCount = rows(in: .queue).count
                        if backlogCount > 0 {
                            Button("View backlog (\(backlogCount))") { section = .queue }
                        }
                    }
                }
            }
            .contentMargins(.top, 8, for: .scrollContent)
            .overlay {
                if visibleRows.isEmpty && (section != .active || hasFilters) {
                    VStack(spacing: 8) {
                        PhrenEmptyState(title: hasFilters ? "No matching tasks" : "No \(section == .queue ? "backlog" : "completed") tasks",
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
            if isSelecting { selectionActions }
        }
        .onChange(of: section) { _, _ in selectedIDs.removeAll() }
        .onChange(of: visibleRows.map(\.id)) { _, ids in selectedIDs.formIntersection(ids) }
        .toolbar {
            if !isReadOnlyScope {
                ToolbarItem(placement: .topBarLeading) {
                    Button(isSelecting ? "Cancel" : "Select") {
                        isSelecting.toggle()
                        selectedIDs.removeAll()
                        searchFocused = false
                    }
                    .accessibilityIdentifier("task-selection-mode")
                    .disabled(isMoving || (!isSelecting && writableRows.isEmpty))
                }
            }
            if !isReadOnlyScope && !isSelecting {
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
        .sheet(item: $reading) { row in
            TaskDetailsSheet(row: row)
        }
    }

    private var hasFilters: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || priority != nil || age != .all
            || (!isProjectScoped && (selectedProject != nil || model.storeFilter != nil))
    }

    private func clearFilters() {
        query = ""
        priority = nil
        age = .all
        if !isProjectScoped {
            selectedProject = nil
            model.storeFilter = nil
        }
    }

    private func controls(visibleCount: Int, writableCount: Int) -> some View {
        @Bindable var model = model
        return HStack(spacing: 0) {
            Menu {
                Picker("Task status", selection: $section) {
                    Text("Active").tag(PhrenTask.Section.active)
                    Text("Backlog").tag(PhrenTask.Section.queue)
                    Text("Done").tag(PhrenTask.Section.done)
                }
            } label: {
                HStack(spacing: 6) {
                    Text(section == .queue ? "Backlog" : section.rawValue).fontWeight(.semibold)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    Text(isSelecting ? "\(selectedIDs.count)/\(visibleCount)" : visibleCount.formatted())
                        .foregroundStyle(PhrenTheme.textMuted)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityIdentifier("task-status")
            .disabled(isMoving)
            Spacer(minLength: 4)
            if isSelecting {
                Button(selectedIDs.count == writableCount ? "Deselect all" : "Select all") {
                    let writableRows = currentWritableRows()
                    selectedIDs = selectedIDs.count == writableRows.count ? [] : Set(writableRows.map(\.id))
                }
                .disabled(isMoving)
                .frame(minHeight: 44)
                .padding(.horizontal, 8)
            } else {
                Button {
                    showSearch.toggle()
                    searchFocused = showSearch
                    if !showSearch { query = "" }
                } label: {
                    Image(systemName: "magnifyingglass").frame(width: 44, height: 44)
                }
                .accessibilityLabel(showSearch ? "Hide task search" : "Search tasks")
                .accessibilityIdentifier("task-search-toggle")
                Menu {
                    Picker("Priority", selection: $priority) {
                        Text("Any priority").tag(PhrenTask.Priority?.none)
                        ForEach(PhrenTask.Priority.allCases, id: \.self) { value in
                            Text(value.rawValue.capitalized).tag(PhrenTask.Priority?.some(value))
                        }
                    }
                    Picker("Created", selection: $age) {
                        ForEach(TaskAge.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    if !isProjectScoped {
                        Picker("Project", selection: $selectedProject) {
                            Text("All projects").tag(String?.none)
                            ForEach(projectNames, id: \.self) { Text($0).tag(String?.some($0)) }
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
        .accessibilityIdentifier("task-controls")
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
        rows(in: section).filter { model.canWrite(storeId: $0.storeId, project: $0.project) }
    }

    private var selectionActions: some View {
        HStack(spacing: 8) {
            ForEach(TaskMove.allCases, id: \.self) { action in
                Button {
                    move(currentWritableRows().filter { selectedIDs.contains($0.id) }, using: action)
                } label: {
                    Label(action.rawValue, systemImage: action.symbol)
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .accessibilityIdentifier("task-bulk-\(action.rawValue)")
                .disabled(selectedIDs.isEmpty || isMoving || section == action.section)
            }
        }
        .padding(.horizontal, 12)
        .background(PhrenTheme.surface)
        .tint(PhrenTheme.accent)
    }

    private func select(_ row: TaskListRow) {
        guard !isMoving, model.canWrite(storeId: row.storeId, project: row.project) else { return }
        if !selectedIDs.insert(row.id).inserted { selectedIDs.remove(row.id) }
    }

    @ViewBuilder
    private func taskRows(_ items: [TaskListRow]) -> some View {
        ForEach(items) { row in
            let canWrite = !isMoving && model.canWrite(storeId: row.storeId, project: row.project)
            TaskRow(
                row: row,
                showProject: !isProjectScoped,
                showStore: !isProjectScoped && model.hasMultipleStores,
                canWrite: canWrite,
                selection: isSelecting ? selectedIDs.contains(row.id) : nil,
                onRead: { if isSelecting { select(row) } else { reading = row } }
            ) {
                if isSelecting { select(row) }
                else { move([row], using: row.task.checked ? .start : .done) }
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                if canWrite && !isSelecting {
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
                if canWrite && !isSelecting {
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
                if canWrite && !isSelecting {
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
        guard !isMoving, !rows.isEmpty else { return }
        isMoving = true
        let wasSelecting = isSelecting
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
            selectedIDs = failed
            model.lastActionError = failureMessage.map { "\(failed.count) task(s) couldn't move. \($0)" }
            isMoving = false
            if wasSelecting && failed.isEmpty {
                isSelecting = false
                section = action.section
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

struct TaskRow: View {
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
                Image(systemName: (selection ?? row.task.checked) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selection != nil ? PhrenTheme.accent : (row.task.checked ? PhrenTheme.success : PhrenTheme.textMuted))
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
                        TagChip(text: priority.rawValue, color: priorityColor(priority))
                    }
                    if row.task.pinned == true {
                        Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange)
                    }
                    if let issue = row.task.githubIssue {
                        Text("#\(issue)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Text(TaskBrowsing.creationDate(row.task.createdAt).map {
                    "Created " + $0.formatted(date: .abbreviated, time: .omitted)
                } ?? "Date unknown")
                    .font(.caption2)
                    .foregroundStyle(PhrenTheme.textMuted)
              }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task-detail:\(row.id)")
        }
        .padding(.vertical, 2)
    }

    private var displayLine: String {
        TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line))
    }

    private func priorityColor(_ priority: PhrenTask.Priority) -> Color {
        switch priority {
        case .high: return PhrenTheme.red
        case .medium: return PhrenTheme.amber
        case .low: return PhrenTheme.textDim
        }
    }
}

/// Reading a long task never opens a text editor or changes its state.
private struct TaskDetailsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
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
        NavigationStack {
            PhrenList {
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
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                if model.canWrite(storeId: row.storeId, project: row.project) {
                    ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } }
                }
            }
            .phrenScreen()
            .sheet(isPresented: $editing) { TaskEditSheet(row: row) }
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
                Toggle("Pinned", isOn: $pinned)
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
