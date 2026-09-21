import PhrenKit
import SwiftUI


/// A tool's patch inside the chat, drawn with the same rows as the file diff
/// screen (VS Code's inline diff: gutter numbers, row tints, changed
/// characters tinted harder). It stays a preview: a bounded number of lines
/// until expanded, then 120-line pages so a 2,000-line patch never lays out
/// at once inside the timeline.
struct CodeDiffView: View {
    let patch: String
    let previewLineLimit: Int
    /// A file under a shell call starts as its title bar alone: tap it for
    /// the preview, tap again to fold it, or open the whole diff full screen.
    let collapsible: Bool
    @State private var open = false
    @Environment(\.openChatDiff) private var openFullDiff
    @State private var showAll = false
    @State private var page = 0
    @AppStorage(ChatSettings.wrapKey) private var wrap = false
    /// The card's width, so row tints run edge to edge inside the horizontal
    /// scroller instead of stopping where the longest line ends.
    @State private var width: CGFloat = 0
    private let cacheKey: String?
    init(patch: String, cacheKey: String? = nil, previewLineLimit: Int = 36, collapsible: Bool = false) {
        self.patch = patch
        self.previewLineLimit = previewLineLimit
        self.collapsible = collapsible
        self.cacheKey = cacheKey
    }
    /// The file named in the patch header decides the colouring.
    private func language(_ diff: DiffDocument) -> SyntaxTokenizer.Language {
        let header = diff.rows.first { $0.kind == .header }?.text ?? ""
        return .detect(header.replacingOccurrences(of: "New file · ", with: "").replacingOccurrences(of: "Deleted file · ", with: ""))
    }

