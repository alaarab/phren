import PhrenKit
import SwiftUI

/// One changed file, the way VS Code's diff editor shows it: every line of
/// every hunk with old/new numbers in the gutter, row tints for inserted and
/// removed lines, the changed characters tinted harder, next/previous change
/// in the toolbar, and an inline ⇄ side-by-side toggle.
struct FileDiffView: View {
    let file: AgentRepositoryDiff.File
    let section: AgentRepositoryDiff.Section
    @AppStorage("diff.sideBySide.v1") private var sideBySide = false
    @AppStorage(ChatSettings.wrapFullDiffKey) private var wrap = false
    @State private var change = 0
    @State private var focused: Int?

    private let document: DiffDocument?
    init(file: AgentRepositoryDiff.File, section: AgentRepositoryDiff.Section) {
        self.file = file
        self.section = section
        document = section.patch.map { DiffDocumentCache.value(for: $0) }
    }
    private var language: SyntaxTokenizer.Language { .detect(file.path) }
    private var fileName: String { file.path.split(separator: "/").last.map(String.init) ?? file.path }

    var body: some View {
        VStack(spacing: 0) {
            summaryBar
            if section.binary == true {
                notice("Binary file changed", detail: "Git has no text to compare for this file.")
            } else if let document {
                diffBody(document)
            } else {
                notice("No diff from the computer", detail: file.status == "??" ? "Untracked files are listed but not compared. Stage the file to see its lines." : "This change needs the full terminal view.")
            }
        }
        .background(PhrenTheme.bgSunken)
        .confirmsWebLinks()
        .navigationTitle(fileName).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let document, !document.changeStarts.isEmpty {
                    Button("Previous change", systemImage: "chevron.up") { step(-1, in: document) }
                        .disabled(change == 0).accessibilityIdentifier("diff-previous-change")
                    Button("Next change", systemImage: "chevron.down") { step(1, in: document) }
                        .disabled(change >= document.changeStarts.count - 1).accessibilityIdentifier("diff-next-change")
                }
                Menu {
                    Picker("Layout", selection: $sideBySide) {
                        Label("Inline", systemImage: "text.alignleft").tag(false)
                        Label("Side by side", systemImage: "rectangle.split.2x1").tag(true)
                    }
                    Toggle("Wrap long lines", systemImage: "text.word.spacing", isOn: $wrap).accessibilityIdentifier("diff-wrap")
                    if let patch = section.patch {
                        Button("Copy patch", systemImage: "doc.on.doc") { ChatClipboard.copy(patch) }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Diff options").accessibilityIdentifier("diff-options")
            }
        }
    }

    /// The strip VS Code keeps above the editor: path, group, and counts.
    private var summaryBar: some View {
        HStack(spacing: 10) {
            DiffStatusBadge(status: file.status)
            Text(file.path).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textSecondary)
                .lineLimit(1).truncationMode(.head)
            Spacer(minLength: 8)
            if let document {
                DiffCounts(added: document.added, removed: document.removed)
            }
            Text(section.kind == "staged" ? "Staged" : "Unstaged").font(PhrenTheme.Font.caption2).foregroundStyle(PhrenTheme.textMuted)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(PhrenTheme.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(PhrenTheme.border).frame(height: 1) }
    }

