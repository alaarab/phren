import PhrenKit
import SwiftUI

struct SkillsView: View {
    @Environment(AppModel.self) private var model
    var project: String?
    var storeId: String?
    var returnToProject: (() -> Void)?
    @State private var query = ""
    @State private var creating = false
    @State private var created: StoreSkill?

    private var skills: [StoreSkill] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let available = storeId.map { id in
            model.skills(in: id).map { StoreSkill(storeId: id, storeName: model.storeName(for: id), skill: $0) }
        } ?? model.mergedSkills
        return available.filter { entry in
            (storeId == nil || entry.storeId == storeId)
                && (project == nil || entry.skill.scope == .global || entry.skill.scope.source == project)
                && (search.isEmpty || [entry.skill.name, entry.skill.content, entry.storeName,
                                     entry.skill.scope.source].contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }

    private var scopes: [String] {
        Set(skills.map { $0.skill.scope.source }).sorted {
            if $0 == "global" { return $1 != "global" }
            if $1 == "global" { return false }
            return $0 < $1
        }
    }

    private var canCreate: Bool {
        model.storeDescriptors.contains {
            $0.canPush && (storeId == nil || $0.id == storeId)
                && (storeId != nil || model.storeFilter == nil || $0.id == model.storeFilter)
        }
    }

    var body: some View {
        PhrenList {
            ForEach(scopes, id: \.self) { scope in
                Section(scope == "global" ? "Global skills" : scope) {
                    ForEach(skills.filter { $0.skill.scope.source == scope }.sorted {
                        if $0.skill.name != $1.skill.name { return $0.skill.name < $1.skill.name }
                        return $0.storeId < $1.storeId
                    }) { entry in
                        NavigationLink { SkillEditorView(entry: entry, returnToProject: returnToProject) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(entry.skill.title ?? entry.skill.name).font(.headline)
                                if let summary = entry.skill.summary, !summary.isEmpty {
                                    Text(summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                }
                                HStack {
                                    if model.hasMultipleStores { TagChip(text: entry.storeName, role: .store) }
                                    if !model.canPush(storeId: entry.storeId) { TagChip(text: "Read-only", role: .status) }
                                    if let preferences = try? model.skillPreferences(in: entry.storeId),
                                       preferences.explicitSetting(scope: entry.skill.scope.source, name: entry.skill.name) == false {
                                        TagChip(text: "Disabled", role: .status)
                                    }
                                    if project != nil && entry.skill.scope == .global {
                                        TagChip(text: "Global", role: .scope)
                                    }
                                    if !SkillFile.frontmatterWarnings(for: entry.skill.content).isEmpty {
                                        Label("Needs details", systemImage: "exclamationmark.triangle")
                                            .font(.caption).foregroundStyle(.orange)
                                    }
                                }
                            }.padding(.vertical, 3)
                        }
                        .accessibilityIdentifier("skill:\(entry.storeId):\(entry.skill.path)")
                    }
                }
            }
        }
        .overlay {
            if skills.isEmpty {
                PhrenEmptyState(title: query.isEmpty ? "No skills yet" : "No matching skills",
                                message: query.isEmpty ? "Create reusable instructions for your agents." : "Try another name, project, or phrase.")
            }
        }
        .navigationTitle("Skills")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search skills")
        .refreshable { await model.pullToRefresh() }
        .safeAreaInset(edge: .top, spacing: 0) { LiveStatusBar() }
        .phrenScreen()
        .toolbar {
            if let returnToProject {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back to project", systemImage: "xmark", action: returnToProject)
                        .accessibilityIdentifier("skills-return-to-project")
                }
            }
            if canCreate {
                ToolbarItem(placement: .primaryAction) {
                    Button { creating = true } label: { Label("New skill", systemImage: "plus") }
                }
            }
        }
        .sheet(isPresented: $creating) {
            NewSkillSheet(defaultProject: project, defaultStoreId: storeId) { created = $0 }
        }
        .navigationDestination(item: $created) { SkillEditorView(entry: $0, returnToProject: returnToProject) }
    }
}

