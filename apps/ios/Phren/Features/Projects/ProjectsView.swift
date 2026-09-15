import SwiftUI
import PhrenKit

struct MemoryMaintenanceRoute: Hashable { }

struct ProjectsView: View {
    @Environment(AppModel.self) private var model
    @State private var filter = ""
    @State private var navigationPath = NavigationPath()
    @State private var showVoiceCapture = false

    private var projects: [StoreProject] {
        guard !filter.isEmpty else { return model.mergedProjects }
        return model.mergedProjects.filter { $0.project.name.localizedCaseInsensitiveContains(filter) }
    }

    /// Every writable (store, project) pair — the global quick-capture mic
    /// is hidden entirely when none exist, same reasoning as TasksView's
    /// addTargets-gated + button.
    private var voiceCaptureTargets: [VoiceCaptureTarget] {
        model.writableProjects
            .map { VoiceCaptureTarget(storeId: $0.storeId, storeName: $0.storeName, project: $0.project.name) }
    }

    var body: some View {
        @Bindable var model = model
        PhrenNavigationStack(path: $navigationPath) {
            VStack(spacing: 0) {
                LiveStatusBar()
                ActionErrorBanner()
                PhrenList {
                    Section("Explore") {
                        NavigationLink { GraphView() } label: {
                            PhrenMenuRow(title: "Memory graph", subtitle: "Explore how your knowledge connects",
                                         icon: "circle.hexagongrid", color: PhrenTheme.cyan, compact: true)
                        }.accessibilityLabel("Memory graph")
                        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
                    }
                    Section("Projects") {
                        ForEach(projects) { item in
                            NavigationLink(value: item) {
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 6) {
                                        Text(item.project.name).font(.headline)
                                        if model.hasMultipleStores {
                                            TagChip(text: item.storeName, role: .store)
                                        }
                                        // `global` is the store's cross-project tier:
                                        // visible, searchable, never editable here.
                                        if LocalStore.isReadOnlyProject(item.project.name) {
                                            TagChip(text: "read-only", role: .status)
                                        }
                                        if let claimant = model.claimingStoreName(for: item) {
                                            ClaimBadge(storeName: claimant)
                                        }
                                    }
                                    HStack(spacing: 10) {
                                        Label("\(item.project.findingCount)", systemImage: "lightbulb")
                                        Label("\(item.project.taskCount)", systemImage: "checklist")
                                        Label("\(item.project.noteCount)", systemImage: "note.text")
                                    }
                                    .font(.caption)
                                    .labelStyle(PhrenMetadataLabelStyle())
                                    .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 2)
                            }
                            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
                            .accessibilityIdentifier("project:\(item.storeId):\(item.project.name)")
                        }
                    }
                    Section("Agent setup") {
                        NavigationLink { LiveSessionsView() } label: {
                            PhrenMenuRow(title: "Live sessions", subtitle: "Pick up where your agents left off",
                                         icon: "waveform.path", compact: true)
                        }.accessibilityLabel("Live sessions")
                        NavigationLink { SkillsView() } label: {
                            PhrenMenuRow(title: "Skills", icon: "wand.and.stars", color: PhrenTheme.lavender, compact: true)
                        }
                        NavigationLink { AgentsView() } label: {
                            PhrenMenuRow(title: "Agent instructions", icon: "person.crop.rectangle.stack", compact: true)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
                    Section {
                        NavigationLink(value: MemoryMaintenanceRoute()) {
                            Label("Memory maintenance", systemImage: "wrench.and.screwdriver")
                        }
                        .foregroundStyle(.secondary)
                    } footer: {
                        Text("Your agents build memory as you work. Maintenance is here when you need it.")
                    }
                }
                .overlay {
                    if model.mergedProjects.isEmpty && model.storeDescriptors.isEmpty {
                        PhrenEmptyState(title: "No projects yet", message: "Projects appear here once your phren store has content.")
                    }
                }
                .searchable(text: $filter, prompt: "Filter projects")
                .refreshable { await model.pullToRefresh() }
                .phrenScreen()
            }
            .navigationTitle("Projects")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        NavigationLink { GraphView() } label: {
                            Label("Memory graph", systemImage: "circle.hexagongrid")
                        }
                        Section("Agent setup") {
                            NavigationLink { LiveSessionsView() } label: {
                                Label("Live sessions", systemImage: "waveform.path")
                            }
                            NavigationLink { SkillsView() } label: {
                                Label("Skills", systemImage: "wand.and.stars")
                            }
                            NavigationLink { AgentsView() } label: {
                                Label("Agent instructions", systemImage: "person.crop.rectangle.stack")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("More")
                }
                if model.hasMultipleStores {
                    ToolbarItem(placement: .topBarLeading) {
                        Menu {
                            Picker("Store", selection: $model.storeFilter) {
                                Text("All stores").tag(String?.none)
                                ForEach(model.storeDescriptors) { store in
                                    Text(store.displayName).tag(String?.some(store.id))
                                }
                            }
                        } label: {
                            Image(systemName: model.storeFilter == nil
                                  ? "line.3.horizontal.decrease"
                                  : "line.3.horizontal.decrease.circle.fill")
                        }
                    }
                }
                // Global quick capture: dictate a note or a task without
                // opening a project first. Hidden (not just disabled) when no
                // store is writable — mirrors TasksView's addTargets-gated
                // + button.
                if !voiceCaptureTargets.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showVoiceCapture = true
                        } label: {
                            Image(systemName: "mic.fill")
                        }
                        // The sheet captures either kind, and asks where it
                        // goes — the label has to say so, since VoiceOver
                        // users get no other preview of what the button does.
                        .accessibilityLabel("Dictate a note or task")
                    }
                }
            }
            .navigationDestination(for: StoreProject.self) { item in
                ProjectDetailView(storeId: item.storeId, project: item.project.name)
            }
            .navigationDestination(for: AgentLaunch.PendingProject.self) { target in
                ProjectDetailView(storeId: target.storeID, project: target.project)
            }
            .navigationDestination(for: MemoryMaintenanceRoute.self) { _ in MemoryMaintenanceView() }
            .onChange(of: model.showingMemoryMaintenance, initial: true) { _, showing in
                guard showing else { return }
                model.showingMemoryMaintenance = false
                navigationPath = NavigationPath()
                navigationPath.append(MemoryMaintenanceRoute())
            }
            .onChange(of: model.pendingProjectVersion, initial: true) { _, _ in
                guard let target = AgentLaunch.takePendingProject() else { return }
                guard model.storeContexts.contains(where: { context in
                    context.id == target.storeID && context.snapshot.projects.contains { $0.name == target.project }
                }) else {
                    model.lastActionError = "That project is no longer available on this iPhone."
                    return
                }
                navigationPath = NavigationPath()
                navigationPath.append(target)
            }
            .sheet(isPresented: $showVoiceCapture) {
                VoiceCaptureView(targets: voiceCaptureTargets)
            }
        }
    }
}