    var body: some View {
        let folded = collapsible && !open
        let summary = folded ? DiffDocumentSummaryCache.value(for: patch, key: cacheKey) : nil
        let diff = folded ? nil : DiffDocumentCache.value(for: patch, key: cacheKey)
        let rows = diff?.rows ?? []
        let numbered = rows.contains { $0.old != nil || $0.new != nil }
        let pageCount = max(1, (rows.count + 119) / 120)
        let currentPage = min(page, pageCount - 1)
        let visible = showAll ? Array(rows.dropFirst(currentPage * 120).prefix(120)) : Array(rows.prefix(previewLineLimit))
        let header = summary?.header ?? rows.first(where: { $0.kind == .header })?.text
        let added = summary?.added ?? diff?.added ?? 0
        let removed = summary?.removed ?? diff?.removed ?? 0
        let truncated = summary?.truncated ?? diff?.truncated ?? false
        let unfolded = !collapsible || open
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                if collapsible {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { open.toggle() }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(PhrenTheme.chatNeutralDim)
                                .rotationEffect(.degrees(open ? 90 : 0))
                            Text(header ?? "Patch").font(.system(.caption2, design: .monospaced)).foregroundStyle(PhrenTheme.textSecondary)
                                .lineLimit(1).truncationMode(.head)
                            Spacer(minLength: 4)
                            DiffCounts(added: added, removed: removed)
                        }.frame(minHeight: 32).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(header ?? "Patch"), \(open ? "expanded" : "collapsed")")
                    .accessibilityIdentifier("chat-patch-file:\((header ?? "").replacingOccurrences(of: "New file · ", with: "").replacingOccurrences(of: "Deleted file · ", with: ""))")
                    Button("Open full diff", systemImage: "arrow.up.left.and.arrow.down.right") {
                        let path = (header ?? "Patch").replacingOccurrences(of: "New file · ", with: "").replacingOccurrences(of: "Deleted file · ", with: "")
                        let status = (header ?? "").hasPrefix("New file") ? "A " : (header ?? "").hasPrefix("Deleted file") ? "D " : " M"
                        openFullDiff(.init(file: .init(path: path, status: status, sections: []),
                                           section: .init(id: "chat:\(path)", kind: "unstaged", patch: patch)))
                    }
                        .labelStyle(.iconOnly).foregroundStyle(PhrenTheme.textMuted).frame(width: 36, height: 32)
                        .accessibilityIdentifier("chat-patch-open")
                } else {
                    if let header {
                        Text(header).font(.system(.caption2, design: .monospaced)).foregroundStyle(PhrenTheme.textSecondary)
                            .lineLimit(1).truncationMode(.head)
                    }
                    Spacer(minLength: 4)
                    DiffCounts(added: added, removed: removed)
                }
                if truncated { Text("Preview").font(.caption2).foregroundStyle(PhrenTheme.textMuted) }
                Button("Copy patch", systemImage: "doc.on.doc") { ChatClipboard.copy(patch) }
                    .labelStyle(.iconOnly).foregroundStyle(PhrenTheme.textMuted).frame(width: 36, height: 32)
            }
            .padding(.leading, 12).padding(.trailing, 4)
            .background(PhrenTheme.surfaceRaised)
            .overlay(alignment: .bottom) { Rectangle().fill(PhrenTheme.border).frame(height: 1).opacity(unfolded ? 1 : 0) }
            if unfolded, showAll && pageCount > 1 {
                HStack(spacing: 4) {
                    pageButton("First patch page", "chevron.left.2", "first", destination: 0, current: currentPage, count: pageCount)
                    pageButton("Previous patch page", "chevron.left", "previous", destination: currentPage - 1, current: currentPage, count: pageCount)
                    Spacer(minLength: 4)
                    Text(verbatim: "Lines \(currentPage * 120 + 1)–\(min((currentPage + 1) * 120, rows.count)) of \(rows.count)")
                        .font(.caption2).monospacedDigit().foregroundStyle(PhrenTheme.textMuted)
                        .accessibilityIdentifier("chat-patch-page-range")
                    Spacer(minLength: 4)
                    pageButton("Next patch page", "chevron.right", "next", destination: currentPage + 1, current: currentPage, count: pageCount)
                    pageButton("Last patch page", "chevron.right.2", "last", destination: pageCount - 1, current: currentPage, count: pageCount)
                }.padding(.horizontal, 6)
            }
            if unfolded, let diff { ScrollView(wrap ? (showAll ? [.vertical] : []) : (showAll ? [.horizontal, .vertical] : [.horizontal])) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, row in
                        if row.kind == .header, row.id == diff.rows.first(where: { $0.kind == .header })?.id {
                            // Already named in the card's title bar.
                        } else {
                            let run = DiffPalette.run(visible, at: index)
                            DiffRowView(row: row, numbered: numbered, language: language(diff), runStart: run.start, runEnd: run.end, wrap: wrap, compact: true)
                        }
                    }
                }
                .frame(minWidth: width, alignment: .leading)
                .textSelection(.enabled)
                .padding(.vertical, 4)
            }.id(currentPage).frame(height: showAll ? 320 : nil).defaultScrollAnchor(.topLeading) }
            if unfolded, rows.count > previewLineLimit {
                Button(showAll ? "Collapse patch" : "Show \(rows.count - previewLineLimit) more lines") { showAll.toggle(); page = 0 }
                    .font(.caption).foregroundStyle(PhrenTheme.accent).padding(10)
                    .accessibilityIdentifier("chat-patch-expand")
            }
            if unfolded, truncated { Text("Preview truncated. Copy the patch for all supplied lines.").font(.caption).foregroundStyle(PhrenTheme.textMuted).padding(10) }
        }
        .phrenPanel(tool: true)
        .background(GeometryReader { geometry in
            Color.clear.preference(key: DiffCardWidth.self, value: geometry.size.width)
        })
        .onPreferenceChange(DiffCardWidth.self) { width = $0 }
    }

    private struct DiffCardWidth: PreferenceKey {
        static let defaultValue: CGFloat = 0
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
    }

    private func pageButton(_ title: String, _ icon: String, _ id: String, destination: Int, current: Int, count: Int) -> some View {
        Button { page = destination } label: {
            Image(systemName: icon).frame(width: 44, height: 44).contentShape(Rectangle())
        }
            .accessibilityLabel(title)
            .disabled(destination < 0 || destination >= count || destination == current)
            .accessibilityIdentifier("chat-patch-\(id)")
    }
}
