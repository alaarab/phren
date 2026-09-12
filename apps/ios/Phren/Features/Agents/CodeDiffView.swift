import SwiftUI

/// Shared by repository changes and tool patches, with semantic diff colors
/// independent of the user's action-button theme.
struct CodeDiffView: View {
    let patch: String
    var previewLineLimit = 36
    @State private var showAll = false
    @State private var page = 0
    private var preview: DiffPreview { DiffPreview(patch) }
    var body: some View {
        let diff = preview
        let numbered = diff.lines.contains { $0.old != nil || $0.new != nil }
        let pageCount = max(1, (diff.lines.count + 119) / 120)
        let currentPage = min(page, pageCount - 1)
        let visible = showAll ? Array(diff.lines.dropFirst(currentPage * 120).prefix(120)) : Array(diff.lines.prefix(previewLineLimit))
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("+\(diff.added)").foregroundStyle(PhrenTheme.success)
                Text("−\(diff.removed)").foregroundStyle(PhrenTheme.danger)
                if diff.truncated { Text("Preview").foregroundStyle(PhrenTheme.textMuted) }
                Spacer()
                Button("Copy patch", systemImage: "doc.on.doc") { UIPasteboard.general.string = patch }
                    .labelStyle(.iconOnly).foregroundStyle(PhrenTheme.textMuted).frame(width: 36, height: 32)
            }.font(.system(.caption2, design: .monospaced)).padding(.horizontal, 10)
            if showAll && pageCount > 1 {
                HStack(spacing: 4) {
                    pageButton("First patch page", "chevron.left.2", "first", destination: 0, current: currentPage, count: pageCount)
                    pageButton("Previous patch page", "chevron.left", "previous", destination: currentPage - 1, current: currentPage, count: pageCount)
                    Spacer(minLength: 4)
                    Text(verbatim: "Lines \(currentPage * 120 + 1)–\(min((currentPage + 1) * 120, diff.lines.count)) of \(diff.lines.count)")
                        .font(.caption2).monospacedDigit().foregroundStyle(PhrenTheme.textMuted)
                        .accessibilityIdentifier("chat-patch-page-range")
                    Spacer(minLength: 4)
                    pageButton("Next patch page", "chevron.right", "next", destination: currentPage + 1, current: currentPage, count: pageCount)
                    pageButton("Last patch page", "chevron.right.2", "last", destination: pageCount - 1, current: currentPage, count: pageCount)
                }.padding(.horizontal, 6)
            }
            ScrollView(showAll ? [.horizontal, .vertical] : [.horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(visible) { line in
                        HStack(alignment: .top, spacing: 8) {
                            if numbered && (line.kind == .context || line.kind == .added || line.kind == .removed) {
                                Text(line.old.map(String.init) ?? "").frame(width: 32, alignment: .trailing)
                                Text(line.new.map(String.init) ?? "").frame(width: 32, alignment: .trailing)
                            }
                            Text(line.text.isEmpty ? " " : line.text)
                                .foregroundStyle(line.kind == .hunk ? PhrenTheme.accent : PhrenTheme.text)
                                .fixedSize(horizontal: true, vertical: false)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.textDim)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(line.kind == .added ? PhrenTheme.success.opacity(0.15)
                                    : line.kind == .removed ? PhrenTheme.danger.opacity(0.13)
                                    : line.kind == .hunk ? PhrenTheme.accent.opacity(0.06) : .clear)
                        .accessibilityElement(children: .combine)
                    }
                }.textSelection(.enabled)
            }.id(currentPage).frame(height: showAll ? 320 : nil).defaultScrollAnchor(.topLeading)
            if diff.lines.count > previewLineLimit {
                Button(showAll ? "Collapse patch" : "Show \(diff.lines.count - previewLineLimit) more lines") { showAll.toggle(); page = 0 }
                    .font(.caption).foregroundStyle(PhrenTheme.accent).padding(10)
                    .accessibilityIdentifier("chat-patch-expand")
            }
            if diff.truncated { Text("Preview truncated. Copy the patch for all supplied lines.").font(.caption).foregroundStyle(PhrenTheme.textMuted).padding(10) }
        }
        .background(PhrenTheme.toolPanel, in: RoundedRectangle(cornerRadius: 12))
        .clipShape(RoundedRectangle(cornerRadius: 12))
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
