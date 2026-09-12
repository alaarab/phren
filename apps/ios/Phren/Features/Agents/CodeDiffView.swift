import SwiftUI

/// A tool's patch inside the chat, drawn with the same rows as the file diff
/// screen (VS Code's inline diff: gutter numbers, row tints, changed
/// characters tinted harder). It stays a preview: a bounded number of lines
/// until expanded, then 120-line pages so a 2,000-line patch never lays out
/// at once inside the timeline.
struct CodeDiffView: View {
    let patch: String
    var previewLineLimit = 36
    @State private var showAll = false
    @State private var page = 0
    /// The card's width, so row tints run edge to edge inside the horizontal
    /// scroller instead of stopping where the longest line ends.
    @State private var width: CGFloat = 0
    private var document: DiffDocument { DiffDocument(patch: patch) }

    var body: some View {
        let diff = document
        let numbered = diff.rows.contains { $0.old != nil || $0.new != nil }
        let pageCount = max(1, (diff.rows.count + 119) / 120)
        let currentPage = min(page, pageCount - 1)
        let visible = showAll ? Array(diff.rows.dropFirst(currentPage * 120).prefix(120)) : Array(diff.rows.prefix(previewLineLimit))
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                if let header = diff.rows.first(where: { $0.kind == .header }) {
                    Text(header.text).font(.system(.caption2, design: .monospaced)).foregroundStyle(PhrenTheme.textSecondary)
                        .lineLimit(1).truncationMode(.head)
                }
                Spacer(minLength: 4)
                DiffCounts(added: diff.added, removed: diff.removed)
                if diff.truncated { Text("Preview").font(.caption2).foregroundStyle(PhrenTheme.textMuted) }
                Button("Copy patch", systemImage: "doc.on.doc") { UIPasteboard.general.string = patch }
                    .labelStyle(.iconOnly).foregroundStyle(PhrenTheme.textMuted).frame(width: 36, height: 32)
            }
            .padding(.leading, 12).padding(.trailing, 4)
            .background(PhrenTheme.surfaceRaised)
            .overlay(alignment: .bottom) { Rectangle().fill(PhrenTheme.border).frame(height: 1) }
            if showAll && pageCount > 1 {
                HStack(spacing: 4) {
                    pageButton("First patch page", "chevron.left.2", "first", destination: 0, current: currentPage, count: pageCount)
                    pageButton("Previous patch page", "chevron.left", "previous", destination: currentPage - 1, current: currentPage, count: pageCount)
                    Spacer(minLength: 4)
                    Text(verbatim: "Lines \(currentPage * 120 + 1)–\(min((currentPage + 1) * 120, diff.rows.count)) of \(diff.rows.count)")
                        .font(.caption2).monospacedDigit().foregroundStyle(PhrenTheme.textMuted)
                        .accessibilityIdentifier("chat-patch-page-range")
                    Spacer(minLength: 4)
                    pageButton("Next patch page", "chevron.right", "next", destination: currentPage + 1, current: currentPage, count: pageCount)
                    pageButton("Last patch page", "chevron.right.2", "last", destination: pageCount - 1, current: currentPage, count: pageCount)
                }.padding(.horizontal, 6)
            }
            ScrollView(showAll ? [.horizontal, .vertical] : [.horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(visible) { row in
                        if row.kind == .header, row.id == diff.rows.first(where: { $0.kind == .header })?.id {
                            // Already named in the card's title bar.
                        } else {
                            DiffRowView(row: row, numbered: numbered)
                        }
                    }
                }
                .frame(minWidth: width, alignment: .leading)
                .textSelection(.enabled)
                .padding(.vertical, 4)
            }.id(currentPage).frame(height: showAll ? 320 : nil).defaultScrollAnchor(.topLeading)
            if diff.rows.count > previewLineLimit {
                Button(showAll ? "Collapse patch" : "Show \(diff.rows.count - previewLineLimit) more lines") { showAll.toggle(); page = 0 }
                    .font(.caption).foregroundStyle(PhrenTheme.accent).padding(10)
                    .accessibilityIdentifier("chat-patch-expand")
            }
            if diff.truncated { Text("Preview truncated. Copy the patch for all supplied lines.").font(.caption).foregroundStyle(PhrenTheme.textMuted).padding(10) }
        }
        .background(PhrenTheme.toolPanel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(PhrenTheme.border, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 12))
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
