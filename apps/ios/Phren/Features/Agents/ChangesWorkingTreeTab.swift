import PhrenKit
import PhrenLive
import SwiftUI

struct ChangesWorkingTreeTab: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let child: String?
    @State private var tree: GitWorkingTree?
    @State private var children: [String: GitWorkingTree] = [:]
    @State private var expanded: Set<String> = []
    @State private var loading: Set<String> = []
    @State private var error: String?
    @State private var opened: DiffTarget?
    @State private var loadTask: Task<Void, Never>?
    @State private var childTasks: [String: Task<Void, Never>] = [:]
    @State private var openTask: Task<Void, Never>?

    init(session: LiveAgentSession, target: AgentChatTarget, child: String?) {
        self.session = session
        self.target = target
        self.child = child
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
            PhrenList(plain: true) {
                if let tree {
                    if tree.entries.isEmpty {
                        message("No files here", detail: nil)
                    } else {
                        ForEach(tree.entries) { entry in
                            WorkingTreeRow(entry: entry, level: 0, expanded: expanded, children: children,
                                           loading: loading, onToggle: toggle, onOpen: openEntry)
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
            .environment(\.defaultMinListRowHeight, 32)
            .refreshable { await loadRoot() }
        }
        .accessibilityIdentifier("changes-tree")
        .navigationDestination(item: $opened) { FileDiffView(file: $0.file, section: $0.section) }
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
            tree = result; children = [:]; expanded = []; error = nil
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
            children[path] = result; loading.remove(path); error = nil
        } catch {
            if !Task.isCancelled { loading.remove(path); self.error = error.localizedDescription }
        }
    }

    private func toggle(_ entry: GitWorkingTree.Entry) {
        guard entry.isDirectory else { return }
        if expanded.contains(entry.path) {
            expanded.remove(entry.path)
        } else {
            expanded.insert(entry.path)
            if children[entry.path] == nil { loadChildren(entry.path) }
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
    let onToggle: (GitWorkingTree.Entry) -> Void
    let onOpen: (GitWorkingTree.Entry) -> Void

    private var isExpanded: Bool { expanded.contains(entry.path) }

    var body: some View {
        Button {
            if entry.isDirectory { onToggle(entry) } else { onOpen(entry) }
        } label: { row }
            .buttonStyle(.plain)
            .frame(minHeight: 32)
            .listRowInsets(EdgeInsets(top: 0, leading: 12 + CGFloat(level) * 12, bottom: 0, trailing: 12))
            .accessibilityIdentifier("changes-tree-entry:\(entry.path)")
            // A marker beside the button, not over it: an element covering
            // the row would take the hit test away from the button itself.
            .overlay(alignment: .leading) {
                Color.clear.frame(width: 1, height: 32).accessibilityElement()
                    .accessibilityIdentifier("changes-tree-row:\(entry.path)")
                    .allowsHitTesting(false)
            }
        if entry.isDirectory, isExpanded, let child = children[entry.path] {
            ForEach(child.entries) { sub in
                WorkingTreeRow(entry: sub, level: level + 1, expanded: expanded, children: children,
                               loading: loading, onToggle: onToggle, onOpen: onOpen)
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
        }
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
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
