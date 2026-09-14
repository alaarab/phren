import PhrenKit
import SwiftUI

/// VS Code's diff editor colours, mapped onto the theme's semantic tints: a
/// soft full-row tint for an inserted or removed line and a stronger one on
/// the characters that changed within a paired line.
enum DiffPalette {
    static func line(_ kind: DiffDocument.Kind) -> Color {
        switch kind {
        case .added: return PhrenTheme.success.opacity(0.16)
        case .removed: return PhrenTheme.danger.opacity(0.16)
        case .hunk: return PhrenTheme.accent.opacity(0.07)
        case .context, .header: return .clear
        }
    }
    static func inner(_ kind: DiffDocument.Kind) -> Color {
        kind == .added ? PhrenTheme.success.opacity(0.42) : PhrenTheme.danger.opacity(0.42)
    }
    static func gutter(_ kind: DiffDocument.Kind) -> Color {
        switch kind {
        case .added: return PhrenTheme.success.opacity(0.28)
        case .removed: return PhrenTheme.danger.opacity(0.28)
        default: return .clear
        }
    }
    static func sign(_ kind: DiffDocument.Kind) -> String {
        kind == .added ? "+" : kind == .removed ? "−" : " "
    }
    static let font = Font.system(.caption, design: .monospaced)
    static let numberWidth: CGFloat = 34

    /// The gutter tint for one row of a run of inserted or removed lines:
    /// a plain rectangle, rounded only where the run starts and ends, so
    /// consecutive rows read as one block rather than a pill per line.
    static func gutterShape(_ kind: DiffDocument.Kind, runStart: Bool, runEnd: Bool) -> some View {
        let r: CGFloat = 6
        return UnevenRoundedRectangle(topLeadingRadius: runStart ? r : 0, bottomLeadingRadius: runEnd ? r : 0,
                                      bottomTrailingRadius: runEnd ? r : 0, topTrailingRadius: runStart ? r : 0, style: .continuous)
            .fill(gutter(kind))
    }
    /// Whether `index` in `rows` begins or ends a run of its kind — only
    /// inserted and removed lines form runs.
    static func run(_ rows: [DiffDocument.Row], at index: Int) -> (start: Bool, end: Bool) {
        let changed = { (kind: DiffDocument.Kind) in kind == .added || kind == .removed }
        guard changed(rows[index].kind) else { return (true, true) }
        // A removed block followed by its replacement reads as one change.
        return (index == 0 || !changed(rows[index - 1].kind), index == rows.count - 1 || !changed(rows[index + 1].kind))
    }
}

/// One unified-view row: old and new line numbers in the gutter, the sign,
/// then the line with its inner change highlighted.
struct DiffRowView: View {
    let row: DiffDocument.Row
    var numbered = true
    var language: SyntaxTokenizer.Language = .plain
    /// Where this row sits in a run of inserted or removed lines.
    var runStart = true
    var runEnd = true
    @AppStorage(ChatSettings.wrapKey) private var wrap = false