struct SkillEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let entry: StoreSkill
    var returnToProject: (() -> Void)?
    @State private var draft: DocumentDraft?
    @State private var deleting: StoreSkill?
    @State private var moving: StoreSkill?
    @State private var error: String?
    @State private var busy = false

    private var current: StoreSkill? {
        model.skills(in: entry.storeId).first { $0.path == entry.skill.path }.map {
            StoreSkill(storeId: entry.storeId, storeName: entry.storeName, skill: $0)
        }
    }

    var body: some View {
        PhrenList {
            if let current {
                Section {
                    LabeledContent("Scope", value: current.skill.scope.source)
                    LabeledContent("Store", value: current.storeName)
                    if !model.canPush(storeId: entry.storeId) { Label("Read-only store", systemImage: "lock") }
                    if current.skill.format == .folder {
                        Text("This skill includes a folder. Editing changes its instructions; supporting files stay in the store.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Instructions") { DocumentPreview(content: current.skill.content) }
                Section {
                    if let preferences = try? model.skillPreferences(in: entry.storeId) {
                        if let enabled = preferences.explicitSetting(scope: current.skill.scope.source, name: current.skill.name) {
                            Toggle("Enabled for agents", isOn: Binding(
                                get: { enabled },
                                set: { value in Task { await toggle(current, enabled: value) } }
                            ))
                            .disabled(busy || !model.canPush(storeId: entry.storeId))
                        } else {
                            LabeledContent("Availability", value: "Computer settings")
                            Text("No synced choice yet. A computer may have a different local setting.")
                                .font(.caption).foregroundStyle(.secondary)
                            if model.canPush(storeId: entry.storeId) {
                                Button("Enable on linked computers") { Task { await toggle(current, enabled: true) } }.disabled(busy)
                                Button("Disable on linked computers") { Task { await toggle(current, enabled: false) } }.disabled(busy)
                            }
                        }
                    } else {
                        Label("Skill settings couldn't be read. Refresh or update phren before changing them.", systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.orange)
                    }
                } header: { Text("Availability") } footer: {
                    Text(current.skill.scope == .global
                         ? "Applies to this global skill in all projects. Linked computers apply the choice after syncing with an updated phren CLI."
                         : "Applies to this project's skill. Linked computers apply the choice after syncing with an updated phren CLI.")
                }
                Section {
                    Text(current.skill.path).font(.caption.monospaced()).foregroundStyle(.secondary)
                    ShareLink(item: current.skill.content) { Label("Share skill", systemImage: "square.and.arrow.up") }
                }
            } else {
                PhrenEmptyState(title: "Skill removed", message: "This skill is no longer in the store.")
            }
        }
        .navigationTitle(entry.skill.name)
        .navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
        .toolbar {
            if let returnToProject {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Back to project", systemImage: "xmark", action: returnToProject)
                        .accessibilityIdentifier("skills-return-to-project")
                }
            }
            if let current, model.canPush(storeId: entry.storeId) {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { draft = DocumentDraft(path: current.skill.path, content: current.skill.content) }.disabled(busy)
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button { moving = current } label: {
                        Label("Move to…", systemImage: "folder")
                    }
                    .disabled(busy)
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button(role: .destructive) { deleting = current } label: {
                        Label("Delete skill", systemImage: "trash")
                    }.disabled(busy)
                }
            }
        }
        .sheet(item: $draft) { DocumentEditorSheet(title: "Edit skill", storeId: entry.storeId, draft: $0) }
        .sheet(item: $moving) { MoveSkillSheet(entry: $0) { dismiss() } }
        .confirmationDialog("Delete \(entry.skill.name)?",
                            isPresented: $deleting.isPresent(),
                            titleVisibility: .visible) {
            if let deleting {
                Button("Delete skill", role: .destructive) { Task { await remove(deleting) } }
            }
        } message: {
            Text("The skill's instructions will be removed from \(entry.storeName) on sync."
                 + (entry.skill.format == .folder ? " Supporting files will remain in its folder." : ""))
        }
        .alert("Couldn't update skill", isPresented: $error.isPresent()) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func remove(_ entry: StoreSkill) async {
        busy = true
        defer { busy = false }
        do { try await model.deleteSkill(entry); dismiss() }
        catch { self.error = error.localizedDescription }
    }

    private func toggle(_ entry: StoreSkill, enabled: Bool) async {
        busy = true
        defer { busy = false }
        do { try await model.setSkillEnabled(entry, enabled: enabled) }
        catch { self.error = error.localizedDescription }
    }
}

private struct MoveSkillSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let entry: StoreSkill
    let onMoved: () -> Void
    @State private var scope = ""
    @State private var error: String?
    @State private var moving = false

    /// Destinations in the skill's own store, minus where it already lives.
    private var destinations: [String] {
        let projects = model.writableProjects.filter { $0.storeId == entry.storeId }.map(\.project.name)
        return (["global"] + projects.sorted()).filter { $0 != entry.skill.scope.source }
    }
    private var occupied: Bool {
        model.skills(in: entry.storeId).contains {
            $0.scope.source == scope && $0.name.lowercased() == entry.skill.name.lowercased()
        }
    }
    private var valid: Bool { destinations.contains(scope) && !occupied }

    var body: some View {
        NavigationStack {
            PhrenForm {
                Section {
                    Picker("Move to", selection: $scope) {
                        ForEach(destinations, id: \.self) { Text($0 == "global" ? "Global · all projects" : $0).tag($0) }
                    }
                    .accessibilityIdentifier("skill-move-destination")
                    if occupied {
                        Text("A skill named \(entry.skill.name) already exists there.").font(.caption).foregroundStyle(.red)
                    }
                } header: { Text("Destination") } footer: {
                    Text("Moves the skill's instructions out of \(entry.skill.scope.source) on sync."
                         + (entry.skill.format == .folder ? " Supporting files in its folder stay behind." : ""))
                }
            }
            .disabled(moving)
            .navigationTitle("Move \(entry.skill.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(moving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(moving ? "Moving…" : "Move") { Task { await move() } }
                        .disabled(!valid || moving)
                        .accessibilityIdentifier("skill-move-confirm")
                }
            }
            .overlay {
                if destinations.isEmpty {
                    PhrenEmptyState(title: "Nowhere to move", message: "This store has no other project to hold the skill.")
                }
            }
            .onAppear { if scope.isEmpty { scope = destinations.first ?? "" } }
            .alert("Couldn't move skill", isPresented: $error.isPresent()) {
                Button("OK") { error = nil }
            } message: { Text(error ?? "") }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(moving)
    }

    private func move() async {
        guard valid, !moving else { return }
        moving = true
        defer { moving = false }
        do {
            try await model.moveSkill(entry, to: scope)
            dismiss()
            onMoved()
        } catch { self.error = error.localizedDescription }
    }
}

