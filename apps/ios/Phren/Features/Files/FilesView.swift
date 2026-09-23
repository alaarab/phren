import PhrenKit
import PhrenLive
import SwiftUI

struct FilesView: View {
    @Environment(AppModel.self) private var model
    @State private var storeId: String?
    @State private var query = ""
    @State private var target: FileTarget?
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    private var hosts: [LiveHost] { (try? LiveSessionPreferences.read(hostData))?.hosts ?? [] }

    struct FileTarget: Identifiable, Hashable {
        let storeId: String
        let path: String
        var id: String { storeId + "/" + path }
    }

    private var contexts: [StoreContext] { model.storeContexts }
    private var activeStoreId: String? { storeId ?? contexts.first?.id }

    private func paths(for storeId: String) -> [String] {
        guard let context = contexts.first(where: { $0.id == storeId }) else { return [] }
        let trimmed = query.trimmingCharacters(in: .whitespaces).lowercased()
        let all = context.store.allPaths().filter { !$0.hasSuffix(".phren-team.yaml") }
        return (trimmed.isEmpty ? all : all.filter { $0.lowercased().contains(trimmed) }).sorted()
    }

    private func grouped(_ paths: [String]) -> [(folder: String, files: [String])] {
        var groups: [String: [String]] = [:]
        for path in paths {
            let folder = path.contains("/") ? String(path.split(separator: "/").first!) : ""
            groups[folder, default: []].append(path)
        }
        return groups.keys
            .sorted { ($0.isEmpty ? "~" : $0) < ($1.isEmpty ? "~" : $1) }
            .map { ($0, (groups[$0] ?? []).sorted()) }
    }

