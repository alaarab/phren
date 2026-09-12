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
    private var active: Bool { visible && scenePhase == .active && (try? LiveSessionPreferences.read(hostData))?.hosts.first(where: { $0.id == session.host.id }) == session.host }

    private struct Entry: Identifiable {
        let file: AgentRepositoryDiff.File
        let section: AgentRepositoryDiff.Section
        var id: String { section.id }
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
                Section {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.triangle.branch").foregroundStyle(PhrenTheme.accent)
                        Text(diff.branch ?? "Unborn branch").font(.subheadline.weight(.semibold))
                        Spacer()
                        DiffCounts(added: counts.values.reduce(0) { $0 + $1.added }, removed: counts.values.reduce(0) { $0 + $1.removed })
                    }
                    Text(diff.root).font(.caption.monospaced()).foregroundStyle(PhrenTheme.textMuted).textSelection(.enabled)
                } header: {
                    Text("\(session.host.name) · \(session.workspaceName)")
                }
                let staged = entries(diff, kind: "staged"), unstaged = entries(diff, kind: "unstaged")
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

    private func group(_ title: String, _ entries: [Entry]) -> some View {
        Section {
            ForEach(entries) { entry in
                NavigationLink {
                    FileDiffView(file: entry.file, section: entry.section)
                } label: {
                    FileChangeRow(file: entry.file, counts: counts[entry.section.id])
                }
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

/// One file in the changes list: status letter, name, then the folder in a
/// dimmer weight, the way VS Code's tree does it, with the counts trailing.
struct FileChangeRow: View {
    let file: AgentRepositoryDiff.File
    let counts: (added: Int, removed: Int)?

    private var parts: (name: String, folder: String?) {
        guard let slash = file.path.lastIndex(of: "/") else { return (file.path, nil) }
        return (String(file.path[file.path.index(after: slash)...]), String(file.path[..<slash]))
    }

    var body: some View {
        let parts = parts
        HStack(spacing: 10) {
            DiffStatusBadge(status: file.status)
            VStack(alignment: .leading, spacing: 2) {
                Text(parts.name).font(.subheadline.monospaced().weight(.medium)).lineLimit(1).truncationMode(.middle)
                if let folder = parts.folder {
                    Text(folder).font(.caption.monospaced()).foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 8)
            if let counts { DiffCounts(added: counts.added, removed: counts.removed) }
            else if file.status == "??" { Text("untracked").font(.caption2).foregroundStyle(PhrenTheme.textDim) }
        }
        .padding(.vertical, 3)
    }
}
