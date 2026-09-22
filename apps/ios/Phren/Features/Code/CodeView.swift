import PhrenKit
import PhrenLive
import SwiftUI

/// A project's indexed files, symbol search, complete usage ranking and recent index observations.
struct CodeView: View {
    let storeId: String
    let project: String
    var origin: SessionCodeContext? = nil

    private enum Mode: String, CaseIterable { case files = "Files", usage = "Usage", recent = "Recent" }
    private struct Request: Hashable {
        let mode: Mode
        let query: String
        let directory: String
        let file: String
        let kind: String
        let usageFile: String
        let offset: Int
        let end: Bool
        let revision: Int
    }
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var mode = Mode.files
    @State private var query = ""
    @State private var directory = ""
    @State private var file = ""
    @State private var kind = ""
    @State private var usageFile = ""
    @State private var offset = 0
    @State private var end = false
    @State private var revision = 0
    @State private var status: CodeStatus?
    @State private var tree: [CodeTreeEntry] = []
    @State private var symbols: [CodeSymbol] = []
    @State private var outline: [CodeOutlineEntry] = []
    @State private var usage: CodeUsagePage?
    @State private var recent: [CodeRecentSymbol] = []
    @State private var selected: CodeDossierTarget?
    @State private var loading = false
    @State private var reindexing = false
    @State private var errorText: String?
    @State private var showKinds = false
    @State private var showFiles = false
    @State private var pickerDirectory = ""
    @State private var pickerEntries: [CodeTreeEntry] = []
    @State private var pickerLoading = false
    @State private var pickerError: String?
    @State private var scrollTarget: Int?
    @FocusState private var searchFocused: Bool