    var body: some View {
        if row.kind == .hunk {
            DiffHunkRow(text: row.text)
        } else if row.kind == .header {
            Text(row.text.isEmpty ? " " : row.text)
                .font(DiffPalette.font.weight(.semibold)).foregroundStyle(PhrenTheme.textSecondary)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(PhrenTheme.surfaceRaised)
        } else {
            HStack(alignment: .top, spacing: 0) {
                if numbered {
                    // The tint spans the row's full height, so a run of lines
                    // shares one unbroken block.
                    HStack(spacing: 0) {
                        Text(row.old.map(String.init) ?? "").frame(width: DiffPalette.numberWidth, alignment: .trailing)
                        Text(row.new.map(String.init) ?? "").frame(width: DiffPalette.numberWidth, alignment: .trailing)
                    }
                    .foregroundStyle(PhrenTheme.textDim).padding(.trailing, 6).padding(.vertical, 1.5)
                    .background(DiffPalette.gutterShape(row.kind, runStart: runStart, runEnd: runEnd))
                }
                Text(DiffPalette.sign(row.kind))
                    .foregroundStyle(row.kind == .added ? PhrenTheme.success : row.kind == .removed ? PhrenTheme.danger : PhrenTheme.textDim)
                    .frame(width: 14, alignment: .center).padding(.vertical, 1.5)
                Text(Self.attributed(row, language: language))
                    .foregroundStyle(PhrenTheme.text)
                    .fixedSize(horizontal: !wrap, vertical: false)
                    .padding(.trailing, 12).padding(.vertical, 1.5)
                Spacer(minLength: 0)
            }
            .font(DiffPalette.font)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(DiffPalette.line(row.kind)))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.spoken(row))
            .accessibilityAddTraits(.isStaticText)
        }
    }

    /// The line without its leading sign, syntax-coloured, with the changed
    /// characters tinted on top — GitHub's two layers.
    static func attributed(_ row: DiffDocument.Row, language: SyntaxTokenizer.Language = .plain) -> AttributedString {
        let body = row.kind == .context || row.kind == .added || row.kind == .removed ? String(row.text.dropFirst()) : row.text
        var text = body.isEmpty ? AttributedString(" ") : CodeHighlighting.highlighted(body, language: language)
        guard let inner = row.inner, !inner.isEmpty else { return text }
        // `inner` indexes the original line; shift by the dropped sign.
        let start = row.text.distance(from: row.text.index(after: row.text.startIndex), to: inner.lowerBound)
        let length = row.text.distance(from: inner.lowerBound, to: inner.upperBound)
        let from = text.index(text.startIndex, offsetByCharacters: max(0, start))
        let to = text.index(from, offsetByCharacters: min(length, text.characters.count - max(0, start)))
        text[from..<to].backgroundColor = DiffPalette.inner(row.kind)
        return text
    }

    /// "+let accent = purple" — the sign is what a screen reader needs first.
    static func spoken(_ row: DiffDocument.Row) -> String {
        switch row.kind {
        case .added: return "+" + row.text.dropFirst()
        case .removed: return "-" + row.text.dropFirst()
        default: return String(row.text.dropFirst())
        }
    }
}

/// The boundary between hunks — VS Code draws a dotted rule with the hunk's
/// context; here the `@@` header sits on a hairline band.
struct DiffHunkRow: View {
    let text: String
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(PhrenTheme.borderStrong).frame(width: 2 * DiffPalette.numberWidth + 6, height: 1)
            Text(text).font(DiffPalette.font).foregroundStyle(PhrenTheme.accent.opacity(0.9)).lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
            Rectangle().fill(PhrenTheme.borderStrong).frame(height: 1)
        }
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DiffPalette.line(.hunk))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}

/// One side-by-side row: the old line on the left, the new on the right,
/// each with its own number column; an empty side is a blank cell.
struct DiffSplitRowView: View {
    let row: DiffDocument.SplitRow
    let columnWidth: CGFloat
    var language: SyntaxTokenizer.Language = .plain
    var runStart = true
    var runEnd = true

    var body: some View {
        if let hunk = row.hunk {
            DiffHunkRow(text: hunk.text)
        } else if row.left?.kind == .header, let header = row.left {
            DiffRowView(row: header, language: language)
        } else {
            HStack(alignment: .top, spacing: 0) {
                cell(row.left, number: row.left?.old)
                Rectangle().fill(PhrenTheme.borderStrong).frame(width: 1)
                cell(row.right, number: row.right?.new)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([row.left, row.right].compactMap { $0 }.map(DiffRowView.spoken).joined(separator: ", "))
            .accessibilityAddTraits(.isStaticText)
        }
    }

    private func cell(_ line: DiffDocument.Row?, number: Int?) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Text(number.map(String.init) ?? "").frame(width: DiffPalette.numberWidth, alignment: .trailing)
                .foregroundStyle(PhrenTheme.textDim).padding(.trailing, 6).padding(.vertical, 1.5)
                .background(line.map { DiffPalette.gutterShape($0.kind, runStart: runStart, runEnd: runEnd) })
            if let line {
                Text(DiffPalette.sign(line.kind))
                    .foregroundStyle(line.kind == .added ? PhrenTheme.success : line.kind == .removed ? PhrenTheme.danger : PhrenTheme.textDim)
                    .frame(width: 14)
                Text(DiffRowView.attributed(line, language: language)).foregroundStyle(PhrenTheme.text).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
        .font(DiffPalette.font)
        .frame(width: columnWidth, alignment: .leading)
        .background(Rectangle().fill(line.map { DiffPalette.line($0.kind) } ?? PhrenTheme.surface.opacity(0.4)))
    }
}
