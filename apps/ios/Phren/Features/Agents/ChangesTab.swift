import PhrenKit
import PhrenLive
import SwiftUI

struct ChangesTab: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let child: String?

    @Environment(ChangesModel.self) private var changes
    @AppStorage("changes.mode") private var mode = "list"
    @AppStorage("changes.wrap") private var wrap = true

    @State private var diff: AgentRepositoryDiff?
    @State private var actionError: String?
    @State private var diffError: String?
    @State private var busy: String?
    @State private var discardTarget: GitStatus.File?
    @State private var loadTask: Task<Void, Never>?

    init(session: LiveAgentSession, target: AgentChatTarget, child: String?) {
        self.session = session
        self.target = target
        self.child = child
    }

    var body: some View {
        VStack(spacing: 0) {
            if mode == "diff" { diffMode } else { listMode }
        }
        .background(PhrenTheme.bg)
        .confirmationDialog(discardTitle, isPresented: discardPresented, titleVisibility: .visible) {
            if let target = discardTarget {
                Button("Discard", role: .destructive) { discard(target) }
            }
            Button("Cancel", role: .cancel) { discardTarget = nil }
        } message: {
            Text("This cannot be undone.")
        }
        .alert("Could not update changes", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
        .onAppear { reload() }
        .onDisappear { loadTask?.cancel() }
        // The List/Diff toggle lives in the section band above; load the diff
        // the first time Diff is chosen.
        .onChange(of: mode) { _, value in if value == "diff" && diff == nil { reload() } }
    }

    // MARK: - List

    private var listMode: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let status = changes.status {
                    let rows = status.files
                    if rows.isEmpty {
                        emptyState("Working tree is clean", icon: "checkmark.circle")
                    } else {
                        fileSection("Unstaged", rows.filter { !$0.staged })
                        fileSection("Staged", rows.filter { $0.staged })
                    }
                } else if let error = changes.error {
                    emptyState(error, icon: "exclamationmark.triangle")
                } else {
                    ProgressView("Loading changes…")
                        .font(PhrenTheme.Font.footnote).foregroundStyle(PhrenTheme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 40)
                }
            }
            .padding(.bottom, 24)
        }
        .phrenScreen()
        .refreshable { changes.reload(); reload() }
    }

    @ViewBuilder
    private func fileSection(_ title: String, _ rows: [GitStatus.File]) -> some View {
        if !rows.isEmpty {
            PhrenSectionHeader(title: title, count: rows.count)
                .padding(.horizontal, PhrenTheme.Space.medium)
            ForEach(rows) { file in
                ChangesFileRow(file: file, busy: busy != nil,
                              onRevert: { discardTarget = file },
                              onStage: { stage(file) })
                Divider().overlay(PhrenTheme.border)
            }
        }
    }

    // MARK: - Diff

    @ViewBuilder
    private var diffMode: some View {
        if let diff {
            let sections = Self.sections(diff)
            if sections.isEmpty {
                emptyState("No text changes to show", icon: "doc.text.magnifyingglass")
            } else {
                ChangesDiffList(sections: sections, wrap: wrap, busy: busy != nil,
                                statusFor: { path, staged in (changes.status?.files ?? []).first { $0.path == path && $0.staged == staged } },
                                onStage: { path, staged in stage(path: path, staged: staged) },
                                refresh: { changes.reload(); reload() })
            }
        } else if let diffError {
            emptyState(diffError, icon: "exclamationmark.triangle")
        } else {
            ProgressView("Loading diff…")
                .font(PhrenTheme.Font.footnote).foregroundStyle(PhrenTheme.textMuted)
                .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 40)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func emptyState(_ text: String, icon: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(PhrenTheme.Font.title).foregroundStyle(PhrenTheme.textDim)
            Text(text).font(PhrenTheme.Font.subheadline).foregroundStyle(PhrenTheme.textMuted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 48)
    }

    // MARK: - Actions

    private var discardTitle: String {
        "Discard changes to \(discardTarget?.name ?? "this file")?"
    }
    private var discardPresented: Binding<Bool> {
        Binding(get: { discardTarget != nil }, set: { if !$0 { discardTarget = nil } })
    }

    private func stage(_ file: GitStatus.File) {
        stage(path: file.path, staged: file.staged)
    }

    private func stage(path: String, staged: Bool) {
        guard busy == nil else { return }
        busy = path
        Task {
            defer { busy = nil }
            do {
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled {
                    try AgentChatFixture.gitWrite(staged ? "unstage" : "stage", paths: [path])
                    changes.reload(); reload()
                    return
                }
                #endif
                if staged {
                    try await PhrenConnection.gitUnstage(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, paths: [path])
                } else {
                    try await PhrenConnection.gitStage(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, paths: [path])
                }
                changes.reload()
                reload()
            } catch { actionError = error.localizedDescription }
        }
    }

    private func discard(_ file: GitStatus.File) {
        discardTarget = nil
        guard busy == nil else { return }
        busy = file.path
        Task {
            defer { busy = nil }
            do {
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled {
                    try AgentChatFixture.gitWrite("discard", paths: [file.path])
                    changes.reload(); reload()
                    return
                }
                #endif
                try await PhrenConnection.gitDiscard(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, paths: [file.path])
                changes.reload()
                reload()
            } catch { actionError = error.localizedDescription }
        }
    }

    private func reload() {
        loadTask?.cancel()
        loadTask = Task { await loadDiff() }
    }

    @MainActor
    private func loadDiff() async {
        diffError = nil
        do {
            let result: AgentRepositoryDiff
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                result = try AgentChatFixture.gitDiff()
            } else {
                result = try await PhrenConnection.repositoryDiff(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, paths: [], child: child)
            }
            #else
            result = try await PhrenConnection.repositoryDiff(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, paths: [], child: child)
            #endif
            try Task.checkCancellation()
            diff = result
        } catch { if !Task.isCancelled { diffError = error.localizedDescription } }
    }

    private static func sections(_ diff: AgentRepositoryDiff) -> [ChangesDiffSection] {
        diff.files.flatMap { file in
            file.sections.compactMap { section in
                guard let patch = section.patch, !patch.isEmpty else { return nil }
                return ChangesDiffSection(id: section.id, path: file.path, status: file.status,
                                          staged: section.kind == "staged", language: .detect(file.path),
                                          document: DiffDocumentCache.value(for: patch))
            }
        }
    }
}

