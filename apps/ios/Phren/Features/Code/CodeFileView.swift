import PhrenKit
import PhrenLive
import SwiftUI

/// Where the code browser reads a project's files, and whether the
/// computer's code index can answer for their symbols.
struct CodeBrowserContext {
    let storeId: String
    let project: String
    let host: LiveHost?
    /// The checkout folder the computer located; nil lets the Hook choose.
    var checkout: String? = nil
    var origin: SessionCodeContext? = nil
    /// Read from a session's repository, as the Changes screen's working tree does.
    var session: (target: AgentChatTarget, child: String?, worktree: String?)? = nil
    var indexed = false

    func remote(_ path: String) -> RemoteFile {
        if let session { return RemoteFile(path: path, target: session.target, child: session.child, worktree: session.worktree) }
        return RemoteFile(path: path, project: project, directory: checkout)
    }

    @MainActor func viewerItem(_ path: String) -> FileViewerItem? {
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled, let data = CodeFixture.source(path) {
            return FileViewerItem(name: (path as NSString).lastPathComponent) { data }
        }
        #endif
        return host.map { FileViewerItem(host: $0, file: remote(path)) }
    }

    /// Files the code viewer shows as source; the rest keep the file viewer.
    static func opensAsSource(_ path: String) -> Bool {
        CodeSourceText.opensAsSource(FilePreviewKind.detect(name: path, contentType: nil))
    }
}

struct CodeFileLocation: Identifiable, Hashable {
    let path: String
    var line: Int? = nil
    var id: String { "\(path):\(line ?? 0)" }
}

/// One file's source with syntax colors, its outline, and tappable names the
/// index resolves. A name opens the symbol's dossier, which can go to its
/// definition in this or another file.
struct CodeFileView: View {
    let context: CodeBrowserContext
    let path: String
    var line: Int? = nil

    private enum Phase: Equatable { case loading, loaded, tooLarge(Int64), binary, failed(String) }
    private struct ScrollRequest: Equatable { let line: Int; let token = UUID() }

    @State private var phase = Phase.loading
    @State private var lines: [String] = []
    @State private var longest = ""
    @State private var outline: [CodeOutlineEntry] = []
    @State private var symbols = CodeFileSymbols()
    @State private var marked: Int?
    @State private var scroll: ScrollRequest?
    @State private var showOutline = false
    @State private var dossier: CodeDossierTarget?
    @State private var next: CodeFileLocation?
    @State private var viewer: FileViewerItem?

    private var name: String { (path as NSString).lastPathComponent }
    private var directory: String { (path as NSString).deletingLastPathComponent }
    private var language: SyntaxTokenizer.Language { .detect(path) }