    var body: some View {
        PhrenScrollScreen(spacing: 4) {
            if !hosts.isEmpty {
                PhrenSectionHeader(title: "Computers", count: hosts.count)
                ForEach(hosts) { host in
                    NavigationLink { RepositoryProjectsView(host: host) } label: {
                        PhrenMenuRow(title: host.name, subtitle: "Browse project files", icon: "desktopcomputer", compact: true)
                    }.buttonStyle(.plain)
                }
            }
            if contexts.isEmpty {
                PhrenEmptyState(title: "No store", message: "Connect a store to browse its files.")
            } else {
                if contexts.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(contexts, id: \.id) { context in
                                Button { storeId = context.id } label: {
                                    PhrenChip(text: context.descriptor.displayName,
                                              role: context.id == activeStoreId ? .project : .scope)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                PhrenSearchField(text: $query, placeholder: "Filter files", identifier: "files-filter")

                if let active = activeStoreId {
                    let groups = grouped(paths(for: active))
                    if groups.isEmpty {
                        Text("No files match \u{201C}\(query)\u{201D}.")
                            .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
                    }
                    ForEach(groups, id: \.folder) { group in
                        PhrenSectionHeader(title: group.folder.isEmpty ? "Store root" : group.folder, count: group.files.count)
                        ForEach(group.files, id: \.self) { path in
                            Button { target = FileTarget(storeId: active, path: path) } label: {
                                fileRow(path)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $target) { target in
            FileViewerView(storeId: target.storeId, path: target.path)
        }
    }

    private func fileRow(_ path: String) -> some View {
        HStack(spacing: PhrenTheme.Space.small) {
            PhrenFileTypeIcon(path: path)
            VStack(alignment: .leading, spacing: 1) {
                Text((path as NSString).lastPathComponent)
                    .font(.system(.subheadline, design: .monospaced).weight(.medium))
                    .foregroundStyle(PhrenTheme.text).lineLimit(1)
                Text(path)
                    .font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(PhrenTheme.textDim)
        }
        .padding(.horizontal, PhrenTheme.Space.medium).padding(.vertical, 9)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
        .contentShape(Rectangle())
    }
}

struct FileViewerView: View {
    let storeId: String
    let path: String

    @Environment(AppModel.self) private var model
    @State private var editing = false
    @State private var copied = false

    private var context: StoreContext? { model.storeContexts.first { $0.id == storeId } }
    private var content: String { context?.store.read(path) ?? "" }
    // `phren.project.yaml` is writable in the store but not by this editor:
    // the Knobs screen owns it, and a raw edit could drop sibling keys.
    private var isWritable: Bool {
        model.canPush(storeId: storeId) && LocalStore.isWritablePath(path)
            && !LocalStore.isProjectConfigPath(path)
    }

    var body: some View {
        FileViewer(item: FileViewerItem(name: (path as NSString).lastPathComponent) { Data(content.utf8) }, actions: fileActions)
            .id(ChatRenderKey.text(content))
        .sheet(isPresented: $editing) {
            DocumentEditorSheet(title: (path as NSString).lastPathComponent, storeId: storeId,
                                draft: DocumentDraft(path: path, content: content))
        }
    }

    private var fileActions: [PhrenControlAction] {
        var actions = [PhrenControlAction(id: "copy", title: copied ? "Copied" : "Copy file",
                                          icon: copied ? "checkmark" : "doc.on.doc") {
            UIPasteboard.general.string = content
            copied = true
        }]
        if isWritable {
            actions.append(PhrenControlAction(id: "edit", title: "Edit", icon: "pencil") { editing = true })
        }
        return actions
    }
}

/// Shared preview/source presentation for store documents and computer files.
struct DocumentContentView: View {
    let path: String
    let content: String
    var embedded = false
    @State private var source = false
    private var language: SyntaxTokenizer.Language { SyntaxTokenizer.Language.detect(path) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if language == .markdown {
                PhrenIconSegment(items: [
                    .init(value: false, icon: "doc.richtext", label: "Preview"),
                    .init(value: true, icon: "chevron.left.forwardslash.chevron.right", label: "Source"),
                ], selection: $source).padding(.horizontal, 12)
            }
            if !source && language == .markdown {
                if embedded { ChatRichText(text: content).frame(maxWidth: .infinity, alignment: .leading) }
                else { ScrollView { ChatRichText(text: content).padding(PhrenTheme.Space.large).frame(maxWidth: .infinity, alignment: .leading) } }
            } else if embedded {
                ScrollView(.horizontal) { CodeTextView(code: content, language: language) }
            } else {
                ScrollView([.horizontal, .vertical]) { CodeTextView(code: content, language: language) }
            }
        }
    }
}

struct RepositoryProjectsView: View {
    let host: LiveHost
    @Environment(AppModel.self) private var model
    var body: some View {
        PhrenList {
            ForEach(model.mergedProjects.filter { $0.project.name != "global" }) { item in
                NavigationLink { RepositoryLocationsView(host: host, project: item.project.name) } label: {
                    Label(item.project.name, systemImage: "folder")
                }
            }
        }.navigationTitle(host.name).phrenScreen()
    }
}

private struct RepositoryLocationsView: View {
    let host: LiveHost
    let project: String
    @State private var folders: [PhrenConnection.LocatedFolder]?
    @State private var error: String?
    var body: some View {
        PhrenList {
            if let folders {
                if folders.isEmpty { Text("No checkout found on this computer.") }
                ForEach(folders) { folder in
                    NavigationLink { RepositoryBrowserView(host: host, project: project, directory: folder.directory) } label: {
                        Label(folder.directory, systemImage: "folder").lineLimit(2)
                    }
                }
            } else if let error { Text(error).foregroundStyle(PhrenTheme.warning) }
            else { ProgressView("Finding project…") }
        }.navigationTitle(project).phrenScreen()
            .task {
                do { folders = try await PhrenConnection.locateProject(host: host, privateKey: DeviceSSHKey.load(host.id), project: project) }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
    }
}

private struct RepositoryBrowserView: View {
    let host: LiveHost
    let project: String
    let directory: String
    var path = ""
    @State private var response: PhrenConnection.RepositoryFileResponse?
    @State private var error: String?
    @State private var refresh = UUID()
    @State private var opened: FileViewerItem?
    var body: some View {
        Group {
            if let response {
                PhrenList {
                    ForEach(response.entries ?? []) { entry in
                        if entry.kind == "directory" {
                            NavigationLink { RepositoryBrowserView(host: host, project: project, directory: directory, path: entry.path) } label: {
                                Label(entry.name, systemImage: "folder")
                            }
                        } else {
                            Button { opened = FileViewerItem(host: host, file: RemoteFile(path: entry.path, project: project, directory: directory)) } label: {
                                HStack { PhrenFileTypeIcon(path: entry.path); Text(entry.name) }.frame(minHeight: 44)
                            }.buttonStyle(.plain).phrenIdentifier("repository-file:\(entry.path)")
                        }
                    }
                    if response.entries?.isEmpty == true { Text("Empty folder").foregroundStyle(PhrenTheme.textMuted) }
                    if response.truncated == true { Text("Showing the first 500 entries.").foregroundStyle(PhrenTheme.textMuted) }
                }
            } else if let error { Text(error).foregroundStyle(PhrenTheme.warning).padding() }
            else { Text("Loading files…").foregroundStyle(PhrenTheme.textMuted) }
        }.navigationTitle(path.isEmpty ? project : (path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline).phrenScreen()
            .toolbar {
                PhrenIconButton(icon: "arrow.clockwise", label: "Refresh files") { refresh = UUID() }
            }
            .fullScreenCover(item: $opened) { FileViewer(item: $0) }
            .task(id: refresh) {
                response = nil; error = nil
                do {
                    response = try await PhrenConnection.repositoryFiles(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, directory: directory, path: path)
                } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
    }
}

struct CodeTextView: View {
    let code: String
    let language: SyntaxTokenizer.Language

    var body: some View {
        let lines = code.components(separatedBy: "\n")
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .top, spacing: 10) {
                    Text("\(index + 1)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(PhrenTheme.textDim)
                        .frame(width: 36, alignment: .trailing)
                    Text(CodeHighlighting.highlighted(line.isEmpty ? " " : line, language: language))
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .padding(.vertical, 0.5)
            }
        }
        .padding(.vertical, PhrenTheme.Space.small).padding(.horizontal, 10)
    }
}