struct ChangesFileRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let file: GitStatus.File
    var busy = false
    let onRevert: () -> Void
    let onStage: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            ChangesStatusDot(status: file.status)
            VStack(alignment: .leading, spacing: 4) {
                Text(file.path)
                    .font(PhrenTypography.monoFootnote)
                    .foregroundStyle(PhrenTheme.text)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1).truncationMode(.middle)
                if dynamicTypeSize > .large { counts }
            }
            Spacer(minLength: 6)
            if dynamicTypeSize <= .large { counts }
            Button(action: onRevert) {
                Image(systemName: "arrow.uturn.backward")
                    .font(PhrenTheme.Font.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                    .frame(width: 40, height: 40).contentShape(Rectangle().inset(by: -2))
            }
            .buttonStyle(.plain).disabled(busy || file.staged)
            .accessibilityLabel("Revert \(file.name)")
            .accessibilityIdentifier("changes-revert:\(file.path)")
            Button(action: onStage) {
                Image(systemName: file.staged ? "minus" : "plus")
                    .font(PhrenTheme.Font.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.accent)
                    .frame(width: 40, height: 40).contentShape(Rectangle().inset(by: -2))
            }
            .buttonStyle(.plain).disabled(busy)
            .accessibilityLabel(file.staged ? "Unstage \(file.name)" : "Stage \(file.name)")
            .accessibilityIdentifier("changes-stage:\(file.path)")
        }
        .padding(.horizontal, PhrenTheme.Space.medium)
        .frame(minHeight: 40)
        .background(PhrenTheme.bg)
        // An identifier on the row itself would replace the two buttons'
        // own, so the row is marked by a zero-size overlay instead.
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 0, height: 0).accessibilityIdentifier("changes-file:\(file.path)")
        }
    }

    private var counts: some View {
        HStack(spacing: 6) {
            if file.additions > 0 { Text("+\(file.additions)").foregroundStyle(PhrenTheme.success) }
            if file.deletions > 0 { Text("-\(file.deletions)").foregroundStyle(PhrenTheme.danger) }
        }
        .font(PhrenTheme.Font.monoCaption2.weight(.medium)).monospacedDigit()
    }

}

struct ChangesDiffList: View {
    let sections: [ChangesDiffSection]
    let wrap: Bool
    let busy: Bool
    let statusFor: (String, Bool) -> GitStatus.File?
    let onStage: (String, Bool) -> Void
    let refresh: () -> Void