    @ViewBuilder
    private func diffBody(_ document: DiffDocument) -> some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView(sideBySide || wrap ? [.vertical] : [.horizontal, .vertical]) {
                    // A lazy stack inside a horizontally scrolling view sizes
                    // itself to the viewport, not to its widest row, so long
                    // lines would be clipped with nowhere to scroll. Rows are
                    // laid out eagerly up to a size where that is still cheap.
                    let rows = sideBySide ? document.split.count : document.rows.count
                    DiffRowStack(lazy: rows > 1_500) {
                        if sideBySide {
                            let column = max(180, (geometry.size.width - 1) / 2)
                            ForEach(Array(document.split.enumerated()), id: \.element.id) { index, row in
                                let rows = document.split
                                let same = { (a: DiffDocument.SplitRow?, b: DiffDocument.SplitRow) in a?.left?.kind == b.left?.kind && a?.right?.kind == b.right?.kind && a?.hunk == nil }
                                DiffSplitRowView(row: row, columnWidth: column, language: language,
                                                 runStart: index == 0 || !same(rows[index - 1], row), runEnd: index == rows.count - 1 || !same(rows[index + 1], row))
                                    .id(row.id)
                                    .overlay(alignment: .leading) { focusMarker(row.left?.change ?? row.right?.change) }
                            }
                        } else {
                            ForEach(Array(document.rows.enumerated()), id: \.element.id) { index, row in
                                let run = DiffPalette.run(document.rows, at: index)
                                DiffRowView(row: row, language: language, runStart: run.start, runEnd: run.end, wrap: wrap, compact: true)
                                    .id(row.id)
                                    .overlay(alignment: .leading) { focusMarker(row.change) }
                            }
                        }
                        if document.truncated {
                            Text("Preview truncated. Copy the patch for all supplied lines.")
                                .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).padding(12)
                        }
                    }
                    .frame(minWidth: geometry.size.width, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(.bottom, 24)
                }
                .defaultScrollAnchor(.topLeading)
                .onChange(of: focused) { _, target in
                    guard let target else { return }
                    withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .top) }
                }
            }
        }
        .accessibilityIdentifier("diff-editor")
    }

    /// The thin bar VS Code draws in the overview ruler for the current change.
    @ViewBuilder
    private func focusMarker(_ block: Int?) -> some View {
        if let block, block == change, focused != nil {
            Rectangle().fill(PhrenTheme.accent).frame(width: 2)
        }
    }

    private func step(_ delta: Int, in document: DiffDocument) {
        let next = min(max(0, change + delta), document.changeStarts.count - 1)
        change = next
        focused = document.rows[document.changeStarts[next]].id
    }

    private func notice(_ title: String, detail: String) -> some View {
        VStack(spacing: 6) {
            Text(title).font(PhrenTheme.Font.subheadline.weight(.medium))
            Text(detail).font(PhrenTheme.Font.footnote).foregroundStyle(PhrenTheme.textMuted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).padding(24)
    }
}

/// VS Code's source-control letter: M, A, D, R, C, U — in its colour.
struct DiffStatusBadge: View {
    let status: String

    static func letter(_ status: String) -> (String, Color, String) {
        let code = status.trimmingCharacters(in: .whitespaces)
        if status == "??" { return ("U", PhrenTheme.success, "Untracked") }
        if code.isEmpty { return ("", PhrenTheme.textMuted, "Committed") }
        switch code.first {
        case "A": return ("A", PhrenTheme.success, "Added")
        case "D": return ("D", PhrenTheme.danger, "Deleted")
        case "R": return ("R", PhrenTheme.lavender, "Renamed")
        case "C": return ("C", PhrenTheme.lavender, "Copied")
        case "M", "T": return ("M", PhrenTheme.warning, "Modified")
        case "!": return ("!", PhrenTheme.textDim, "Ignored")
        default: return (status.isEmpty ? "?" : String(code.prefix(1)), PhrenTheme.textMuted, status.capitalized)
        }
    }

    var body: some View {
        let (letter, color, name) = Self.letter(status)
        Text(letter).font(PhrenTheme.Font.monoCaption.weight(.bold)).foregroundStyle(color)
            .frame(width: 18).accessibilityLabel(name)
    }
}

struct DiffCounts: View {
    let added: Int
    let removed: Int
    var body: some View {
        HStack(spacing: 6) {
            Text("+\(added)").foregroundStyle(PhrenTheme.success)
            Text("−\(removed)").foregroundStyle(PhrenTheme.danger)
        }
        .font(PhrenTheme.Font.monoCaption2.weight(.medium)).monospacedDigit()
        .accessibilityElement(children: .ignore).accessibilityLabel("\(added) added, \(removed) removed")
    }
}

/// A vertical stack that is lazy only when the row count calls for it.
private struct DiffRowStack<Content: View>: View {
    let lazy: Bool
    @ViewBuilder var content: Content
    var body: some View {
        if lazy { LazyVStack(alignment: .leading, spacing: 0) { content } }
        else { VStack(alignment: .leading, spacing: 0) { content } }
    }
}