private struct NewSkillSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let defaultProject: String?
    let defaultStoreId: String?
    let onCreate: (StoreSkill) -> Void
    @State private var name = ""
    @State private var summary = ""
    @State private var instructions = ""
    @State private var scope = "global"
    @State private var storeId = ""
    @State private var error: String?
    @State private var saving = false
    @State private var confirmingDiscard = false

    private var stores: [StoreDescriptor] {
        model.storeDescriptors.filter {
            $0.canPush && (defaultStoreId == nil || $0.id == defaultStoreId)
                && (defaultStoreId != nil || model.storeFilter == nil || $0.id == model.storeFilter)
        }
    }
    private var projects: [String] {
        model.writableProjects.filter { $0.storeId == storeId }.map(\.project.name).sorted()
    }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var path: String { "\(scope)/skills/\(trimmedName).md" }
    private var nameError: String? {
        guard !trimmedName.isEmpty else { return nil }
        guard LocalStore.isSkillPath(path) else { return "Start with a letter or number; use letters, numbers, dots, dashes, or underscores." }
        if model.skills(in: storeId).contains(where: {
            $0.scope.source == scope && $0.name.lowercased() == trimmedName.lowercased()
        }) { return "A skill with that name already exists in this scope." }
        return nil
    }
    private var valid: Bool {
        !trimmedName.isEmpty && nameError == nil && stores.contains { $0.id == storeId }
            && (scope == "global" || projects.contains(scope))
            && !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var dirty: Bool { !name.isEmpty || !summary.isEmpty || !instructions.isEmpty }

    var body: some View {
        NavigationStack {
            PhrenForm {
                Section("Skill") {
                    TextField("skill-name", text: $name).autocorrectionDisabled().textInputAutocapitalization(.never)
                    if let nameError { Text(nameError).font(.caption).foregroundStyle(.red) }
                    TextField("When should an agent use this skill?", text: $summary, axis: .vertical)
                }
                Section("Location") {
                    if stores.count > 1 {
                        Picker("Store", selection: $storeId) { ForEach(stores) { Text($0.displayName).tag($0.id) } }
                    } else if let store = stores.first { LabeledContent("Store", value: store.displayName) }
                    Picker("Scope", selection: $scope) {
                        Text("Global · all projects").tag("global")
                        ForEach(projects, id: \.self) { Text($0).tag($0) }
                    }
                }
                Section("Instructions") {
                    TextEditor(text: $instructions).frame(minHeight: 200).accessibilityLabel("Skill instructions")
                }
            }
            .disabled(saving)
            .navigationTitle("New skill")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if dirty { confirmingDiscard = true } else { dismiss() } }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Creating…" : "Create") { Task { await create() } }.disabled(!valid || saving)
                }
            }
            .onAppear {
                guard storeId.isEmpty else { return }
                storeId = stores.first?.id ?? ""
                scope = defaultProject.flatMap { projects.contains($0) ? $0 : nil } ?? "global"
            }
            .onChange(of: storeId) { _, _ in
                if scope != "global" && !projects.contains(scope) { scope = "global" }
            }
            .confirmationDialog("Discard this skill?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) { dismiss() }
            }
            .alert("Couldn't create skill", isPresented: $error.isPresent()) {
                Button("OK") { error = nil }
            } message: { Text(error ?? "") }
        }
        .interactiveDismissDisabled(dirty || saving)
    }

    private func create() async {
        guard valid, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let content = SkillFile.template(name: trimmedName, description: summary, instructions: instructions)
            try await model.saveDocument(path: path, content: content, expectedContent: nil, in: storeId)
            if let skill = Skill.parse(path: path, content: content) {
                onCreate(StoreSkill(storeId: storeId, storeName: model.storeName(for: storeId), skill: skill))
            }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