    var body: some View {
        ScrollViewReader { proxy in
            GeometryReader { geometry in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        ForEach(sections) { section in
                            Section {
                                ForEach(items(section.document)) { item in
                                    switch item {
                                    case .fold(let fold):
                                        foldBar(section, fold, proxy: proxy)
                                    case .row(let row, let index):
                                        DiffRowView(row: row, language: section.language,
                                                    runStart: DiffPalette.run(section.document.rows, at: index).start,
                                                    runEnd: DiffPalette.run(section.document.rows, at: index).end,
                                                    wrap: wrap, scrollCode: !wrap, markGutter: index == firstNumberedRow(section.document),
                                                    numberWidth: gutterNumberWidth(section.document),
                                                    widestNumber: section.document.widestNumber)
                                            .id(rowID(section, row))
                                    }
                                }
                            } header: {
                                header(section)
                            }
                        }
                    }
                    .frame(width: geometry.size.width, alignment: .leading)
                    .padding(.bottom, 24)
                }
                .defaultScrollAnchor(.topLeading)
            }
        }
        .phrenScreen()
        .refreshable { refresh() }
        .accessibilityIdentifier("diff-editor")
    }

    private func header(_ section: ChangesDiffSection) -> some View {
        let file = statusFor(section.path, section.staged)
        return HStack(spacing: 8) {
            ChangesStatusDot(status: section.status)
            Text(section.path)
                .font(PhrenTheme.Font.monoSubheadline.weight(.medium))
                .foregroundStyle(PhrenTheme.text).lineLimit(1).truncationMode(.middle)
            Text(section.staged ? "Staged" : "Unstaged")
                .font(PhrenTheme.Font.caption2).foregroundStyle(PhrenTheme.textMuted)
            Spacer(minLength: 6)
            if let file {
                Button { onStage(file.path, file.staged) } label: {
                    Image(systemName: file.staged ? "minus" : "plus")
                        .font(PhrenTheme.Font.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.accent)
                        .frame(width: 40, height: 40).contentShape(Rectangle().inset(by: -2))
                }
                .buttonStyle(.plain).disabled(busy)
                .accessibilityLabel(file.staged ? "Unstage \(file.name)" : "Stage \(file.name)")
                .accessibilityIdentifier("changes-stage:\(file.path)")
            }
        }
        .padding(.horizontal, PhrenTheme.Space.medium)
        .frame(minHeight: 40)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PhrenTheme.surface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("changes-diff-header:\(section.id)")
        .overlay(alignment: .bottom) { Rectangle().fill(PhrenTheme.border).frame(height: 1) }
    }

    @ViewBuilder
    private func foldBar(_ section: ChangesDiffSection, _ fold: DiffDocument.Fold, proxy: ScrollViewProxy) -> some View {
        let rows = section.document.rows
        let up = previousHunkRow(rows, before: fold.beforeRow)
        let down = fold.beforeRow < rows.count ? fold.beforeRow : nil
        DiffFoldBar(count: fold.count,
                    canJumpUp: up != nil, canJumpDown: down != nil,
                    onUp: { if let up { withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(rowID(section, rows[up]), anchor: .top) } } },
                    onDown: { if let down { withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(rowID(section, rows[down]), anchor: .top) } } })
    }

    private func previousHunkRow(_ rows: [DiffDocument.Row], before index: Int) -> Int? {
        guard index > 0 else { return nil }
        return stride(from: index - 1, through: 0, by: -1).first { rows[$0].kind == .hunk }
    }

    private func firstNumberedRow(_ document: DiffDocument) -> Int {
        document.rows.firstIndex { $0.old != nil || $0.new != nil } ?? -1
    }

    /// The gutter tracks the document's widest line number, so a three-digit
    /// number gets a column wide enough for all three digits.
    private func gutterNumberWidth(_ document: DiffDocument) -> CGFloat {
        DiffPalette.numberWidth(forDigits: document.widestNumber.count)
    }

    private func rowID(_ section: ChangesDiffSection, _ row: DiffDocument.Row) -> String {
        "\(section.id):row\(row.id)"
    }

    private enum DiffItem: Identifiable {
        case fold(DiffDocument.Fold)
        case row(DiffDocument.Row, Int)
        var id: String {
            switch self {
            case .fold(let fold): return "fold\(fold.id)"
            case .row(let row, _): return "row\(row.id)"
            }
        }
    }

    private func items(_ document: DiffDocument) -> [DiffItem] {
        let foldsByRow = Dictionary(grouping: document.folds, by: \.beforeRow)
        var result: [DiffItem] = []
        for (index, row) in document.rows.enumerated() {
            for fold in foldsByRow[index] ?? [] { result.append(.fold(fold)) }
            result.append(.row(row, index))
        }
        return result
    }
}

struct ChangesDiffSection: Identifiable {
    let id: String
    let path: String
    let status: String
    let staged: Bool
    let language: SyntaxTokenizer.Language
    let document: DiffDocument
}

struct ChangesStatusDot: View {
    let status: String

    static func color(_ status: String) -> Color {
        switch status.trimmingCharacters(in: .whitespaces) {
        case "D": return PhrenTheme.danger
        case "U": return PhrenTheme.warning
        case "M", "A", "?", "??": return PhrenTheme.success
        case "R", "C": return PhrenTheme.lavender
        default: return PhrenTheme.textMuted
        }
    }

    var body: some View {
        Circle().fill(Self.color(status)).frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}
