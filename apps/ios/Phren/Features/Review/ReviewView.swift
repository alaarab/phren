import SwiftUI
import PhrenKit

/// Optional maintenance for one project's queue, scoped to its source store.
struct ReviewView: View {
    let storeID: String
    let project: String
    @Environment(AppModel.self) private var model
    @State private var flaggedOnly = false
    @State private var selection = Set<String>()
    @State private var editMode: EditMode = .inactive
    @State private var editing: StoreQueueEntry?
    @State private var triaging = false
    @State private var reading: StoreQueueEntry?
    @State private var copied = false
    @State private var showingOptions = false
    @State private var actionEntry: StoreQueueEntry?

    private var items: [StoreQueueEntry] {
        model.snapshot(for: storeID).reviewQueue
            .filter { $0.project == project && (!flaggedOnly || $0.item.risky) }
            .map { StoreQueueEntry(storeId: storeID, storeName: model.storeName(for: storeID), entry: $0) }
    }

    /// The deck triage works: the same items the list shows, in the same
    /// order they're rendered — section by section, top to bottom.
    private var triageDeck: [StoreQueueEntry] {
        QueueItem.Section.allCases.flatMap { section in
            items.filter { $0.entry.item.section == section }
        }
    }

    var body: some View {
        Group {
            VStack(spacing: 0) {
                LiveStatusBar()
                ActionErrorBanner()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        headerCard
                        ForEach(QueueItem.Section.allCases, id: \.self) { section in
                            let sectionItems = items.filter { $0.entry.item.section == section }
                            if !sectionItems.isEmpty {
                                Text("\(section.rawValue) (\(sectionItems.count))")
                                    .plainListSectionLabel()
                                    .accessibilityAddTraits(.isHeader)
                                ForEach(sectionItems) { entry in
                                    reviewRow(entry)
                                }
                            }
                        }
                        if items.isEmpty {
                            Text("No maintenance entries for this project and filter.")
                                .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                                .padding(.horizontal, 12).padding(.top, PhrenTheme.Space.small)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, PhrenTheme.Space.small)
                    .padding(.bottom, PhrenTheme.Space.section)
                }
                .refreshable { await model.pullToRefresh() }
                .phrenScreen()

                if editMode == .active {
                    batchBar
                }
            }
            .navigationTitle(project)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingOptions = true } label: {
                        Image(systemName: "line.3.horizontal.decrease")
                    }
                    .accessibilityLabel("Maintenance options")
                    .accessibilityIdentifier("review-options")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        withAnimation {
                            editMode = editMode == .active ? .inactive : .active
                            selection.removeAll()
                        }
                    } label: {
                        if editMode == .active {
                            Text("Done")
                        } else {
                            Label("Select", systemImage: "checklist")
                                .labelStyle(.titleAndIcon)
                        }
                    }
                }
            }
            .sheet(item: $editing) { entry in
                TextEntrySheet(
                    title: "Edit before approving",
                    initialText: entry.entry.item.text,
                    confirmLabel: "Save"
                ) { text, _ in
                    await model.perform(
                        .editQueue(project: entry.entry.project, line: entry.entry.item.line, newText: text),
                        in: entry.storeId
                    )
                }
            }
            .fullScreenCover(isPresented: $triaging) {
                TriageView(entries: triageDeck)
            }
            .navigationDestination(item: $reading) { entry in
                    PhrenList {
                        Text(.init(entry.entry.item.text)).textSelection(.enabled)
                        LabeledContent("Project", value: entry.entry.project)
                        LabeledContent("Store", value: entry.storeId)
                        LabeledContent("Category", value: entry.entry.item.section.rawValue)
                    }
                    .navigationTitle("Memory entry")
                    .navigationBarTitleDisplayMode(.inline)
                    .phrenScreen()
            }
            .onChange(of: flaggedOnly) { _, _ in selection.removeAll() }
            .onChange(of: items.map(\.id)) { _, ids in selection.formIntersection(ids) }
        }
        .phrenActionSheet(isPresented: $showingOptions, title: "Maintenance options",
                          actions: maintenanceActions, identifier: "review-options-sheet")
        .phrenActionSheet(isPresented: $actionEntry.isPresent(), title: "Memory entry",
                          actions: entryActions, identifier: "review-entry-actions")
    }

    /// The store, the "copy request" command and its explanation, as one card
    /// above the queue.
    private var headerCard: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            Text(storeID).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textSecondary)
            Button(copied ? "Agent request copied" : "Copy request for my agent", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = """
                Inspect memory maintenance for project \(project) in Phren store \(storeID).
                Read its review queue and current project context. Summarize candidates,
                stale memories, and conflicts by theme. Suggest a batch of useful updates and
                call out ambiguous or destructive decisions for me. Do not blindly approve
                or discard the queue just to clear its count.
                """
                copied = true
            }
            .buttonStyle(.borderless)
            Text("Paste this into your agent conversation. You can also select several entries below for manual maintenance.")
                .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .sessionCard()
    }

    /// One card per entry. A tap opens the reading destination; in edit mode a
    /// tap toggles the entry's membership in `selection` and the card shows a
    /// check mark and the selected trait.
    private func reviewRow(_ entry: StoreQueueEntry) -> some View {
        let selected = editMode == .active && selection.contains(entry.id)
        return Button {
            if editMode == .active {
                if !selection.insert(entry.id).inserted { selection.remove(entry.id) }
            } else {
                reading = entry
            }
        } label: {
            HStack(alignment: .top, spacing: PhrenTheme.Space.small) {
                if editMode == .active {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(PhrenTypography.icon(18, weight: .semibold))
                        .foregroundStyle(selected ? PhrenTheme.cyan : PhrenTheme.textDim)
                        .accessibilityHidden(true)
                }
                ReviewRow(entry: entry, showStore: false)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .padding(.trailing, 44)
            .contentShape(Rectangle())
            .sessionCard()
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .overlay(RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium, style: .continuous)
            .fill(entry.entry.item.risky ? PhrenTheme.amber.opacity(0.08) : Color.clear)
            .allowsHitTesting(false))
        .overlay(alignment: .trailing) {
            PhrenIconButton(icon: "ellipsis", label: "Entry actions") { actionEntry = entry }
                .phrenIdentifier("review-actions:\(entry.id)")
                .padding(.trailing, 4)
        }
    }

    private var maintenanceActions: [PhrenControlAction] {
        [
            PhrenControlAction(id: "flagged", title: "Flagged only", icon: "flag",
                               isSelected: flaggedOnly, dismisses: false) { flaggedOnly.toggle() },
            PhrenControlAction(id: "triage", title: "Review individually", icon: "square.stack",
                               isEnabled: !triageDeck.isEmpty) { triaging = true },
        ]
    }

    private var entryActions: [PhrenControlAction] {
        guard let entry = actionEntry else { return [] }
        return [
            PhrenControlAction(id: "approve", title: "Approve", icon: "checkmark") {
                Task { await approve([entry]) }
            },
            PhrenControlAction(id: "edit", title: "Edit", icon: "pencil") { editing = entry },
            PhrenControlAction(id: "reject", title: "Reject", icon: "xmark", role: .destructive) {
                Task { await reject([entry]) }
            },
        ]
    }

    private var allVisibleSelected: Bool {
        !items.isEmpty && selection.count == items.count
    }

    private var batchBar: some View {
        HStack {
            Button(allVisibleSelected ? "Deselect All" : "Select All") {
                withAnimation {
                    selection = allVisibleSelected ? [] : Set(items.map(\.id))
                }
            }
            .font(.footnote)
            .disabled(items.isEmpty)

            Text(selection.isEmpty ? "None selected" : "\(selection.count) selected")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Reject", role: .destructive) {
                Task { await reject(selectedEntries()) }
            }
            .disabled(selection.isEmpty)
            Button("Approve") {
                Task { await approve(selectedEntries()) }
            }
            .buttonStyle(.borderedProminent).tint(PhrenTheme.accentSolid)
            .disabled(selection.isEmpty)
        }
        .padding()
        .background(.bar)
    }

    private func selectedEntries() -> [StoreQueueEntry] {
        items.filter { selection.contains($0.id) }
    }

    private func approve(_ entries: [StoreQueueEntry]) async {
        for entry in entries {
            await model.perform(
                .approveQueue(project: entry.entry.project, line: entry.entry.item.line),
                in: entry.storeId
            )
        }
        selection.removeAll()
    }

    private func reject(_ entries: [StoreQueueEntry]) async {
        for entry in entries {
            await model.perform(
                .rejectQueue(project: entry.entry.project, line: entry.entry.item.line),
                in: entry.storeId
            )
        }
        selection.removeAll()
    }
}

struct ReviewRow: View {
    let entry: StoreQueueEntry
    let showStore: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(.init(entry.entry.item.text))
                .font(.callout)
                .lineLimit(4)
            HStack(spacing: 6) {
                TagChip(text: entry.entry.project, role: .project)
                if showStore {
                    TagChip(text: entry.storeName, role: .store)
                }
                if let confidence = entry.entry.item.confidence {
                    TagChip(
                        text: String(format: "%.0f%%", confidence * 100),
                        color: confidence < 0.7 ? PhrenTheme.amber : PhrenTheme.green
                    )
                }
                if let machine = entry.entry.item.machine {
                    Text(machine).font(.caption2).foregroundStyle(.secondary)
                }
                if let model = entry.entry.item.model {
                    Text(model).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text(entry.entry.item.date)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}