    var body: some View {
        VStack(spacing: 0) {
            if !directory.isEmpty {
                Text(directory).font(PhrenTypography.monoCaption2).foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(1).truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.bottom, 4)
            }
            switch phase {
            case .loading:
                state("Reading \(name)…", id: "code-file-loading")
            case .loaded:
                source
            case .tooLarge(let size):
                state("\(ByteCountFormatter.string(fromByteCount: size, countStyle: .file)) is over the 2 MB the code viewer reads.",
                      id: "code-file-too-large", viewerAction: true)
            case .binary:
                state("Not a text file.", id: "code-file-binary", viewerAction: true)
            case .failed(let message):
                state(message, id: "code-file-error", warning: true)
            }
        }
        .background(PhrenTheme.bg)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if !outline.isEmpty {
                    PhrenIconButton(icon: "list.bullet.indent", label: "Outline") { showOutline = true }
                        .phrenIdentifier("code-file-outline")
                }
            }
        }
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityIdentifier("code-file:\(path)")
                .allowsHitTesting(false)
        }
        .phrenActionSheet(isPresented: $showOutline, title: name, actions: outlineActions, identifier: "code-outline",
                          searchPlaceholder: outlineRows.count > 8 ? "Filter symbols" : nil)
        .sheet(item: $dossier) { target in
            CodeSymbolDossier(storeId: context.storeId, project: context.project, symbol: target.name,
                              hosts: context.host.map { [$0] } ?? [], origin: context.origin) { file, line in
                dossier = nil
                go(file, line)
            }
            .presentationDetents([.medium, .large])
        }
        .navigationDestination(item: $next) { CodeFileView(context: context, path: $0.path, line: $0.line) }
        .fullScreenCover(item: $viewer) { FileViewer(item: $0) }
        .task(id: path) { await load() }
        .task(id: path) { await loadSymbols() }
    }

    private var source: some View {
        ScrollViewReader { proxy in
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    // The longest line at zero height keeps the width steady
                    // while lazy rows load.
                    Text(longest).font(PhrenTypography.monoFootnote).fixedSize()
                        .frame(height: 0).padding(.leading, 50).hidden().accessibilityHidden(true)
                    ForEach(lines.indices, id: \.self) { index in
                        CodeSourceLine(number: index + 1, text: lines[index], language: language,
                                       links: symbols.occurrences(in: lines[index], line: index + 1).map(\.range),
                                       marked: marked == index + 1)
                            .id(index + 1)
                    }
                }
                .padding(.vertical, PhrenTheme.Space.small).padding(.trailing, 14)
            }
            .tint(PhrenTheme.accent)
            .environment(\.openURL, OpenURLAction(handler: open))
            .onChange(of: scroll) { _, request in
                guard let request else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(request.line, anchor: UnitPoint(x: 0, y: 0.2)) }
            }
            .onAppear { if let scroll { proxy.scrollTo(scroll.line, anchor: UnitPoint(x: 0, y: 0.2)) } }
            .phrenContainerMarker("code-file-source", label: "Source")
        }
    }

    private func state(_ text: String, id: String, warning: Bool = false, viewerAction: Bool = false) -> some View {
        VStack(spacing: PhrenTheme.Space.medium) {
            PhrenFileTypeIcon(path: path)
            Text(text).font(PhrenTypography.subheadline).multilineTextAlignment(.center)
                .foregroundStyle(warning ? PhrenTheme.warning : PhrenTheme.textMuted)
                .accessibilityIdentifier(id)
            if viewerAction, let item = context.viewerItem(path) {
                Button { viewer = item } label: {
                    PhrenRow(icon: "doc.text.magnifyingglass", title: "Open in file viewer", chevron: false)
                }.buttonStyle(.plain).phrenIdentifier("code-file-viewer")
            }
        }
        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Outline and symbols

    private struct OutlineRow { let entry: CodeOutlineEntry; let name: String }
    private var outlineRows: [OutlineRow] {
        func flatten(_ entries: [CodeOutlineEntry], container: String) -> [OutlineRow] {
            entries.flatMap { entry in
                [OutlineRow(entry: entry, name: container.isEmpty ? entry.name : "\(container).\(entry.name)")]
                    + flatten(entry.children, container: entry.name)
            }
        }
        return flatten(outline, container: "")
    }
    private var outlineActions: [PhrenControlAction] {
        outlineRows.map { row in
            PhrenControlAction(id: "\(row.entry.line):\(row.name)", title: row.name, icon: Self.icon(row.entry.kind),
                               caption: "\(row.entry.kind) · line \(row.entry.line)",
                               accessibilityIdentifier: "code-outline:\(row.entry.line):\(row.name)") { jump(row.entry.line) }
        }
    }
    private static func icon(_ kind: String) -> String {
        switch kind {
        case "function", "method": return "function"
        case "variable": return "character.cursor.ibeam"
        default: return "cube"
        }
    }

    private func open(_ url: URL) -> OpenURLAction.Result {
        guard url.scheme == "phren-code", url.host == "symbol" else { return .systemAction }
        let parts = url.pathComponents.dropFirst().compactMap { Int($0) }
        guard parts.count == 2, lines.indices.contains(parts[0] - 1) else { return .discarded }
        let found = symbols.occurrences(in: lines[parts[0] - 1], line: parts[0])
        guard found.indices.contains(parts[1]) else { return .discarded }
        dossier = CodeDossierTarget(name: found[parts[1]].target.symbol)
        return .handled
    }

    private func jump(_ line: Int) {
        marked = line
        scroll = ScrollRequest(line: line)
    }

    private func go(_ file: String, _ line: Int) {
        if file == path { jump(line) } else { next = CodeFileLocation(path: file, line: line) }
    }

    // MARK: Loading

    @MainActor private func load() async {
        phase = .loading
        do {
            let data = try await read()
            try Task.checkCancellation()
            guard let data else { return }
            let split = await Task.detached(priority: .userInitiated) { () -> (lines: [String], longest: String)? in
                guard let text = CodeSourceText.decode(data) else { return nil }
                let lines = CodeSourceText.lines(text)
                return (lines, lines.max { $0.count < $1.count } ?? "")
            }.value
            try Task.checkCancellation()
            guard let split else { phase = .binary; return }
            lines = split.lines; longest = split.longest; phase = .loaded
            if let line { await Task.yield(); jump(min(max(1, line), lines.count)) }
        } catch {
            if !Task.isCancelled { phase = .failed(error.localizedDescription) }
        }
    }

    /// The file's bytes, or nil after setting a state that explains why not.
    @MainActor private func read() async throws -> Data? {
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled {
            guard let data = CodeFixture.source(path) else { throw PhrenKitError.validation("This file is not available on this computer.") }
            if data.count > CodeSourceText.maximumBytes { phase = .tooLarge(Int64(data.count)); return nil }
            return data
        }
        if FileViewerFixture.enabled { return try Data(contentsOf: await FileViewerFixture.file(named: name)) }
        #endif
        guard let host = context.host else { throw PhrenKitError.validation("Connect a computer to read this file.") }
        let key = try DeviceSSHKey.load(host.id)
        let file = context.remote(path)
        let first = try await PhrenConnection.fileRange(host: host, privateKey: key, file: file, length: 262_144)
        if first.total > Int64(CodeSourceText.maximumBytes) { phase = .tooLarge(first.total); return nil }
        var data = try first.bytes()
        if !first.eof {
            let rest = try await PhrenConnection.fileRange(host: host, privateKey: key, file: file, offset: Int64(data.count),
                                                           length: Int(first.total) - data.count, version: first.version)
            data.append(try rest.bytes())
        }
        return data
    }

    @MainActor private func loadSymbols() async {
        guard context.indexed else { return }
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled {
            outline = CodeFixture.outline(path)
            symbols = CodeFileSymbols(path: path, outline: outline, references: CodeFixture.fileReferences(path))
            return
        }
        #endif
        guard let host = context.host, let key = try? DeviceSSHKey.load(host.id) else { return }
        let storeID = context.origin?.storeID ?? context.storeId
        async let outlineTask = try? PhrenConnection.codeOutline(host: host, privateKey: key, project: context.project, path: path, storeID: storeID)
        // An older Hook without this route still gets declarations from the outline.
        async let referencesTask = try? PhrenConnection.codeFileReferences(host: host, privateKey: key, project: context.project, path: path, storeID: storeID)
        let (entries, references) = await (outlineTask ?? [], referencesTask ?? [])
        guard !Task.isCancelled else { return }
        outline = entries
        symbols = CodeFileSymbols(path: path, outline: entries, references: references)
    }
}

/// One numbered source line. Its colors come from `CodeHighlighting`, and
/// names the index resolves become `phren-code://symbol/<line>/<n>` links.
private struct CodeSourceLine: View {
    let number: Int
    let text: String
    let language: SyntaxTokenizer.Language
    let links: [NSRange]
    let marked: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(PhrenTypography.monoCaption2).foregroundStyle(marked ? PhrenTheme.accent : PhrenTheme.textDim)
                .frame(width: 40, alignment: .trailing)
            Text(attributed).font(PhrenTypography.monoFootnote).fixedSize(horizontal: true, vertical: false)
        }
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(marked ? PhrenTheme.accent.opacity(0.14) : .clear)
    }

    private var attributed: AttributedString {
        var value = CodeHighlighting.highlighted(text.isEmpty ? " " : text, language: language)
        for (index, link) in links.enumerated() {
            guard let range = Range(link, in: value), let url = URL(string: "phren-code://symbol/\(number)/\(index)") else { continue }
            value[range].link = url
            value[range].underlineStyle = Text.LineStyle(pattern: .dot, color: PhrenTheme.accent)
        }
        return value
    }
}
