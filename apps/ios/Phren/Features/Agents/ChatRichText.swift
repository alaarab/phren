import SwiftUI

/// Native Markdown paragraphs, fenced code and pipe tables; no remote web content is loaded.
struct ChatRichText: View, Equatable {
    @AppStorage(ChatSettings.wrapKey) private var wrap = false
    let text: String
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.text == rhs.text }
    @ScaledMetric(relativeTo: .body) private var textSize = 14.5
    @ScaledMetric(relativeTo: .headline) private var headingSize = 15.5
    private struct Block: Identifiable {
        let id: Int
        let text: String
        let language: String?
        let heading: Bool
        var rows: [[String]] = []
    }
    private static let tableDivider = try! NSRegularExpression(pattern: #"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$"#)
    private static func isTableDivider(_ line: String) -> Bool {
        tableDivider.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
    }
    private static func tableCells(_ line: String) -> [String] {
        var cells = line.trimmingCharacters(in: .whitespaces).components(separatedBy: "|")
        if cells.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeFirst() }
        if cells.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeLast() }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }
    private var blocks: [Block] {
        var result: [Block] = [], lines: [String] = []
        var language: String?
        func flush() {
            guard !lines.isEmpty else { return }
            let raw = lines.joined(separator: "\n")
            // Transcript delimiters are not visual paragraphs. Preserve code
            // whitespace, but do not render blank lines around prose blocks.
            let content = language == nil ? raw.trimmingCharacters(in: .whitespacesAndNewlines) : raw
            lines = []
            guard !content.isEmpty else { return }
            result.append(.init(id: result.count, text: content, language: language, heading: false))
        }
        let source = text.components(separatedBy: "\n")
        var index = 0
        while index < source.count {
            let line = source[index]
            if line.hasPrefix("```") {
                flush(); language = language == nil ? String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces) : nil
            } else if language == nil && line.range(of: #"^#{1,6} "#, options: .regularExpression) != nil {
                flush()
                result.append(.init(id: result.count, text: String(line.drop(while: { $0 == "#" || $0 == " " })), language: nil, heading: true))
            } else if language == nil, line.trimmingCharacters(in: .whitespaces).hasPrefix("|"),
                      index + 1 < source.count, Self.isTableDivider(source[index + 1]) {
                flush()
                var rows = [Self.tableCells(line)]
                index += 2
                while index < source.count, source[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(Self.tableCells(source[index]))
                    index += 1
                }
                let width = rows.map(\.count).max() ?? 0
                rows = rows.map { $0 + Array(repeating: "", count: width - $0.count) }
                result.append(.init(id: result.count, text: "", language: nil, heading: false, rows: rows))
                continue
            } else { lines.append(line) }
            index += 1
        }
        flush()
        return result
    }
    private func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(blocks) { block in
                if let language = block.language {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(language.isEmpty ? "Code" : language).font(.caption)
                            Spacer()
                            Button("Copy code", systemImage: "doc.on.doc") { UIPasteboard.general.string = block.text }
                                .font(.caption).labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 32)
                        }.foregroundStyle(PhrenTheme.chatNeutral)
                        ScrollView(wrap ? [] : [.horizontal]) {
                            Text(CodeHighlighting.highlightedBlock(block.text, language: .detect(language)))
                                .font(.system(size: textSize, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                                .textSelection(.enabled).fixedSize(horizontal: !wrap, vertical: false)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }.padding(12).background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(PhrenTheme.border, lineWidth: 1))
                } else if !block.rows.isEmpty {
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                            ForEach(Array(block.rows.enumerated()), id: \.offset) { rowIndex, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                        Text(inline(cell))
                                            .font(.system(size: textSize, weight: rowIndex == 0 ? .semibold : .regular, design: .monospaced))
                                            .foregroundStyle(rowIndex == 0 ? PhrenTheme.chatNeutral : PhrenTheme.chatText)
                                            .fixedSize(horizontal: true, vertical: false)
                                    }
                                }
                                if rowIndex == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                            }
                        }
                        .textSelection(.enabled).tint(PhrenTheme.link)
                    }
                    .padding(12).background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(PhrenTheme.border, lineWidth: 1))
                } else {
                    Text(inline(block.text))
                        .font(.system(size: block.heading ? headingSize : textSize, weight: block.heading ? .semibold : .regular, design: .monospaced))
                        .foregroundStyle(PhrenTheme.chatText)
                        .lineSpacing(3).textSelection(.enabled).tint(PhrenTheme.link)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}
