import SwiftUI
import PhrenKit

struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    /// Store id (owner/name) — the SearchIndex attribution key.
    @State private var storeIdFilter: String?
    @State private var projectFilter: String?
    @State private var kindFilter: SearchIndex.DocKind?

    @State private var results: [SearchIndex.Result] = []
    @State private var searching = false
    private struct Request: Equatable {
        let query: String
        let store: String?
        let project: String?
        let kind: SearchIndex.DocKind?
        let revision: UUID
    }
    private var request: Request {
        Request(query: query, store: storeIdFilter, project: projectFilter, kind: kindFilter, revision: model.searchRevision)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                LiveStatusBar()
                ActionErrorBanner()
                PhrenList {
                    if !query.isEmpty {
                        ForEach(results) { result in
                            NavigationLink {
                                ProjectDetailView(storeId: result.store, project: result.project)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(result.text)
                                        .font(.callout)
                                        .lineLimit(4)
                                    HStack(spacing: 6) {
                                        TagChip(text: result.project, role: .project)
                                        if model.hasMultipleStores, !result.store.isEmpty {
                                            TagChip(text: model.storeName(for: result.store), role: .store)
                                        }
                                        TagChip(text: result.kind.rawValue, color: kindColor(result.kind))
                                        if let tag = result.typeTag {
                                            TagChip(text: tag, role: .type)
                                        }
                                        Spacer()
                                        if let date = result.date {
                                            Text(date).font(.caption2).foregroundStyle(.tertiary)
                                        }
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }
                .overlay {
                    if query.isEmpty {
                        PhrenEmptyState(title: "Search your memory", message: "Find a decision, a useful note, or your next task. Searches current memory saved on this iPhone.")
                    } else if searching && results.isEmpty {
                        ProgressView("Searching…")
                    } else if results.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
            .phrenScreen()
            .searchable(text: $query, prompt: "Search findings, notes, tasks…")
            .task(id: request) {
                let request = request
                guard !request.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    results = []; searching = false; return
                }
                searching = true
                do {
                    try await Task.sleep(for: .milliseconds(120))
                    let index = model.searchIndex
                    let matches = await Task.detached(priority: .userInitiated) {
                        index.search(request.query, store: request.store, project: request.project, kind: request.kind)
                    }.value
                    try Task.checkCancellation()
                    results = matches; searching = false
                } catch {}
            }
            .navigationTitle("Search")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Picker("Project", selection: $projectFilter) {
                            Text("All projects").tag(String?.none)
                            ForEach(Array(Set(model.mergedProjects.map(\.project.name))).sorted(), id: \.self) { name in
                                Text(name).tag(String?.some(name))
                            }
                        }
                        if model.hasMultipleStores {
                            Picker("Store", selection: $storeIdFilter) {
                                Text("All stores").tag(String?.none)
                                ForEach(model.storeDescriptors) { store in
                                    Text(store.displayName).tag(String?.some(store.id))
                                }
                            }
                        }
                        Picker("Type", selection: $kindFilter) {
                            Text("Everything").tag(SearchIndex.DocKind?.none)
                            ForEach(SearchIndex.DocKind.allCases, id: \.self) { kind in
                                Text(kind.rawValue).tag(SearchIndex.DocKind?.some(kind))
                            }
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease")
                    }
                }
            }
        }
    }

    private func kindColor(_ kind: SearchIndex.DocKind) -> Color {
        switch kind {
        case .finding: return PhrenTheme.amber
        case .note: return PhrenTheme.cyan
        case .task: return PhrenTheme.green
        case .summary: return PhrenTheme.textMuted
        case .truth: return PhrenTheme.accent
        }
    }
}
