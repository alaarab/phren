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
                List(selection: $selection) {
                    Section {
                        Text(storeID).font(.caption).foregroundStyle(.secondary)
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
                            .font(.caption).foregroundStyle(.secondary)
                    }.phrenRow()
                    ForEach(QueueItem.Section.allCases, id: \.self) { section in
                        let sectionItems = items.filter { $0.entry.item.section == section }
                        if !sectionItems.isEmpty {
                            Section("\(section.rawValue) (\(sectionItems.count))") {
                                ForEach(sectionItems) { entry in
                                    Group {
                                        if editMode == .active {
                                            ReviewRow(entry: entry, showStore: false)
                                        } else {
                                            Button { reading = entry } label: {
                                                ReviewRow(entry: entry, showStore: false)
                                            }
                                            .buttonStyle(.plain)
                                        }
                                    }
                                        .tag(entry.id)
                                        .contentShape(Rectangle())
                                        .swipeActions(edge: .leading) {
                                            Button {
                                                Task { await approve([entry]) }
                                            } label: {
                                                Label("Approve", systemImage: "checkmark")
                                            }
                                            .tint(.green)
                                        }
                                        .swipeActions(edge: .trailing) {
                                            Button(role: .destructive) {
                                                Task { await reject([entry]) }
                                            } label: {
                                                Label("Reject", systemImage: "xmark")
                                            }
                                            Button { editing = entry } label: {
                                                Label("Edit", systemImage: "pencil")
                                            }
                                            .tint(.blue)
                                        }
                                        .contextMenu {
                                            Button {
                                                Task { await approve([entry]) }
                                            } label: {
                                                Label("Approve", systemImage: "checkmark")
                                            }
                                            Button { editing = entry } label: {
                                                Label("Edit", systemImage: "pencil")
                                            }
                                            Button(role: .destructive) {
                                                Task { await reject([entry]) }
                                            } label: {
                                                Label("Reject", systemImage: "xmark")
                                            }
                                        }
                                }
                            }.phrenRow()
                        }
                    }
                    if items.isEmpty {
                        Section {
                            Text("No maintenance entries for this project and filter.")
                                .foregroundStyle(.secondary)
                        }.phrenRow()
                    }
                }
                .environment(\.editMode, $editMode)
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
                    Menu {
                        PhrenSwitch("Flagged only", isOn: $flaggedOnly)
                        Button("Review individually", systemImage: "square.stack") { triaging = true }
                            .disabled(triageDeck.isEmpty)
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease")
                    }
                    .accessibilityLabel("Maintenance options")
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
        .listRowBackground(entry.entry.item.risky ? PhrenTheme.amber.opacity(0.08) : nil)
    }
}
