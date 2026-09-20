import PhrenKit
import PhrenLive
import SwiftUI

/// The pane's working tree, laid out like VS Code's Source Control view:
/// Staged Changes and Changes, each file with its status letter, name, dim
/// folder, and line counts. A file with both staged and unstaged edits is
/// listed under both, as it is there, and each opens that group's diff.
/// Opened from a tool card, it also carries the paths that command named:
/// the computer adds what changed under them — in another repository, or in
/// a commit a hook already made — as further groups below.
struct AgentDiffView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    var paths: [String] = []
    var child: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var diff: AgentRepositoryDiff?
    @State private var counts: [String: (added: Int, removed: Int)] = [:]
    @State private var error: String?
    @State private var visible = false
    @State private var refresh = UUID()
    @State private var opened: Entry?
    private var active: Bool { visible && scenePhase == .active && (try? LiveSessionPreferences.read(hostData))?.hosts.first(where: { $0.id == session.host.id }) == session.host }

    private struct Entry: Identifiable, Hashable {
        let file: AgentRepositoryDiff.File
        let section: AgentRepositoryDiff.Section
        var id: String { section.id }
        static func == (lhs: Entry, rhs: Entry) -> Bool { lhs.id == rhs.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }

    private struct FileNode: Identifiable {
        let id: String
        let name: String
        var entry: Entry?
        var children: [FileNode]?

        static func tree(_ entries: [Entry], prefix: String = "") -> [FileNode] {
            let groups = Dictionary(grouping: entries) { entry in
                String(entry.file.path.dropFirst(prefix.count).split(separator: "/").first ?? "")
            }
            return groups.keys.sorted().map { name in
                let path = prefix + name
                let values = groups[name] ?? []
                if let file = values.first(where: { $0.file.path == path }) {
                    return FileNode(id: file.id, name: name, entry: file)
                }
                return FileNode(id: "folder:\(path)", name: name, children: tree(values, prefix: path + "/"))
            }.sorted {
                if ($0.children != nil) != ($1.children != nil) { return $0.children != nil }
                return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
        }
    }

    private func entries(_ files: [AgentRepositoryDiff.File], kind: String) -> [Entry] {
        files.flatMap { file -> [Entry] in
            if kind == "unstaged", file.status == "??" {
                // Untracked: nothing to compare yet, still a change VS Code lists.
                return [Entry(file: file, section: .init(id: "untracked:\(file.path)", kind: "unstaged", binary: nil, loadState: nil, patch: nil))]
            }
            return file.sections.filter { $0.kind == kind }.map { Entry(file: file, section: $0) }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            PhrenList {
                if let diff {
                    let staged = entries(diff.files, kind: "staged"), unstaged = entries(diff.files, kind: "unstaged"), committed = entries(diff.files, kind: "committed")
                    summary(root: diff.root, branch: diff.branch, files: diff.files, changed: staged.count + unstaged.count + committed.count)
                    if staged.isEmpty && unstaged.isEmpty && committed.isEmpty {
                        Section { Label("Working tree is clean", systemImage: "checkmark.circle").foregroundStyle(PhrenTheme.success) }
                    }
                    if !staged.isEmpty { group("Staged Changes", staged) }
                    if !unstaged.isEmpty { group("Changes", unstaged) }
                    if !committed.isEmpty { group("Committed", committed) }
                    // What the command wrote elsewhere, one block per repository.
                    ForEach(diff.related ?? []) { other in
                        let staged = entries(other.files, kind: "staged"), unstaged = entries(other.files, kind: "unstaged"), committed = entries(other.files, kind: "committed")
                        summary(root: other.root, branch: other.branch, files: other.files, changed: staged.count + unstaged.count + committed.count)
                        if !staged.isEmpty { group("Staged Changes", staged) }
                        if !unstaged.isEmpty { group("Changes", unstaged) }
                        if !committed.isEmpty { group("Committed", committed) }
                    }
                } else if error == nil {
                    Section { ProgressView("Loading repository changes…") }
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) } }
                if child == nil {
                    Section { NavigationLink { HerdrTerminalView(host: session.host, session: session, target: target) } label: { Label("Open Herdr terminal", systemImage: "terminal") } }
                }
            }
        }
        .navigationDestination(item: $opened) {
            FileDiffView(file: $0.file, section: $0.section).toolbar(.visible, for: .navigationBar)
        }
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { visible = true }.onDisappear { visible = false }
        .task(id: Run(active: active, refresh: refresh)) {
            guard active else { return }
            error = nil
            do {
                let result: AgentRepositoryDiff
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled {
                    // Opened from the heredoc card, the store it wrote to comes back as a related repository.
                    let related = child == nil && !paths.isEmpty ? #","related":[{"root":"/Users/fixture/.phren","branch":"main","files":[{"path":"phone/FINDINGS.md","status":"  ","sections":[{"id":"committed:phone/FINDINGS.md","kind":"committed","binary":false,"loadState":"loaded","note":"a1b2c3d · phren: capture finding · 1 minute ago","patch":"diff --git a/phone/FINDINGS.md b/phone/FINDINGS.md\n--- a/phone/FINDINGS.md\n+++ b/phone/FINDINGS.md\n@@ -2,2 +2,3 @@\n - Tiles are one sprite\n+- Accent is purple now\n - Offline first\n"}]}]}]"# : ""
                    result = try AgentRepositoryDiff.read(Data((#"{"root":"/work/phone","launchPath":"/work/phone","branch":"main","files":[{"path":"Theme.swift","status":" M","sections":[{"id":"unstaged:Theme.swift","kind":"unstaged","binary":false,"patch":"@@ -1,3 +1,3 @@\n import SwiftUI\n-let accent = green\n+let accent = purple\n let radius = 12"}]},{"path":"Sources/App/Settings.swift","status":"M ","sections":[{"id":"staged:Sources/App/Settings.swift","kind":"staged","binary":false,"patch":"@@ -10,4 +10,5 @@ struct Settings {\n     var theme = \"dark\"\n+    var compact = true\n     var sound = false\n"}]},{"path":"Notes.md","status":"??","sections":[]}]"# + related + "}").utf8))
                } else { result = try await PhrenConnection.repositoryDiff(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, paths: paths, child: child) }
                #else
                result = try await PhrenConnection.repositoryDiff(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, paths: paths, child: child)
                #endif
                try Task.checkCancellation()
                // Counted once here rather than per row: the bridge can hand
                // back hundreds of patches, and the list re-renders freely.
                var totals: [String: (added: Int, removed: Int)] = [:]
                for file in result.files + (result.related ?? []).flatMap(\.files) {
                    for section in file.sections where section.patch?.isEmpty == false {
                        let preview = DiffPreview(section.patch!)
                        totals[section.id] = (preview.added, preview.removed)
                    }
                }
                counts = totals
                diff = result
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("agent-diff-back")
            Text(child == nil ? "Repository changes" : "Agent changes")
                .font(.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text).lineLimit(1)
            Spacer(minLength: 0)
            Button { refresh = UUID() } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 17))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Refresh diff")
            .accessibilityIdentifier("agent-diff-refresh")
        }
        .foregroundStyle(PhrenTheme.text)
        .padding(.horizontal, 4).padding(.vertical, 2)
        .accessibilityIdentifier("agent-diff-header")
    }

    /// GitHub's "Files changed" summary line: the branch, the count, the
    /// totals — one flat row, no card chrome. Once per repository.
    private func summary(root: String, branch: String?, files: [AgentRepositoryDiff.File], changed: Int) -> some View {
        let ids = Set(files.flatMap { $0.sections.map(\.id) })
        let totals = counts.filter { ids.contains($0.key) }.values
        return Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.triangle.branch").font(.caption).foregroundStyle(PhrenTheme.chatNeutral)
                    Text(branch ?? "Unborn branch").font(.system(.subheadline, design: .monospaced).weight(.semibold))
                    Spacer()
                    DiffCounts(added: totals.reduce(0) { $0 + $1.added }, removed: totals.reduce(0) { $0 + $1.removed })
                }
                HStack(spacing: 6) {
                    Text("\(changed) file\(changed == 1 ? "" : "s") changed")
                    Text("·").foregroundStyle(PhrenTheme.textDim)
                    Text(root).lineLimit(1).truncationMode(.head)
                }.font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
            .accessibilityIdentifier("diff-repository:\(root)")
        }
    }

    /// A file list the way GitHub draws it: flat rows, a file icon, the
    /// path, the counts and a five-block bar — and no disclosure chevrons.
    private func group(_ title: String, _ entries: [Entry]) -> some View {
        Section {
            OutlineGroup(FileNode.tree(entries), children: \.children) { node in
                if let entry = node.entry {
                    Button { opened = entry } label: {
                        FileChangeRow(file: entry.file, counts: counts[entry.section.id], note: entry.section.note)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(PhrenTheme.surface)
                    .accessibilityIdentifier("diff-file:\(entry.section.id)")
                } else {
                    Label(node.name, systemImage: "folder").font(.system(.subheadline, design: .monospaced))
                        .foregroundStyle(PhrenTheme.chatNeutral)
                }
            }
        } header: {
            HStack {
                Text(title)
                Spacer()
                Text("\(entries.count)").monospacedDigit()
            }
        }
    }

    private struct Run: Equatable { let active: Bool; let refresh: UUID }
}

