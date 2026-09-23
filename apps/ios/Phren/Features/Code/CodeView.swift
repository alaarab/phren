import PhrenKit
import PhrenLive
import SwiftUI

/// A project's code browser: every file in the checkout, opened in the code
/// viewer, with symbol search, the complete usage ranking and recent index
/// observations when the computer has a code index.
struct CodeView: View {
    let storeId: String
    let project: String
    var origin: SessionCodeContext? = nil
    /// A computer chosen from its own page; the project page lets the index pick.
    var host: LiveHost? = nil
    /// The checkout folder that computer located for the project.
    var checkout: String? = nil

    private enum Mode: String, CaseIterable { case files = "Files", usage = "Usage", recent = "Recent" }
    private struct Request: Hashable {
        let mode: Mode
        let query: String
        let directory: String
        let kind: String
        let usageFile: String
        let offset: Int
        let end: Bool
        let revision: Int
    }
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @State private var mode = Mode.files
    @State private var query = ""
    @State private var directory = ""
    @State private var kind = ""
    @State private var usageFile = ""
    @State private var offset = 0
    @State private var end = false
    @State private var revision = 0
    @State private var status: CodeStatus?
    @State private var statusError: String?
    @State private var entries: [CodeBrowserEntry] = []
    @State private var truncated = false
    @State private var symbols: [CodeSymbol] = []
    @State private var usage: CodeUsagePage?
    @State private var recent: [CodeRecentSymbol] = []
    @State private var selected: CodeDossierTarget?
    @State private var loading = false
    @State private var reindexing = false
    /// The computer answered that this project has no code index yet.
    @State private var indexOff = false
    @State private var turnOnError: String?
    @State private var showMore = false
    @State private var confirmingOff = false
    @State private var errorText: String?
    @State private var showKinds = false
    @State private var showFiles = false
    @State private var pickerDirectory = ""
    @State private var pickerEntries: [CodeTreeEntry] = []
    @State private var pickerLoading = false
    @State private var pickerError: String?
    @State private var scrollTarget: Int?
    @State private var openedFile: CodeFileLocation?
    @State private var viewer: FileViewerItem?
    @FocusState private var searchFocused: Bool