/// Warns that `stores.yaml` claims this project for a different, non-primary
/// store than the one it's physically sitting in — e.g. an employer's
/// projects that leaked into a personal repo (see AppModel.claimingStoreName).
/// A local view rather than an addition to Components.swift's `TagChip`:
/// this branch owns ProjectsView.swift's row content only, not the shared
/// component file, and `TagChip` has no icon slot anyway.
private struct ClaimBadge: View {
    let storeName: String

    var body: some View {
        Label(storeName, systemImage: "person.2")
            .font(.caption2.monospaced().weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(PhrenTheme.warning.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(PhrenTheme.warning.opacity(0.45), lineWidth: 1))
            .foregroundStyle(PhrenTheme.warning)
    }
}

struct ProjectDetailView: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model
    @State private var tab: Tab = .findings
    @State private var showingSkills = false
    @State private var skillsPresentationID = UUID()

    enum Tab: String, CaseIterable {
        case findings = "Findings"
        case notes = "Notes"
        case tasks = "Tasks"
        case summary = "Summary"
    }

    var body: some View {
        VStack(spacing: 0) {
            LiveStatusBar()
            ActionErrorBanner()
            Button { skillsPresentationID = UUID(); showingSkills = true } label: {
                HStack(spacing: 10) {
                    Label("Skills", systemImage: "wand.and.stars")
                    Spacer()
                    Text("Project and global").foregroundStyle(PhrenTheme.textMuted)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                }
                .font(.subheadline)
                .padding(.horizontal, 14).frame(minHeight: 44)
                .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Project skills")
            .accessibilityIdentifier("project-skills")
            .padding(.horizontal, 16).padding(.bottom, 8)
            Picker("Section", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.bottom, 4)

            switch tab {
            case .findings: FindingsTab(storeId: storeId, project: project)
            case .notes: NotesTab(storeId: storeId, project: project)
            case .tasks: TaskListView(scope: .project(storeId: storeId, project: project))
            case .summary: SummaryTab(storeId: storeId, project: project)
            }
        }
        .background(PhrenTheme.bg)
        // An identifier on the stack itself would be stamped onto every
        // child (hiding "project-skills" and the rest); a zero-size marker
        // names the page instead.
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement().accessibilityLabel("Project page")
                .accessibilityIdentifier("project-detail:\(storeId):\(project)")
        }
        .navigationTitle(model.hasMultipleStores ? "\(project) · \(model.storeName(for: storeId))" : project)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                ProjectSessionActions(storeId: storeId, project: project)
            }
            ToolbarItem(placement: .primaryAction) {
                NavigationLink { GraphView(focusProject: project, initialStoreId: storeId) } label: {
                    Label("Project graph", systemImage: "circle.hexagongrid")
                }
            }
        }
        .navigationDestination(isPresented: $showingSkills) {
            SkillsView(project: project, storeId: storeId, returnToProject: { showingSkills = false })
            .id(skillsPresentationID)
        }
    }
}