    private var hosts: [LiveHost] {
        if let origin { return [origin.host] }
        return ((try? LiveSessionPreferences.read(hostData))?.hosts ?? []).filter { SessionOverviewMonitor.shared.allows(.code, on: $0) }
    }
    private var request: Request {
        Request(mode: mode, query: query.trimmingCharacters(in: .whitespacesAndNewlines), directory: directory,
                file: file, kind: kind, usageFile: usageFile, offset: offset, end: end, revision: revision)
    }
    private var kinds: [PhrenOption<String>] {
        [("", "All kinds"), ("function", "Function"), ("method", "Method"), ("types", "Type"), ("variable", "Variable")]
            .map { PhrenOption(id: $0.0.isEmpty ? "all" : $0.0, value: $0.0, title: $0.1) }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                    indexHeader
                    PhrenSearchField(text: $query, placeholder: directory.isEmpty ? "Search symbols" : "Search in \(directory)",
                                     identifier: "code-search", focus: $searchFocused)
                    PhrenTextSegment(items: Mode.allCases.map { PhrenOption(id: $0.rawValue.lowercased(), value: $0, title: $0.rawValue) },
                                     selection: $mode, identifier: "code-mode")
                    scope
                    if !request.query.isEmpty || mode == .usage { filters }
                    if let errorText {
                        Text(errorText).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.warning)
                            .accessibilityIdentifier("code-error")
                        action("Retry", id: "code-retry") { revision += 1 }
                    }
                    if loading {
                        Text("Loading index…").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
                            .accessibilityIdentifier("code-loading")
                    } else if !request.query.isEmpty {
                        PhrenSectionHeader(title: "Symbols", count: symbols.count)
                        if symbols.isEmpty { empty("No symbols match “\(request.query)”") }
                        ForEach(symbols) { symbolRow($0) }
                    } else {
                        switch mode {
                        case .files: filesContent
                        case .usage: usageContent
                        case .recent: recentContent
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.top, PhrenTheme.Space.small).padding(.bottom, PhrenTheme.Space.section)
            }
            .onChange(of: scrollTarget) { _, target in
                if let target { proxy.scrollTo(target, anchor: end ? .bottom : .top) }
            }
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Code")
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityIdentifier("code-screen")
        }
        .phrenSingleSelectSheet(isPresented: $showKinds, title: "Symbol kind", options: kinds, selection: $kind, rowPrefix: "code-kind")
        .phrenActionSheet(isPresented: $showFiles, title: pickerDirectory.isEmpty ? "Usage by file" : pickerDirectory,
                          actions: fileActions, identifier: "code-file-picker")
        .sheet(item: $selected) { target in
            CodeSymbolDossier(storeId: storeId, project: project, symbol: target.name, hosts: hosts, origin: origin)
                .presentationDetents([.large])
        }
        .task { await loadStatus() }
        .task(id: request) { await load(request) }
        .task(id: "\(showFiles):\(pickerDirectory)") { if showFiles { await loadPicker() } }
        .onChange(of: kind) { _, _ in resetUsage() }
        .onChange(of: usageFile) { _, _ in resetUsage() }
        .onChange(of: mode) { _, _ in searchFocused = false }
    }

    private var indexHeader: some View {
        HStack(alignment: .top, spacing: PhrenTheme.Space.small) {
            VStack(alignment: .leading, spacing: 4) {
                Text(project).font(PhrenTheme.Font.body.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                if let status {
                    Text("\(status.files) files · \(status.symbols) symbols").accessibilityIdentifier("code-index-counts")
                    Text(status.languages.map { "\($0.language) (\($0.files))" }.joined(separator: " · "))
                        .accessibilityIdentifier("code-languages")
                    if let at = status.lastIndexedAt {
                        Text("Indexed \(Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .shortened))")
                            .accessibilityIdentifier("code-indexed-at")
                    }
                }
            }.font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
            Spacer(minLength: 0)
            action(reindexing ? "Indexing…" : "Reindex", id: "code-reindex") { Task { await reindex() } }
                .disabled(reindexing)
        }.padding(12).sessionCard()
    }

    private var scope: some View {
        HStack {
            Text(directory.isEmpty ? "Entire codebase" : directory)
                .font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textSecondary)
                .accessibilityIdentifier("code-directory")
            Spacer(minLength: 0)
            if !directory.isEmpty || !file.isEmpty {
                action("Up", id: "code-up") {
                    if !file.isEmpty { file = "" }
                    else { directory = parent(directory); usageFile = ""; resetUsage() }
                }
                action("Root", id: "code-root") { directory = ""; file = ""; usageFile = ""; resetUsage() }
            }
        }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            PhrenSingleSelect(options: kinds, selection: $kind, placeholder: "All kinds", identifier: "code-kind-filter", isPresented: $showKinds)
            if mode == .usage && request.query.isEmpty {
                action(usageFile.isEmpty ? "All files · Choose file" : usageFile, id: "code-file-filter") {
                    pickerDirectory = directory; pickerEntries = []; pickerError = nil; showFiles = true
                }
                if !usageFile.isEmpty { action("Clear file filter", id: "code-file-clear") { usageFile = "" } }
            }
        }
    }

    @ViewBuilder private var filesContent: some View {
        if file.isEmpty {
            PhrenSectionHeader(title: "Indexed files", count: tree.count)
            if tree.isEmpty { empty("No indexed files in this directory.") }
            ForEach(tree) { entry in
                Button {
                    if entry.directory { directory = entry.path; usageFile = ""; resetUsage() }
                    else { file = entry.path }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: entry.directory ? "folder" : "doc.text").foregroundStyle(PhrenTheme.accent).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.name).font(PhrenTheme.Font.body.weight(.medium)).foregroundStyle(PhrenTheme.text)
                            Text(entry.languages.joined(separator: " · ")).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
                        }
                        Spacer(minLength: 0)
                        VStack(alignment: .trailing, spacing: 4) {
                            Text("\(entry.symbols) symbols")
                            if entry.directory { Text("\(entry.files) files") }
                        }.font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textSecondary)
                    }.padding(12).frame(minHeight: 44).contentShape(Rectangle()).sessionCard()
                }.buttonStyle(.plain).accessibilityIdentifier("code-tree:\(entry.path)")
            }
        } else {
            Text(file).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textSecondary)
            action("Usage in this file", id: "code-file-usage") { usageFile = file; mode = .usage; resetUsage() }
            if outline.isEmpty { empty("No symbols indexed in this file.") }
            ForEach(flatten(outline)) { row in
                Button { selected = CodeDossierTarget(name: "\(file)::\(row.name)") } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.name).font(PhrenTheme.Font.body.weight(.medium)).foregroundStyle(PhrenTheme.text)
                            Text("\(row.entry.kind) · line \(row.entry.line)").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
                        }
                        Spacer(minLength: 0)
                        CodeUsageIndicator(uses: row.entry.uses)
                    }.padding(12).frame(minHeight: 44).contentShape(Rectangle()).sessionCard()
                }.buttonStyle(.plain).accessibilityIdentifier("code-file-symbol:\(row.entry.line):\(row.entry.name)")
            }
        }
    }

    @ViewBuilder private var usageContent: some View {
        HStack {
            PhrenSectionHeader(title: "Usage", count: usage?.total ?? 0)
            action("Hot", id: "code-hot") { jump(toEnd: false) }
            action("Cold", id: "code-cold") { jump(toEnd: true) }
        }
        if let usage {
            if usage.entries.isEmpty { empty("No symbols in this scope.") }
            else {
                Text("Ranks \(usage.offset + 1)–\(usage.offset + usage.entries.count) of \(usage.total) · references")
                    .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).accessibilityIdentifier("code-usage-range")
                if usage.hasPrevious {
                    action("Previous ranks", id: "code-usage-previous") { end = false; offset = max(0, usage.offset - usage.limit) }
                }
                ForEach(Array(usage.entries.enumerated()), id: \.element.id) { index, symbol in
                    symbolRow(symbol, rank: usage.offset + index + 1, maximum: usage.maxUses).id(symbol.id)
                }
                if usage.hasNext {
                    action("Next ranks", id: "code-usage-next") { end = false; offset = usage.offset + usage.entries.count }
                }
            }
        }
    }

    private var recentContent: some View {
        Group {
            PhrenSectionHeader(title: "Recent symbols", count: recent.count)
            Text("Symbols the index most recently saw change.")
                .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
            if recent.isEmpty { empty("No recently indexed symbols.") }
            ForEach(recent) { entry in
                symbolRow(entry.symbol, detail: "Change indexed \(Date(timeIntervalSince1970: entry.indexedAt / 1000).formatted(date: .abbreviated, time: .shortened))")
            }
        }
    }

    private func symbolRow(_ symbol: CodeSymbol, rank: Int? = nil, maximum: Int? = nil, detail: String? = nil) -> some View {
        Button { searchFocused = false; selected = CodeDossierTarget(name: symbol.qualifiedName) } label: {
            HStack(spacing: 10) {
                if let rank { Text("\(rank)").font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted) }
                VStack(alignment: .leading, spacing: 4) {
                    Text(symbol.name).font(PhrenTheme.Font.body.weight(.medium)).foregroundStyle(PhrenTheme.text)
                    Text("\(symbol.kind) · \(symbol.location)").font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted)
                    if let detail { Text(detail).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted) }
                }
                Spacer(minLength: 0)
                CodeUsageIndicator(uses: symbol.uses, maximum: maximum)
            }.padding(12).frame(minHeight: 44).contentShape(Rectangle()).sessionCard()
        }.buttonStyle(.plain)
            .accessibilityLabel("\(rank.map { "Rank \($0), " } ?? "")\(symbol.name), \(symbol.kind), \(symbol.file), \(symbol.uses) references")
            .accessibilityIdentifier("code-row:\(symbol.id)")
    }

    private func action(_ title: String, id: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Text(title).font(PhrenTheme.Font.caption.weight(.semibold)).foregroundStyle(PhrenTheme.accent)
                .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44)
                .background(PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small))
        }.buttonStyle(.plain).accessibilityIdentifier(id)
    }
    private func empty(_ text: String) -> some View {
        Text(text).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).accessibilityIdentifier("code-empty")
    }
    private func parent(_ path: String) -> String { path.split(separator: "/").dropLast().joined(separator: "/") }
    private func resetUsage() { offset = 0; end = false; scrollTarget = nil }
    private func jump(toEnd: Bool) { scrollTarget = nil; end = toEnd; offset = 0; revision += 1 }

    private struct OutlineRow: Identifiable {
        let entry: CodeOutlineEntry
        let name: String
        var id: String { "\(entry.line):\(name)" }
    }
    private func flatten(_ entries: [CodeOutlineEntry], container: String = "") -> [OutlineRow] {
        entries.flatMap { entry in
            let name = container.isEmpty ? entry.name : "\(container).\(entry.name)"
            return [OutlineRow(entry: entry, name: name)] + flatten(entry.children, container: entry.name)
        }
    }

    private var fileActions: [PhrenActionSheet.Action] {
        var actions: [PhrenActionSheet.Action] = [
            .init(id: "all", title: "All files", handler: { usageFile = "" })
        ]
        if !pickerDirectory.isEmpty {
            actions.append(.init(id: "up", title: "Up", icon: "folder", dismisses: false, handler: { pickerDirectory = parent(pickerDirectory) }))
        }
        if pickerLoading { actions.append(.init(id: "loading", title: "Loading files…", isEnabled: false, handler: {})) }
        else if let pickerError {
            actions.append(.init(id: "retry", title: "Retry", caption: pickerError, dismisses: false, handler: { Task { await loadPicker() } }))
        } else {
            actions += pickerEntries.map { entry in
                .init(id: entry.path, title: entry.name, icon: entry.directory ? "folder" : "doc.text",
                      caption: "\(entry.symbols) symbols", dismisses: !entry.directory, handler: {
                    if entry.directory { pickerDirectory = entry.path }
                    else { usageFile = entry.path; directory = parent(entry.path); file = "" }
                })
            }
        }
        return actions
    }

    @MainActor private func loadStatus() async {
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled { status = CodeFixture.status; return }
        #endif
        guard let host = hosts.first else { errorText = "Connect a computer with the code index enabled."; return }
        do { status = try await PhrenConnection.codeStatus(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, storeID: storeId) }
        catch { errorText = error.localizedDescription }
    }

    @MainActor private func load(_ requested: Request) async {
        loading = true; errorText = nil; scrollTarget = nil
        tree = []; outline = []; symbols = []; usage = nil; recent = []
        defer { if requested == request { loading = false } }
        do {
            if !requested.query.isEmpty { try await Task.sleep(for: .milliseconds(250)) }
            try Task.checkCancellation()
            #if DEBUG && targetEnvironment(simulator)
            if CodeFixture.enabled {
                tree = CodeFixture.tree(requested.directory)
                outline = CodeFixture.outline(requested.file)
                symbols = CodeFixture.search(requested.query).filter { matches($0, requested) }
                usage = CodeFixture.page(kind: requested.kind, file: requested.usageFile, directory: requested.directory, offset: requested.offset, end: requested.end)
                recent = CodeFixture.symbols.filter { requested.directory.isEmpty || $0.file.hasPrefix(requested.directory + "/") }
                    .reversed().map { CodeRecentSymbol(symbol: $0, indexedAt: CodeFixture.status.lastIndexedAt ?? 0) }
                if requested.mode == .usage { scrollTarget = requested.end ? usage?.entries.last?.id : usage?.entries.first?.id }
                return
            }
            #endif
            guard let host = hosts.first else { throw PhrenKitError.validation("Connect a computer with the code index enabled.") }
            let key = try DeviceSSHKey.load(host.id)
            if !requested.query.isEmpty {
                let result = try await PhrenConnection.codeSearch(host: host, privateKey: key, project: project, query: requested.query,
                    kind: requested.kind.isEmpty ? nil : requested.kind, limit: 100, directory: requested.directory, storeID: storeId)
                try Task.checkCancellation(); symbols = result
            } else {
                switch requested.mode {
                case .files:
                    if requested.file.isEmpty {
                        let result = try await PhrenConnection.codeTree(host: host, privateKey: key, project: project, directory: requested.directory, storeID: storeId)
                        try Task.checkCancellation(); tree = result
                    } else {
                        let result = try await PhrenConnection.codeOutline(host: host, privateKey: key, project: project, path: requested.file, storeID: storeId)
                        try Task.checkCancellation(); outline = result
                    }
                case .usage:
                    let result = try await PhrenConnection.codeUsagePage(host: host, privateKey: key, project: project, kind: requested.kind,
                        file: requested.usageFile, directory: requested.directory, offset: requested.offset, end: requested.end, storeID: storeId)
                    try Task.checkCancellation(); usage = result
                    scrollTarget = requested.end ? result.entries.last?.id : result.entries.first?.id
                case .recent:
                    let result = try await PhrenConnection.codeRecent(host: host, privateKey: key, project: project, directory: requested.directory, storeID: storeId)
                    try Task.checkCancellation(); recent = result
                }
            }
        } catch {
            if !Task.isCancelled, requested == request { errorText = error.localizedDescription }
        }
    }

    private func matches(_ symbol: CodeSymbol, _ requested: Request) -> Bool {
        (requested.directory.isEmpty || symbol.file.hasPrefix(requested.directory + "/")) &&
        (requested.kind.isEmpty || symbol.kind == requested.kind || (requested.kind == "types" && ["class", "struct", "enum", "interface", "type"].contains(symbol.kind)))
    }

    @MainActor private func loadPicker() async {
        pickerLoading = true; pickerError = nil
        defer { if !Task.isCancelled { pickerLoading = false } }
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled { pickerEntries = CodeFixture.tree(pickerDirectory); return }
        #endif
        guard let host = hosts.first else { return }
        do {
            let result = try await PhrenConnection.codeTree(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, directory: pickerDirectory, storeID: storeId)
            try Task.checkCancellation(); pickerEntries = result
        } catch { if !Task.isCancelled { pickerEntries = []; pickerError = error.localizedDescription } }
    }

    @MainActor private func reindex() async {
        reindexing = true
        defer { reindexing = false }
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled { status = CodeFixture.status; revision += 1; return }
        #endif
        guard let host = hosts.first else { errorText = "Connect a computer to reindex."; return }
        do {
            status = try await PhrenConnection.codeReindex(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, storeID: storeId)
            revision += 1
        } catch { errorText = error.localizedDescription }
    }
}

struct CodeDossierTarget: Identifiable, Hashable {
    let name: String
    var id: String { name }
}

struct CodeUsageIndicator: View {
    let uses: Int
    var maximum: Int? = nil
    private var width: CGFloat {
        guard uses > 0 else { return 0 }
        if let maximum { return max(2, 36 * CGFloat(uses) / CGFloat(max(1, maximum))) }
        return max(2, min(36, CGFloat(log2(Double(uses) + 1)) * 6))
    }
    var body: some View {
        VStack(alignment: .trailing, spacing: PhrenTheme.Space.xs) {
            Text("\(uses)").font(PhrenTheme.Font.caption.weight(.semibold).monospacedDigit()).foregroundStyle(PhrenTheme.textSecondary)
            ZStack(alignment: .leading) {
                Capsule().fill(PhrenTheme.surfaceRaised)
                Capsule().fill(PhrenTheme.accent).frame(width: width)
            }.frame(width: 36, height: 3).accessibilityHidden(true)
        }.accessibilityLabel("\(uses) uses")
    }
}
