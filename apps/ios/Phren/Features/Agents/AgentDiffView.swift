import PhrenKit
import PhrenLive
import SwiftUI

/// The pane's working tree, laid out like VS Code's Source Control view:
/// Staged Changes and Changes, each file with its status letter, name, dim
/// folder, and line counts. A file with both staged and unstaged edits is
/// listed under both, as it is there, and each opens that group's diff.
struct AgentDiffView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
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

    private func entries(_ diff: AgentRepositoryDiff, kind: String) -> [Entry] {
        diff.files.flatMap { file -> [Entry] in
            if kind == "unstaged", file.status == "??" {
                // Untracked: nothing to compare yet, still a change VS Code lists.
                return [Entry(file: file, section: .init(id: "untracked:\(file.path)", kind: "unstaged", binary: nil, loadState: nil, patch: nil))]
            }
            return file.sections.filter { $0.kind == kind }.map { Entry(file: file, section: $0) }
        }
    }

    var body: some View {
        PhrenList {
            if let diff {
                let staged = entries(diff, kind: "staged"), unstaged = entries(diff, kind: "unstaged")
                // GitHub's "Files changed" summary line: the branch, the count,
                // the totals — one flat row, no card chrome.
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            Image(systemName: "arrow.triangle.branch").font(.caption).foregroundStyle(PhrenTheme.chatNeutral)
                            Text(diff.branch ?? "Unborn branch").font(.system(.subheadline, design: .monospaced).weight(.semibold))
                            Spacer()
                            DiffCounts(added: counts.values.reduce(0) { $0 + $1.added }, removed: counts.values.reduce(0) { $0 + $1.removed })
                        }
                        HStack(spacing: 6) {
                            Text("\(staged.count + unstaged.count) file\(staged.count + unstaged.count == 1 ? "" : "s") changed")
                            Text("·").foregroundStyle(PhrenTheme.textDim)
                            Text(diff.root).lineLimit(1).truncationMode(.head)
                        }.font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral)
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                }
                if staged.isEmpty && unstaged.isEmpty {
                    Section { Label("Working tree is clean", systemImage: "checkmark.circle").foregroundStyle(PhrenTheme.success) }
                }
                if !staged.isEmpty { group("Staged Changes", staged) }
                if !unstaged.isEmpty { group("Changes", unstaged) }
            } else if error == nil {
                Section { ProgressView("Loading repository changes…") }
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) } }
            Section { NavigationLink { HerdrTerminalView(host: session.host, session: session, target: target) } label: { Label("Open Herdr terminal", systemImage: "terminal") } }
        }
        .navigationTitle("Repository changes").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $opened) { FileDiffView(file: $0.file, section: $0.section) }
        .toolbar { Button("Refresh diff", systemImage: "arrow.clockwise") { refresh = UUID() } }
        .onAppear { visible = true }.onDisappear { visible = false }
        .task(id: Run(active: active, refresh: refresh)) {
            guard active else { return }
            error = nil
            do {
                let result: AgentRepositoryDiff
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled {
                    result = try AgentRepositoryDiff.read(Data(#"{"root":"/work/phone","launchPath":"/work/phone","branch":"main","files":[{"path":"Theme.swift","status":" M","sections":[{"id":"unstaged:Theme.swift","kind":"unstaged","binary":false,"patch":"@@ -1,3 +1,3 @@\n import SwiftUI\n-let accent = green\n+let accent = purple\n let radius = 12"}]},{"path":"Sources/App/Settings.swift","status":"M ","sections":[{"id":"staged:Sources/App/Settings.swift","kind":"staged","binary":false,"patch":"@@ -10,4 +10,5 @@ struct Settings {\n     var theme = \"dark\"\n+    var compact = true\n     var sound = false\n"}]},{"path":"Notes.md","status":"??","sections":[]}]}"#.utf8))
                } else { result = try await PhrenConnection.repositoryDiff(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target) }
                #else
                result = try await PhrenConnection.repositoryDiff(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target)
                #endif
                try Task.checkCancellation()
                // Counted once here rather than per row: the bridge can hand
                // back hundreds of patches, and the list re-renders freely.
                var totals: [String: (added: Int, removed: Int)] = [:]
                for file in result.files {
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

    /// A file list the way GitHub draws it: flat rows, a file icon, the
    /// path, the counts and a five-block bar — and no disclosure chevrons.
    private func group(_ title: String, _ entries: [Entry]) -> some View {
        Section {
            ForEach(entries) { entry in
                Button { opened = entry } label: {
                    FileChangeRow(file: entry.file, counts: counts[entry.section.id])
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowBackground(PhrenTheme.surface)
                .accessibilityIdentifier("diff-file:\(entry.section.id)")
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
                    DiffStatusBadge(status: file.status)
                }
                if let folder = parts.folder {
                    Text(folder).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral).lineLimit(1).truncationMode(.head)
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