// MARK: - Findings

struct FindingsTab: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model
    @State private var showAdd = false
    @State private var editing: Finding?
    /// Which findings are expanded past their collapsed line limit. Ephemeral
    /// (not persisted) and keyed by stable id where available since the
    /// positional `id` shifts on every refresh.
    @State private var expandedFindingIds: Set<String> = []

    private var findings: [Finding] {
        model.findings(storeId: storeId, project: project)
    }

    private var truths: [Truth] {
        model.truths(storeId: storeId, project: project)
    }

    /// `global` (and any future read-only tier) renders here but is written
    /// only by the CLI — every edit affordance disappears rather than being
    /// shown and then refused (`SyncEngine.enqueue`).
    private var isReadOnly: Bool { LocalStore.isReadOnlyProject(project) }

    /// True when this store's registry role is `team`, i.e. adds append to
    /// `journal/YYYY-MM-DD-<actor>.md` rather than splicing FINDINGS.md.
    /// Worth saying out loud once: it is why some rows here can't be edited,
    /// and why a finding added on the phone doesn't land in FINDINGS.md.
    private var isJournalled: Bool {
        !isReadOnly && model.usesTeamJournal(storeId: storeId)
    }

    private var groupedByDate: [(date: String, items: [Finding])] {
        let groups = Dictionary(grouping: findings, by: \.date)
        return groups.keys.sorted(by: >).map { ($0, groups[$0]!) }
    }

    var body: some View {
        PhrenList {
            // Pinned first, because that is what pinning means: the CLI
            // injects these into every session regardless of what else it
            // retrieves (shared/retrieval.ts, "always-inject").
            if !truths.isEmpty {
                Section {
                    ForEach(truths) { truth in
                        TruthRow(truth: truth)
                    }
                } header: {
                    Label("Pinned truths", systemImage: "pin.fill")
                } footer: {
                    Text("Always injected, never decayed. Pin one from your computer: phren pin \(project) \"…\"")
                }
            }
            ForEach(groupedByDate, id: \.date) { group in
                Section(group.date) {
                    ForEach(group.items) { finding in
                        ExpandableFindingRow(finding: finding, expandedIds: $expandedFindingIds)
                            .swipeActions(edge: .trailing) {
                                // A journal entry has no edit or delete: the
                                // CLI's `edit_finding`/`remove_finding` splice
                                // FINDINGS.md in every store, team or not
                                // (only the *add* path forks), so the controls
                                // could only ever offer a refusal — the same
                                // rule `truths.md` rows follow.
                                if !isReadOnly && !finding.isJournalEntry {
                                    Button(role: .destructive) {
                                        Task { await remove(finding) }
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                    Button {
                                        editing = finding
                                    } label: {
                                        Label("Edit", systemImage: "pencil")
                                    }
                                    .tint(.blue)
                                }
                            }
                    }
                }
            }
            ArchiveFooter(storeId: storeId, project: project)
            if isJournalled {
                Section {
                    Label(
                        "Shared store — findings you add here append to today's journal file, "
                        + "so they merge with your teammates' instead of colliding.",
                        systemImage: "person.2"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .overlay {
            if isEmpty {
                PhrenEmptyState(title: "No findings", message: emptyMessage)
            }
        }
        .refreshable { await model.pullToRefresh() }
        .phrenScreen()
        .toolbar {
            if !isReadOnly {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAdd = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .sheet(isPresented: $showAdd) {
            TextEntrySheet(title: "Add finding", showsTypePicker: true, confirmLabel: "Add") { text, type in
                await model.perform(.addFinding(project: project, text: text, type: type?.rawValue), in: storeId)
            }
        }
        .sheet(item: $editing) { finding in
            TextEntrySheet(
                title: "Edit finding",
                initialText: finding.text,
                confirmLabel: "Save"
            ) { text, _ in
                await model.perform(.editFinding(
                    project: project,
                    match: finding.stableId.map { "fid:\($0)" } ?? finding.text,
                    newText: text
                ), in: storeId)
            }
        }
    }

    /// A project whose findings have all been consolidated away has an empty
    /// hot tier but is anything but empty — the "no findings" state would be
    /// a lie, and the archive row is the truth.
    private var hasArchive: Bool {
        model.consolidatedDate(storeId: storeId, project: project) != nil
            || (model.coldSummary(storeId: storeId, project: project)?.topicCount ?? 0) > 0
    }

    /// The empty state only means "empty" when there is nothing else on the
    /// screen — pinned truths and an archive row both count.
    private var isEmpty: Bool { findings.isEmpty && truths.isEmpty && !hasArchive }

    private var emptyMessage: String {
        isReadOnly
            ? "\(project) is phren's cross-project tier — the consolidate skill writes it from your computer."
            : "Capture your first finding with the + button."
    }

    private func remove(_ finding: Finding) async {
        await model.perform(.removeFinding(
            project: project,
            match: finding.stableId.map { "fid:\($0)" } ?? finding.text
        ), in: storeId)
    }
}

/// A pinned truth. Read-only with no affordances at all: `truths.md` is not
/// in `LocalStore.isWritablePath`, and pinning is a `phren pin` on a computer,
/// so offering an edit here would only be offering a refusal.
private struct TruthRow: View {
    let truth: Truth

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(truth.text)
                .font(.callout)
                .textSelection(.enabled)
            if let added = truth.addedDate {
                Text("pinned \(added)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// A finding row collapsed to a few lines by default — one long finding used
/// to fill the entire screen with no way to scan past it. Tapping the row
/// toggles the full text; a "Show more"/"Show less" affordance only appears
/// when the text is actually long enough to clip. Mirrors Components.swift's
/// `FindingRow` layout (tag/status/scope chips, actor, date) rather than
/// modifying it — this branch owns ProjectsView.swift's rows only, not the
/// shared component file.
private struct ExpandableFindingRow: View {
    let finding: Finding
    @Binding var expandedIds: Set<String>

    /// Collapsed height budget. 5 lines keeps a short finding fully visible
    /// (no affordance shown) while stopping a long one well short of a full
    /// screen.
    private static let collapsedLineLimit = 5
    /// Real truncation is properly detected by measuring rendered text
    /// (e.g. diffing heights in a background GeometryReader), which is more
    /// precise but heavier for a list row that scrolls constantly. A
    /// character-count heuristic — roughly 5 lines' worth of callout text at
    /// the width of a phone screen — is close enough to decide whether the
    /// "Show more" affordance is worth showing at all; being off by a line
    /// only costs an unnecessary (or missing) affordance, never wrong content.
    private static let truncationCharThreshold = 260

    private var key: String { finding.stableId ?? finding.id }
    private var isExpanded: Bool { expandedIds.contains(key) }
    private var isLikelyTruncated: Bool { displayText.count > Self.truncationCharThreshold }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(displayText)
                .font(.callout)
                .lineLimit(isExpanded ? nil : Self.collapsedLineLimit)
            if isLikelyTruncated {
                Text(isExpanded ? "Show less" : "Show more")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(PhrenTheme.lavender)
            }
            HStack(spacing: 6) {
                if let tag = finding.typeTag {
                    TagChip(text: tag, role: .type)
                }
                if finding.status != .active {
                    TagChip(text: finding.status.rawValue, role: .status)
                }
                if let scope = finding.scope {
                    TagChip(text: scope, role: .scope)
                }
                if let actor = finding.actor {
                    Text("@\(actor)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(finding.date)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.easeInOut(duration: 0.2)) {
                if isExpanded { expandedIds.remove(key) } else { expandedIds.insert(key) }
            }
        }
    }

    // Mirrors Components.swift FindingRow.displayText exactly: the leading
    // [tag] prefix is dropped since the type chip already carries it.
    private var displayText: String {
        guard let tag = finding.typeTag else { return finding.text }
        let prefix = "[\(tag)] "
        return finding.text.lowercased().hasPrefix(prefix.lowercased())
            ? String(finding.text.dropFirst(prefix.count))
            : finding.text
    }
}

// MARK: - Notes

struct NotesTab: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model
    @State private var showAdd = false
    @State private var editing: Note?
    @State private var promoting: Note?
    @State private var showVoiceCapture = false
    /// Same collapsed-by-default treatment as findings (Task: findings
    /// unscannable when one entry fills the screen) — notes use the same
    /// plain VStack(text + metadata) row shape, so the fix is mechanical.
    @State private var expandedNoteIds: Set<String> = []
    private static let collapsedLineLimit = 5
    private static let truncationCharThreshold = 260

    private var notes: [Note] {
        model.notes(storeId: storeId, project: project)
    }

    /// Same rule as `FindingsTab`: a read-only tier shows no way to write.
    private var isReadOnly: Bool { LocalStore.isReadOnlyProject(project) }

    /// This tab's project, pre-selected — the mic button next to + only
    /// appears when this specific (store, project) pair is writable.
    private var voiceCaptureTarget: VoiceCaptureTarget? {
        guard model.canWrite(storeId: storeId, project: project) else { return nil }
        return VoiceCaptureTarget(storeId: storeId, storeName: model.storeName(for: storeId), project: project)
    }

    private var groupedByDay: [(date: String, items: [Note])] {
        let groups = Dictionary(grouping: notes, by: \.date)
        return groups.keys.sorted(by: >).map { date in
            (date, groups[date]!.sorted { $0.time > $1.time })
        }
    }

    var body: some View {
        PhrenList {
            ForEach(groupedByDay, id: \.date) { group in
                Section(group.date) {
                    ForEach(group.items) { note in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(note.text)
                                .font(.callout)
                                .lineLimit(expandedNoteIds.contains(note.stableId) ? nil : Self.collapsedLineLimit)
                            if note.text.count > Self.truncationCharThreshold {
                                Text(expandedNoteIds.contains(note.stableId) ? "Show less" : "Show more")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(PhrenTheme.lavender)
                            }
                            HStack {
                                Text(note.time)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                if note.promoted {
                                    TagChip(text: "promoted", role: .good)
                                }
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                if expandedNoteIds.contains(note.stableId) {
                                    expandedNoteIds.remove(note.stableId)
                                } else {
                                    expandedNoteIds.insert(note.stableId)
                                }
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if !isReadOnly {
                                Button(role: .destructive) {
                                    Task {
                                        await model.perform(.removeNote(
                                            project: project, date: note.date, stableId: note.stableId
                                        ), in: storeId)
                                    }
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                                Button { editing = note } label: {
                                    Label("Edit", systemImage: "pencil")
                                }
                                .tint(.blue)
                            }
                        }
                        .swipeActions(edge: .leading) {
                            if !note.promoted, !isReadOnly {
                                Button { promoting = note } label: {
                                    Label("Promote", systemImage: "arrow.up.circle")
                                }
                                .tint(.green)
                            }
                        }
                    }
                }
            }
        }
        .overlay {
            if notes.isEmpty {
                PhrenEmptyState(title: "No notes", message: "Jot down a note with the + button. Promote the good ones to findings.")
            }
        }
        .refreshable { await model.pullToRefresh() }
        .phrenScreen()
        .toolbar {
            if voiceCaptureTarget != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showVoiceCapture = true
                    } label: {
                        Image(systemName: "mic.fill")
                    }
                    .accessibilityLabel("Dictate a note or task")
                }
            }
            if !isReadOnly {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAdd = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .sheet(isPresented: $showAdd) {
            TextEntrySheet(title: "Add note", confirmLabel: "Add") { text, _ in
                let now = AppModel.nowNoteTimestamp()
                await model.perform(.addNote(project: project, date: now.date, time: now.time, text: text), in: storeId)
            }
        }
        .sheet(isPresented: $showVoiceCapture) {
            if let voiceCaptureTarget {
                VoiceCaptureView(targets: [voiceCaptureTarget], preselected: voiceCaptureTarget)
            }
        }
        .sheet(item: $editing) { note in
            TextEntrySheet(title: "Edit note", initialText: note.text) { text, _ in
                await model.perform(.editNote(
                    project: project, date: note.date, stableId: note.stableId, text: text
                ), in: storeId)
            }
        }
        .sheet(item: $promoting) { note in
            TextEntrySheet(
                title: "Promote to finding",
                initialText: note.text,
                showsTypePicker: true,
                confirmLabel: "Promote"
            ) { _, type in
                // promoteNote uses the note's text verbatim (core/note.ts:24);
                // only the type is chosen here.
                await model.perform(.promoteNote(
                    project: project, date: note.date,
                    stableId: note.stableId, findingType: type?.rawValue
                ), in: storeId)
            }
        }
    }
}

// MARK: - Summary

struct SummaryTab: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            if let summary = model.summary(storeId: storeId, project: project) {
                Text(summary)
                    .font(.callout.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .textSelection(.enabled)
            } else {
                PhrenEmptyState(title: "No summary", message: "This project has no summary.md yet.")
                .padding(.top, 60)
            }
        }
        .refreshable { await model.pullToRefresh() }
        .phrenScreen()
    }
}
