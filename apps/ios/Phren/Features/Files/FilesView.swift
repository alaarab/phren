import PhrenKit
import PhrenLive
import SwiftUI

struct FilesView: View {
    @Environment(AppModel.self) private var model
    @State private var storeId: String?
    @State private var query = ""
    @State private var target: FileTarget?

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

/// Source with line numbers. Rows are built lazily as they scroll into view,
/// and each line's colors come from `CodeHighlighting`'s cache, so a render
/// colors only the lines that are new on screen, never the whole file.
struct CodeTextView: View {
    let code: String
    let language: SyntaxTokenizer.Language

    var body: some View {
        let layout = CodeTextLayout.of(code)
        LazyVStack(alignment: .leading, spacing: 0) {
            // The longest line, drawn at zero height, holds the width steady:
            // lazy rows alone would widen the horizontal scroll as they load.
            Text(layout.longest).font(PhrenTypography.monoFootnote).fixedSize()
                .frame(height: 0).padding(.leading, 46).hidden().accessibilityHidden(true)
            ForEach(layout.lines.indices, id: \.self) { index in
                CodeTextLine(number: index + 1, line: layout.lines[index], language: language)
            }
        }
        .padding(.vertical, PhrenTheme.Space.small).padding(.horizontal, 10)
    }
}

private struct CodeTextLine: View {
    let number: Int
    let line: String
    let language: SyntaxTokenizer.Language

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(PhrenTypography.monoCaption2)
                .foregroundStyle(PhrenTheme.textDim)
                .frame(width: 36, alignment: .trailing)
            Text(CodeHighlighting.highlighted(line.isEmpty ? " " : line, language: language))
                .font(PhrenTypography.monoFootnote)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.vertical, 0.5)
    }
}

/// The file split into lines once per distinct text, not once per render.
private struct CodeTextLayout {
    let lines: [String]
    let longest: String

    @MainActor private static var last: (code: String, layout: CodeTextLayout)?

    @MainActor static func of(_ code: String) -> CodeTextLayout {
        if let last, last.code == code { return last.layout }
        let lines = code.components(separatedBy: "\n")
        let layout = CodeTextLayout(lines: lines, longest: lines.max { $0.count < $1.count } ?? "")
        last = (code, layout)
        return layout
    }
}
