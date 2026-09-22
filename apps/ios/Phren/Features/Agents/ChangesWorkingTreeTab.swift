import PhrenKit
import PhrenLive
import SwiftUI

struct ChangesWorkingTreeTab: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let child: String?
    var codeOrigin: SessionCodeContext? = nil
    @Environment(ChangesModel.self) private var model
    @State private var dossier: CodeDossierTarget?
    private var tree: GitWorkingTree? {
        get { model.workingTree.tree }
        nonmutating set { model.workingTree.tree = newValue }
    }
    private var children: [String: GitWorkingTree] {
        get { model.workingTree.children }
        nonmutating set { model.workingTree.children = newValue }
    }
    private var expanded: Set<String> {
        get { model.workingTree.expanded }
        nonmutating set { model.workingTree.expanded = newValue }
    }
    @State private var loading: Set<String> = []
    @State private var error: String?
    @State private var opened: DiffTarget?
    @State private var loadTask: Task<Void, Never>?
    @State private var childTasks: [String: Task<Void, Never>] = [:]
    @State private var openTask: Task<Void, Never>?

    init(session: LiveAgentSession, target: AgentChatTarget, child: String?, codeOrigin: SessionCodeContext? = nil) {
        self.session = session
        self.target = target
        self.child = child
        self.codeOrigin = codeOrigin
    }

    private struct DiffTarget: Identifiable, Hashable {
        let file: AgentRepositoryDiff.File
        let section: AgentRepositoryDiff.Section
        var id: String { section.id }
        static func == (lhs: DiffTarget, rhs: DiffTarget) -> Bool { lhs.id == rhs.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(spacing: 0) {
                if let tree {
                    if tree.entries.isEmpty {
                        message("No files here", detail: nil)
                    } else {
                        ForEach(tree.entries) { entry in
                            WorkingTreeRow(entry: entry, level: 0, expanded: expanded, children: children,
                                           loading: loading, summaries: codeOrigin == nil ? [:] : model.workingTree.summaries, onSymbol: { dossier = CodeDossierTarget(name: $0) },
                                           onToggle: toggle, onOpen: openEntry)
                        }
                    }
                }
                if let error {
                    message("The working tree is unavailable", detail: error)
                } else if tree == nil {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading the working tree…").foregroundStyle(PhrenTheme.textMuted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
                    .listRowBackground(Color.clear)
                }
            }
            }
            .refreshable { await model.load(); await loadRoot() }
        }
        .accessibilityIdentifier("changes-tree")
        .navigationDestination(item: $opened) { FileDiffView(file: $0.file, section: $0.section) }
        .sheet(item: $dossier) { symbol in
            if let origin = codeOrigin {
                CodeSymbolDossier(storeId: origin.storeID, project: origin.project, symbol: symbol.name,
                                  hosts: [origin.host], origin: origin)
            }
        }
        .task(id: codeOrigin?.id) {
            if let tree { await enrich(tree) }
            for level in children.values { await enrich(level) }
        }
        .onChange(of: model.revision) { _, _ in reload() }
        .onAppear { if tree == nil { reload() } }
        .onDisappear {
            loadTask?.cancel(); openTask?.cancel()
            for task in childTasks.values { task.cancel() }
            childTasks = [:]; loading = []
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.chatNeutral)
            Text("Working tree").font(PhrenTheme.Font.monoSubheadline.weight(.semibold)).foregroundStyle(PhrenTheme.text)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(PhrenTheme.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(PhrenTheme.border).frame(height: 1) }
        .accessibilityIdentifier("changes-tree-header")
    }

    @MainActor
    private func reload() {
        loadTask?.cancel()
        loadTask = Task { await loadRoot() }
    }

    @MainActor
    private func loadRoot() async {
        for task in childTasks.values { task.cancel() }
        childTasks = [:]; loading = []
        do {
            let result: GitWorkingTree
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                result = try AgentChatFixture.tree(path: "")
            } else {
                result = try await PhrenConnection.gitTree(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, path: "")
            }
            #else
            result = try await PhrenConnection.gitTree(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, path: "")
            #endif
            try Task.checkCancellation()
            let changed = tree?.version == nil || tree?.version != result.version
            tree = result; error = nil
            await enrich(result)
            if !changed {
                // An index can change while Git still reports the same modified
                // paths. Refresh visible symbol counts independently of tree identity.
                for path in expanded.sorted() {
                    if let level = children[path] { await enrich(level) }
                }
            }
            if changed {
                // Keep visible branches while fresh children arrive. Prune a removed
                // subtree only after its parent's new listing confirms its removal.
                var parents = [""]
                while !parents.isEmpty {
                    let parent = parents.removeFirst()
                    let listing = parent.isEmpty ? result : children[parent]
                    guard let listing else { continue }
                    let dirs = Set(listing.entries.filter(\.isDirectory).map(\.path))
                    for cached in children.keys where (cached as NSString).deletingLastPathComponent == parent && !dirs.contains(cached) {
                        for removed in children.keys where removed == cached || removed.hasPrefix(cached + "/") {
                            children[removed] = nil; expanded.remove(removed)
                        }
                    }
                    for directory in dirs where expanded.contains(directory) {
                        await loadLevel(directory)
                        parents.append(directory)
                    }
                }
            }
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func loadChildren(_ path: String) {
        guard !loading.contains(path) else { return }
        loading.insert(path)
        childTasks[path] = Task { await loadLevel(path) }
    }

    @MainActor
    private func loadLevel(_ path: String) async {
        defer { childTasks[path] = nil; loading.remove(path) }
        do {
            let result: GitWorkingTree
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                result = try AgentChatFixture.tree(path: path)
            } else {
                result = try await PhrenConnection.gitTree(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, path: path)
            }
            #else
            result = try await PhrenConnection.gitTree(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, path: path)
            #endif
            try Task.checkCancellation()
            let priorVersion = children[path]?.version
            children[path] = result; loading.remove(path); error = nil
            await enrich(result)
            if priorVersion != result.version {
                for entry in result.entries where entry.isDirectory && expanded.contains(entry.path) {
                    if children[entry.path]?.version != result.version { await loadLevel(entry.path) }
                }
            }
        } catch {
            if !Task.isCancelled { loading.remove(path); self.error = error.localizedDescription }
        }
    }

    private func enrich(_ tree: GitWorkingTree) async {
        guard let origin = codeOrigin, !tree.entries.isEmpty else { return }
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled {
            for entry in tree.entries {
                let object: [String: Any] = ["path": entry.path, "symbols": entry.isDirectory ? 7 : 3,
                    "kinds": [["kind": "function", "count": 3]], "symbol": entry.isDirectory ? NSNull() : "Point"]
                if let data = try? JSONSerialization.data(withJSONObject: object),
                   let summary = try? JSONDecoder().decode(CodeOutlineSummary.self, from: data) {
                    model.workingTree.summaries[entry.path] = summary
                }
            }
            return
        }
        #endif
        do {
            let paths = tree.entries.map(\.path)
            for start in stride(from: 0, to: paths.count, by: 200) {
                let summaries = try await PhrenConnection.codeOutlineSummary(host: origin.host,
                    privateKey: DeviceSSHKey.load(origin.host.id), project: origin.project,
                    paths: Array(paths[start..<min(paths.count, start + 200)]), storeID: origin.storeID)
                try Task.checkCancellation()
                for summary in summaries { model.workingTree.summaries[summary.path] = summary }
            }
        } catch { /* The ordinary tree remains usable when the optional index is unavailable. */ }
    }

    private func toggle(_ entry: GitWorkingTree.Entry) {
        guard entry.isDirectory else { return }
        if expanded.contains(entry.path) {
            expanded.remove(entry.path)
        } else {
            expanded.insert(entry.path)
            if children[entry.path] == nil || children[entry.path]?.version != tree?.version { loadChildren(entry.path) }
        }
    }

    /// A changed file opens the repository diff; an untracked one gets the same
    /// empty section the chat's changes screen gives it. Anything that cannot
    /// be matched is left alone rather than opening a wrong file.
    private func openEntry(_ entry: GitWorkingTree.Entry) {
        guard !entry.isDirectory, let status = entry.status, status != .unknown, status != .changed else { return }
        openTask?.cancel()
        openTask = Task { await openDiff(entry) }
    }

    @MainActor
    private func openDiff(_ entry: GitWorkingTree.Entry) async {
        do {
            let result: AgentRepositoryDiff
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                result = try AgentChatFixture.gitDiff()
            } else {
                result = try await PhrenConnection.repositoryDiff(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, paths: [entry.path], child: child)
            }
            #else
            result = try await PhrenConnection.repositoryDiff(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, paths: [entry.path], child: child)
            #endif
            try Task.checkCancellation()
            let files = result.files + (result.related?.flatMap(\.files) ?? [])
            guard let file = files.first(where: { $0.path == entry.path }) else { return }
            let section = file.sections.first(where: { $0.kind == "unstaged" }) ?? file.sections.first
                ?? (file.status.trimmingCharacters(in: .whitespaces) == "??" ? AgentRepositoryDiff.Section(id: "untracked:\(file.path)", kind: "unstaged") : nil)
            guard let section else { return }
            opened = DiffTarget(file: file, section: section)
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func message(_ title: String, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(PhrenTheme.Font.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text)
            if let detail { Text(detail).font(PhrenTheme.Font.footnote).foregroundStyle(PhrenTheme.textMuted) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        .listRowBackground(Color.clear)
    }
}

private struct WorkingTreeRow: View {
    let entry: GitWorkingTree.Entry
    let level: Int
    let expanded: Set<String>
    let children: [String: GitWorkingTree]
    let loading: Set<String>
    let summaries: [String: CodeOutlineSummary]
    let onSymbol: (String) -> Void
    let onToggle: (GitWorkingTree.Entry) -> Void
    let onOpen: (GitWorkingTree.Entry) -> Void

    private var isExpanded: Bool { expanded.contains(entry.path) }

    var body: some View {
        HStack(spacing: 4) {
            Button {
                if entry.isDirectory { onToggle(entry) } else { onOpen(entry) }
            } label: { row }
                .buttonStyle(.plain)
                .accessibilityIdentifier("changes-tree-entry:\(entry.path)")
            if let summary = summaries[entry.path], summary.symbols > 0 {
                if let symbol = summary.symbol, !entry.isDirectory {
                    Button { onSymbol(symbol) } label: {
                        PhrenChip(text: summary.label).frame(minWidth: 44, minHeight: PhrenDensity.treeRowHeight)
                            .contentShape(Rectangle().inset(by: -6))
                    }.buttonStyle(.plain)
                        .accessibilityLabel("\(summary.symbols) symbols, \(summary.kinds.map(\.kind).joined(separator: ", "))")
                        .accessibilityIdentifier("changes-tree-symbols:\(entry.path)")
                } else {
                    PhrenChip(text: "\(summary.symbols) symbols")
                }
            }
        }
        .padding(.leading, 12 + CGFloat(level) * PhrenDensity.treeIndent).padding(.trailing, 12)
        .overlay(alignment: .leading) {
            Color.clear.frame(width: 1, height: PhrenDensity.treeRowHeight).accessibilityElement()
                .accessibilityIdentifier("changes-tree-row:\(entry.path)").allowsHitTesting(false)
        }
        if entry.isDirectory, isExpanded, let child = children[entry.path] {
            ForEach(child.entries) { sub in
                WorkingTreeRow(entry: sub, level: level + 1, expanded: expanded, children: children,
                               loading: loading, summaries: summaries, onSymbol: onSymbol, onToggle: onToggle, onOpen: onOpen)
            }
        }
    }

    private var row: some View {
        HStack(spacing: 8) {
            if entry.isDirectory {
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PhrenTheme.textMuted)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .frame(width: 14)
            } else {
                Color.clear.frame(width: 14)
            }
            icon
            Text(entry.name).font(PhrenTypography.monoFootnote).foregroundStyle(PhrenTheme.text)
                .lineLimit(1).truncationMode(.middle)
            if entry.isDirectory, loading.contains(entry.path) {
                ProgressView().controlSize(.mini)
            }
            if !entry.isDirectory, let status = entry.status {
                ChangesStatusDot(status: status.rawValue)
            }
            Spacer(minLength: 0)
            if entry.isDirectory, let count = entry.fileCount {
                Text("\(count)").font(PhrenTypography.monoCaption).foregroundStyle(PhrenTheme.textMuted)
            }
        }
        .frame(maxWidth: .infinity, minHeight: PhrenDensity.treeRowHeight, alignment: .leading)
        .contentShape(Rectangle().inset(by: -6))
    }

    private var icon: some View {
        ZStack(alignment: .bottomTrailing) {
            PhrenFileTypeIcon(path: entry.name, folder: entry.isDirectory, size: 14)
            if entry.isDirectory, entry.status == .changed {
                Circle().fill(PhrenTheme.danger).frame(width: 7, height: 7)
                    .overlay(Circle().strokeBorder(PhrenTheme.surface, lineWidth: 1))
                    .offset(x: 2, y: 2)
            }
        }
    }

}
