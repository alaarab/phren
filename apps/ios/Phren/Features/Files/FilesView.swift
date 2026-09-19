import PhrenKit
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
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(PhrenTheme.textMuted)
                    TextField("Filter files", text: $query)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .foregroundStyle(PhrenTheme.textMuted)
                    }
                }
                .font(.callout).padding(10)
                .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 12))

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
    @State private var mode = Mode.preview
    @State private var editing = false
    @State private var copied = false

    enum Mode: Hashable { case preview, source }

    private var context: StoreContext? { model.storeContexts.first { $0.id == storeId } }
    private var content: String { context?.store.read(path) ?? "" }
    private var language: SyntaxTokenizer.Language { SyntaxTokenizer.Language.detect(path) }
    private var isMarkdown: Bool { language == .markdown }
    private var isWritable: Bool { LocalStore.isWritablePath(path) }

    var body: some View {
        VStack(spacing: 0) {
            if isMarkdown {
                PhrenIconSegment(items: [
                    .init(value: Mode.preview, icon: "doc.richtext", label: "Preview"),
                    .init(value: Mode.source, icon: "chevron.left.forwardslash.chevron.right", label: "Source"),
                ], selection: $mode)
                .padding(.horizontal, PhrenTheme.Space.large).padding(.top, PhrenTheme.Space.small)
            }
            if mode == .preview, isMarkdown {
                ScrollView {
                    ChatRichText(text: content)
                        .padding(PhrenTheme.Space.large)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                ScrollView([.horizontal, .vertical]) {
                    CodeTextView(code: content, language: language)
                }
            }
        }
        .phrenScreen()
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button(copied ? "Copied" : "Copy file", systemImage: copied ? "checkmark" : "doc.on.doc") {
                        UIPasteboard.general.string = content
                        copied = true
                    }
                    if isWritable {
                        Button("Edit", systemImage: "pencil") { editing = true }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("File actions")
            }
        }
        .sheet(isPresented: $editing) {
            DocumentEditorSheet(title: (path as NSString).lastPathComponent, storeId: storeId,
                                draft: DocumentDraft(path: path, content: content))
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
