import PhrenKit
import SwiftUI

/// Native Markdown paragraphs, fenced code and pipe tables; no remote web content is loaded.
struct ChatRichText: View, Equatable {
    let text: String
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.text == rhs.text }
    @ScaledMetric(relativeTo: .body) private var textSize = 14.5
    @ScaledMetric(relativeTo: .headline) private var headingSize = 15.5
    private let document: ChatRichTextDocument
    init(text: String, cacheKey: String? = nil) {
        self.text = text
        document = ChatRichTextDocumentCache.value(text, key: cacheKey ?? "text:\(text.hashValue)")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(document.blocks) { block in
                if let language = block.language {
                    ChatCodeBlock(text: block.text, language: language)
                } else if !block.rows.isEmpty {
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                            ForEach(Array(block.rows.enumerated()), id: \.offset) { rowIndex, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { column, _ in
                                        Text(block.attributedRows[rowIndex][column])
                                            .font(.system(size: textSize, weight: rowIndex == 0 ? .semibold : .regular, design: .monospaced))
                                            .foregroundStyle(rowIndex == 0 ? PhrenTheme.chatNeutral : PhrenTheme.chatText)
                                    }
                                }
                                if rowIndex == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                            }
                        }
                        .tint(PhrenTheme.link)
                    }
                    .padding(12).background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(PhrenTheme.border, lineWidth: 1))
                } else {
                    Text(block.attributed)
                        .font(.system(size: block.heading ? headingSize : textSize, weight: block.heading ? .semibold : .regular, design: .monospaced))
                        .foregroundStyle(PhrenTheme.chatText)
                        .lineSpacing(3).tint(PhrenTheme.link)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

private struct ChatCodeBlock: View {
    let text: String
    let language: String
    @Environment(\.openToolOutput) private var openOutput
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(language.isEmpty ? "Code" : language).font(.caption)
                Spacer()
                Button("View code", systemImage: "arrow.up.left.and.arrow.down.right") {
                    openOutput(.init(title: language.isEmpty ? "Code" : language, text: text))
                }.frame(width: 44, height: 32)
                Button("Copy code", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }.frame(width: 44, height: 32)
            }.labelStyle(.iconOnly).foregroundStyle(PhrenTheme.chatNeutral)
            Text(CodeHighlighting.highlightedBlock(ToolOutputPreview(text, lines: 12, characters: 2_000).text, language: .detect(language)))
                .font(.system(size: 14.5, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                .lineLimit(12).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(12).phrenPanel(tool: true)
    }
}
