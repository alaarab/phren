import PhrenKit
import SwiftUI

struct AgentsView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var stores: [StoreDescriptor] {
        model.storeDescriptors.filter { model.storeFilter == nil || $0.id == model.storeFilter }
    }
    private var projects: [StoreProject] {
        model.mergedProjects.filter {
            $0.project.name != "global" && (query.isEmpty || $0.project.name.localizedCaseInsensitiveContains(query)
                || $0.storeName.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        PhrenList {
            Section {
                Text("Shape how your agents work with shared instructions and reusable skills.")
                    .foregroundStyle(.secondary)
                NavigationLink { LiveSessionsView() } label: {
                    Label("Live sessions", systemImage: "waveform.path")
                }
            }
            Section("Global instructions") {
                ForEach(stores.filter { query.isEmpty || $0.displayName.localizedCaseInsensitiveContains(query)
                    || "global".localizedCaseInsensitiveContains(query) }) { store in
                    NavigationLink { AgentContextView(storeId: store.id, scope: "global") } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(store.displayName).font(.headline)
                                Text("Shared across projects").font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "globe") }
                    }
                }
            }
            Section("Project instructions") {
                ForEach(projects) { item in
                    NavigationLink { AgentContextView(storeId: item.storeId, scope: item.project.name) } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.project.name).font(.headline)
                            HStack {
                                if model.hasMultipleStores { TagChip(text: item.storeName, role: .store) }
                                if !model.canPush(storeId: item.storeId) { TagChip(text: "Read-only", role: .status) }
                                Text(model.instructions(scope: item.project.name, in: item.storeId) == nil
                                     ? "No project instructions" : "Instructions ready")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if projects.isEmpty {
                    Text(query.isEmpty ? "Your projects will appear here." : "No matching projects.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Agent setup")
        .searchable(text: $query, prompt: "Search projects and stores")
        .refreshable { await model.pullToRefresh() }
        .safeAreaInset(edge: .top, spacing: 0) { LiveStatusBar() }
        .phrenScreen()
    }
}

struct AgentContextView: View {
    @Environment(AppModel.self) private var model
    let storeId: String
    let scope: String
    @State private var draft: DocumentDraft?

    private var content: String? { model.instructions(scope: scope, in: storeId) }
    private var instructionsPath: String { model.instructionsPath(scope: scope, in: storeId) }

    var body: some View {
        PhrenList {
            Section {
                LabeledContent("Store", value: model.storeName(for: storeId))
                if !model.canPush(storeId: storeId) { Label("Read-only store", systemImage: "lock") }
                if scope != "global" {
                    NavigationLink { AgentContextView(storeId: storeId, scope: "global") } label: {
                        Label("Global instructions", systemImage: "globe")
                    }
                }
                NavigationLink { SkillsView(project: scope == "global" ? "global" : scope, storeId: storeId) } label: {
                    Label(scope == "global" ? "Global skills" : "Project and global skills", systemImage: "wand.and.stars")
                }
            }
            Section("Instructions") {
                if let content { DocumentContentView(path: instructionsPath, content: content, embedded: true) }
                else {
                    Text("Add the conventions, tools, and working rules your agents should follow.")
                        .foregroundStyle(.secondary)
                    if model.canPush(storeId: storeId) {
                        Button("Add instructions") { draft = DocumentDraft(path: "\(scope)/\(AgentInstructions.fileName)", content: nil) }
                    }
                }
            }
            Section {
                Text("Changes sync to your store. Linked agents receive them when the computer syncs; generated instruction files refresh when phren links the project.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(scope == "global" ? "Global instructions" : scope)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) { LiveStatusBar() }
        .phrenScreen()
        .toolbar {
            if let content, model.canPush(storeId: storeId) {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { draft = DocumentDraft(path: instructionsPath, content: content) }
                }
            }
        }
        .sheet(item: $draft) {
            DocumentEditorSheet(title: "Agent instructions", storeId: storeId, draft: $0,
                                template: AgentInstructions.template(scope: scope))
        }
    }
}