/// One file in the changes list, GitHub's way: a file-type icon, the name,
/// the folder in a dimmer weight, then `+N −M` and a five-block bar that
/// shows the balance of additions to deletions at a glance.
struct FileChangeRow: View {
    let file: AgentRepositoryDiff.File
    let counts: (added: Int, removed: Int)?
    /// The commit that carried a `committed` section: hash · subject · age.
    var note: String? = nil

    private var parts: (name: String, folder: String?) {
        guard let slash = file.path.lastIndex(of: "/") else { return (file.path, nil) }
        return (String(file.path[file.path.index(after: slash)...]), String(file.path[..<slash]))
    }

    static func icon(for path: String) -> String {
        switch SyntaxTokenizer.Language.detect(path) {
        case .swift, .python, .javascript, .typescript, .rust, .go, .ruby, .css, .sql: return "chevron.left.forwardslash.chevron.right"
        case .json, .yaml, .toml: return "curlybraces"
        case .markdown: return "text.alignleft"
        case .html: return "globe"
        case .shell: return "terminal"
        case .plain:
            let ext = path.split(separator: ".").last.map { $0.lowercased() } ?? ""
            return ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].contains(ext) ? "photo" : "doc"
        }
    }

    var body: some View {
        let parts = parts
        HStack(spacing: 10) {
            Image(systemName: Self.icon(for: file.path)).font(.system(size: 13)).foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(parts.name).font(.system(.subheadline, design: .monospaced).weight(.medium)).foregroundStyle(PhrenTheme.chatText)
                        .lineLimit(1).truncationMode(.middle)
                    if !file.status.trimmingCharacters(in: .whitespaces).isEmpty { DiffStatusBadge(status: file.status) }
                }
                if let folder = parts.folder {
                    Text(folder).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral).lineLimit(1).truncationMode(.head)
                }
                if let note {
                    Text(note).font(.caption2).foregroundStyle(PhrenTheme.chatNeutralDim).lineLimit(1).truncationMode(.tail)
                }
            }
            Spacer(minLength: 8)
            if let counts {
                VStack(alignment: .trailing, spacing: 4) {
                    DiffCounts(added: counts.added, removed: counts.removed)
                    DiffBar(added: counts.added, removed: counts.removed)
                }
            } else if file.status == "??" {
                Text("untracked").font(.caption2).foregroundStyle(PhrenTheme.chatNeutralDim)
            }
        }
        .contentShape(Rectangle())
    }
}

/// GitHub's diffstat blocks: five squares split between green and red in
/// proportion, grey for the remainder.
struct DiffBar: View {
    let added: Int
    let removed: Int
    var body: some View {
        let total = max(1, added + removed)
        let green = added == 0 ? 0 : max(1, Int((Double(added) / Double(total) * 5).rounded()))
        let red = removed == 0 ? 0 : max(1, min(5 - green, Int((Double(removed) / Double(total) * 5).rounded())))
        HStack(spacing: 2) {
            ForEach(0..<5, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1)
                    .fill(index < green ? PhrenTheme.success : index < green + red ? PhrenTheme.danger : PhrenTheme.borderStrong)
                    .frame(width: 8, height: 8)
            }
        }
        .accessibilityHidden(true)
    }
}