    private var hosts: [LiveHost] {
        if let origin { return [origin.host] }
        if let host { return [host] }
        return (preferencesStore.preferences?.hosts ?? []).filter { SessionOverviewMonitor.shared.allows(.code, on: $0) }
    }
    /// Whether the computer serves the code index; without it the browser
    /// still lists and opens every file.
    private var indexed: Bool {
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled { return true }
        #endif
        if origin != nil { return true }
        if let host { return SessionOverviewMonitor.shared.allows(.code, on: host) }
        return !hosts.isEmpty
    }
    private var context: CodeBrowserContext {
        CodeBrowserContext(storeId: storeId, project: project, host: hosts.first, checkout: checkout, origin: origin, indexed: indexed)
    }
    private var request: Request {
        Request(mode: indexed ? mode : .files, query: indexed ? query.trimmingCharacters(in: .whitespacesAndNewlines) : "", directory: directory,
                kind: kind, usageFile: usageFile, offset: offset, end: end, revision: revision)
    }
    private var kinds: [PhrenOption<String>] {
        [("", "All kinds"), ("function", "Function"), ("method", "Method"), ("types", "Type"), ("variable", "Variable")]
            .map { PhrenOption(id: $0.0.isEmpty ? "all" : $0.0, value: $0.0, title: $0.1) }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                    if indexed && indexOff {
                        offCard
                    } else if indexed {
                        statsLine
                        PhrenSearchField(text: $query, placeholder: directory.isEmpty ? "Search symbols" : "Search in \(directory)",
                                         identifier: "code-search", focus: $searchFocused)
                        PhrenTextSegment(items: Mode.allCases.map { PhrenOption(id: $0.rawValue.lowercased(), value: $0, title: $0.rawValue) },
                                         selection: $mode, identifier: "code-mode")
                    }
                    if !directory.isEmpty { scope }
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
                        switch request.mode {
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
        .navigationTitle(project)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityIdentifier("code-screen")
        }
        .toolbar {
            if indexed && !indexOff && status != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showMore = true } label: {
                        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(PhrenTheme.text)
                    .accessibilityLabel("Code options").accessibilityIdentifier("code-more")
                }
            }
        }
        .phrenActionSheet(isPresented: $showMore, title: "Code intelligence", actions: [
            .init(id: "rebuild", title: reindexing ? "Rebuilding…" : "Rebuild index", icon: "arrow.clockwise",
                  caption: "Phren keeps it up to date as files change; rebuild only if something looks stale.",
                  isEnabled: !reindexing, handler: { Task { await reindex() } }),
            .init(id: "turn-off", title: "Turn off", icon: "power", role: .destructive, handler: { confirmingOff = true }),
        ], identifier: "code-more-sheet")
        .phrenDialog(isPresented: $confirmingOff, title: "Turn off code intelligence?",
                     message: "Phren stops keeping \(project)'s symbol index and deletes it. Files stay browsable, and you can turn it on again.",
                     actions: [
                        .init(id: "off", title: "Turn off", role: .destructive, accessibilityIdentifier: "code-turn-off-confirm") { Task { await turnOff() } },
                        .init(id: "cancel", title: "Cancel", role: .cancel) {},
                     ], identifier: "code-turn-off-dialog")
        .phrenSingleSelectSheet(isPresented: $showKinds, title: "Symbol kind", options: kinds, selection: $kind, rowPrefix: "code-kind")
        .phrenActionSheet(isPresented: $showFiles, title: pickerDirectory.isEmpty ? "Usage by file" : pickerDirectory,
                          actions: fileActions, identifier: "code-file-picker")
        .sheet(item: $selected) { target in
            CodeSymbolDossier(storeId: storeId, project: project, symbol: target.name, hosts: hosts, origin: origin) { file, line in
                selected = nil
                openedFile = CodeFileLocation(path: file, line: line)
            }
            .presentationDetents([.large])
        }
        .navigationDestination(item: $openedFile) { CodeFileView(context: context, path: $0.path, line: $0.line) }
        .fullScreenCover(item: $viewer) { FileViewer(item: $0) }
        .task { if indexed { await loadStatus() } }
        .task(id: request) { await load(request) }
        .task(id: "\(showFiles):\(pickerDirectory)") { if showFiles { await loadPicker() } }
        .onChange(of: kind) { _, _ in resetUsage() }
        .onChange(of: usageFile) { _, _ in resetUsage() }
        .onChange(of: mode) { _, _ in searchFocused = false }
    }

    /// One quiet line under the title: what the index holds and how fresh it is.
    @ViewBuilder private var statsLine: some View {
        if let statusError {
            Text(statusError).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.warning)
                .accessibilityIdentifier("code-status-error")
        } else if let status {
            HStack(spacing: 0) {
                Text("\(status.files.formatted()) files · \(status.symbols.formatted()) symbols")
                    .accessibilityIdentifier("code-index-counts")
                if let at = status.lastIndexedAt {
                    Text(" · updated \(Date(timeIntervalSince1970: at / 1000).formatted(.relative(presentation: .named)))")
                        .accessibilityIdentifier("code-indexed-at")
                }
                if reindexing { Text(" · rebuilding…") }
            }
            .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
        }
    }

    /// The project has no index on this computer: offer to turn code
    /// intelligence on, as an editor would. The Hook then keeps it current.
    private var offCard: some View {
        VStack(spacing: PhrenTheme.Space.small) {
            Image(systemName: "curlybraces").font(.system(size: 26, weight: .medium)).foregroundStyle(PhrenTheme.accent)
                .accessibilityHidden(true)
            Text("Code intelligence is off").font(PhrenTheme.Font.body.weight(.semibold)).foregroundStyle(PhrenTheme.text)
            Text("Turn it on to search symbols, jump to definitions and see usage. Phren keeps it up to date as files change.")
                .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).multilineTextAlignment(.center)
            if let turnOnError {
                Text(turnOnError).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.warning)
                    .multilineTextAlignment(.center).accessibilityIdentifier("code-turn-on-error")
            }
            Button { Task { await turnOn() } } label: {
                HStack(spacing: 8) {
                    if reindexing { ProgressView().tint(PhrenTheme.onAccent) }
                    Text(reindexing ? "Turning on…" : "Turn on").font(PhrenTheme.Font.subheadline.weight(.semibold))
                }
                .foregroundStyle(PhrenTheme.onAccent)
                .padding(.horizontal, 20).frame(minHeight: 44)
                .background(PhrenTheme.accent, in: Capsule())
            }
            .buttonStyle(.plain).disabled(reindexing)
            .accessibilityIdentifier("code-turn-on")
        }
        .frame(maxWidth: .infinity).padding(PhrenTheme.Space.medium).sessionCard()
        .accessibilityElement(children: .contain).accessibilityIdentifier("code-off")
    }

    private var scope: some View {
        HStack {
            Text(directory.isEmpty ? "Entire codebase" : directory)
                .font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textSecondary)
                .accessibilityIdentifier("code-directory")
            Spacer(minLength: 0)
            if !directory.isEmpty {
                action("Up", id: "code-up") { directory = parent(directory); usageFile = ""; resetUsage() }
                action("Root", id: "code-root") { directory = ""; usageFile = ""; resetUsage() }
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
        if entries.isEmpty { empty("This folder is empty.") }
        ForEach(entries) { entry in
            Button { open(entry) } label: {
                HStack(spacing: 10) {
                    if entry.directory {
                        Image(systemName: "folder").foregroundStyle(PhrenTheme.accent).frame(width: 22).accessibilityHidden(true)
                    } else {
                        PhrenFileTypeIcon(path: entry.path).frame(width: 22).accessibilityHidden(true)
                    }
                    Text(entry.name).font(PhrenTheme.Font.body.weight(.medium)).foregroundStyle(PhrenTheme.text)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    if let symbols = entry.symbols, symbols > 0 {
                        Text("\(symbols)").font(PhrenTheme.Font.caption.monospacedDigit()).foregroundStyle(PhrenTheme.textSecondary)
                            .accessibilityLabel("\(symbols) symbols")
                    }
                    if entry.directory {
                        Image(systemName: "chevron.right").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textDim).accessibilityHidden(true)
                    }
                }.padding(.horizontal, 12).frame(minHeight: 44).contentShape(Rectangle()).sessionCard()
            }.buttonStyle(.plain).accessibilityIdentifier("code-tree:\(entry.path)")
        }
        if truncated { empty("Showing the first 500 entries.") }
    }

    private func open(_ entry: CodeBrowserEntry) {
        if entry.directory { directory = entry.path; usageFile = ""; resetUsage(); return }
        if CodeBrowserContext.opensAsSource(entry.path) { openedFile = CodeFileLocation(path: entry.path) }
        else { viewer = context.viewerItem(entry.path) }
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
            if recent.isEmpty { empty("No recently indexed symbols.") }
            ForEach(recent) { entry in
                symbolRow(entry.symbol, detail: "Change indexed \(Date(timeIntervalSince1970: entry.indexedAt / 1000).formatted(date: .abbreviated, time: .shortened))",
                          opensFile: true)
            }
        }
    }

    private func symbolRow(_ symbol: CodeSymbol, rank: Int? = nil, maximum: Int? = nil, detail: String? = nil, opensFile: Bool = false) -> some View {
        Button {
            searchFocused = false
            if opensFile { openedFile = CodeFileLocation(path: symbol.file, line: symbol.line) }
            else { selected = CodeDossierTarget(name: symbol.qualifiedName) }
        } label: {
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
                    else { usageFile = entry.path; directory = parent(entry.path) }
                })
            }
        }
        return actions
    }

    @MainActor private func loadStatus() async {
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled {
            if ProcessInfo.processInfo.arguments.contains("--code-index-off") && status == nil { indexOff = true }
            else { status = CodeFixture.status }
            return
        }
        #endif
        guard let host = hosts.first else { statusError = "Connect a computer with the code index enabled."; return }
        do {
            status = try await PhrenConnection.codeStatus(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, storeID: storeId)
            statusError = nil; indexOff = false
        } catch {
            // The Hook answers a project without an index with "No code index
            // for …"; that is the off state, not an error to show.
            let message = error.localizedDescription
            if message.contains("No code index") { indexOff = true; statusError = nil }
            else { statusError = message }
        }
    }

    @MainActor private func load(_ requested: Request) async {
        loading = true; errorText = nil; scrollTarget = nil
        entries = []; truncated = false; symbols = []; usage = nil; recent = []
        defer { if requested == request { loading = false } }
        do {
            if !requested.query.isEmpty { try await Task.sleep(for: .milliseconds(250)) }
            try Task.checkCancellation()
            #if DEBUG && targetEnvironment(simulator)
            if CodeFixture.enabled {
                entries = CodeBrowserEntry.merge(CodeFixture.listing(requested.directory), counts: CodeFixture.tree(requested.directory))
                symbols = CodeFixture.search(requested.query).filter { matches($0, requested) }
                usage = CodeFixture.page(kind: requested.kind, file: requested.usageFile, directory: requested.directory, offset: requested.offset, end: requested.end)
                recent = CodeFixture.symbols.filter { requested.directory.isEmpty || $0.file.hasPrefix(requested.directory + "/") }
                    .reversed().map { CodeRecentSymbol(symbol: $0, indexedAt: CodeFixture.status.lastIndexedAt ?? 0) }
                if requested.mode == .usage { scrollTarget = requested.end ? usage?.entries.last?.id : usage?.entries.first?.id }
                return
            }
            #endif
            guard let host = hosts.first else { throw PhrenKitError.validation("Connect a computer to browse this project.") }
            let key = try DeviceSSHKey.load(host.id)
            if !requested.query.isEmpty {
                let result = try await PhrenConnection.codeSearch(host: host, privateKey: key, project: project, query: requested.query,
                    kind: requested.kind.isEmpty ? nil : requested.kind, limit: 100, directory: requested.directory, storeID: storeId)
                try Task.checkCancellation(); symbols = result
            } else {
                switch requested.mode {
                case .files:
                    // Every file from the checkout; the index adds symbol counts
                    // and still lists its own files if the checkout is not found.
                    let indexed = indexed
                    async let counts: [CodeTreeEntry]? = indexed ? (try? await PhrenConnection.codeTree(host: host, privateKey: key, project: project, directory: requested.directory, storeID: storeId)) : nil
                    do {
                        let listing = try await PhrenConnection.repositoryFiles(host: host, privateKey: key, project: project, directory: checkout ?? "", path: requested.directory)
                        let tree = await counts
                        try Task.checkCancellation()
                        entries = CodeBrowserEntry.merge((listing.entries ?? []).map { CodeBrowserEntry(path: $0.path, directory: $0.kind == "directory") }, counts: tree ?? [])
                        truncated = listing.truncated == true
                    } catch {
                        guard let tree = await counts, !Task.isCancelled else { throw error }
                        entries = CodeBrowserEntry.merge(tree.map { CodeBrowserEntry(path: $0.path, directory: $0.directory) }, counts: tree)
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

    @MainActor private func turnOff() async {
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled { status = nil; indexOff = true; revision += 1; return }
        #endif
        guard let host = hosts.first else { errorText = "Connect a computer to change code intelligence."; return }
        do {
            try await PhrenConnection.codeDisable(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, storeID: storeId)
            status = nil; indexOff = true; revision += 1
        } catch { errorText = error.localizedDescription }
    }

    /// Builds the first index. A project with no checkout on this computer
    /// (the store's global memory, say) says so instead.
    @MainActor private func turnOn() async {
        turnOnError = nil
        await reindex()
        if let errorText { turnOnError = errorText; self.errorText = nil; return }
        indexOff = false
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

/// One row of the browser: a checkout entry, with the index's counts when it has them.
struct CodeBrowserEntry: Identifiable, Equatable {
    let path: String
    let directory: Bool
    var symbols: Int? = nil
    var name: String { (path as NSString).lastPathComponent }
    var id: String { path }

    static func merge(_ entries: [CodeBrowserEntry], counts: [CodeTreeEntry]) -> [CodeBrowserEntry] {
        let symbols = Dictionary(counts.map { ($0.path, $0.symbols) }, uniquingKeysWith: { first, _ in first })
        return entries.map { entry in
            var entry = entry
            entry.symbols = symbols[entry.path]
            return entry
        }
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
