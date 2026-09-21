import Foundation

/// A message as blocks: prose paragraphs (a blank line ends one, so each
/// is copied and selected on its own), headings, fenced code, pipe tables.
struct ChatRichTextDocument {
    let blocks: [Block]
    /// SwiftUI exposes every linked run as a separate accessibility descendant.
    /// Keep ordinary replies fully interactive, but make pathological generated
    /// prose one readable element instead of hundreds of repeated link nodes.
    let condensesAccessibility: Bool
    let accessibilityText: String
    init(_ text: String) {
        let blocks = Self.parse(text)
        self.blocks = blocks
        let links = blocks.reduce(0) { count, block in
            count + block.attributed.runs.filter { $0.link != nil }.count
                + block.attributedRows.reduce(0) { $0 + $1.reduce(0) { $0 + $1.runs.filter { $0.link != nil }.count } }
        }
        condensesAccessibility = links > 16
        accessibilityText = blocks.compactMap { block in
            if block.language != nil { return block.text }
            if !block.rows.isEmpty { return block.rows.map { $0.joined(separator: ", ") }.joined(separator: "\n") }
            return String(block.attributed.characters)
        }.joined(separator: "\n\n")
    }
    struct Block: Identifiable {
        let id: Int
        let text: String
        let language: String?
        let heading: Bool
        var attributed = AttributedString()
        var attributedRows: [[AttributedString]] = []
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
    private static func parse(_ text: String) -> [Block] {
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
            } else if language == nil, line.allSatisfy(\.isWhitespace) {
                flush()
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
        return result.map { block in
            var prepared = block
            if block.language == nil { prepared.attributed = inline(block.text) }
            prepared.attributedRows = block.rows.map { $0.map(inline) }
            return prepared
        }
    }
    static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// Bounded parsed Markdown, including inline AttributedStrings, keyed by the
/// transcript part's precomputed content revision and display variant.
enum ChatRichTextDocumentCache {
    private final class Box: NSObject { let value: ChatRichTextDocument; init(_ value: ChatRichTextDocument) { self.value = value } }
    private static let values: NSCache<NSString, Box> = {
        let value = NSCache<NSString, Box>(); value.countLimit = 500; value.totalCostLimit = 24 * 1_024 * 1_024; return value
    }()
    static func value(_ text: String, key: String) -> ChatRichTextDocument {
        if let found = values.object(forKey: key as NSString) { return found.value }
        let started = ChatPerformance.begin(); defer { ChatPerformance.end("Markdown parse", started) }
        let result = ChatRichTextDocument(text)
        values.setObject(Box(result), forKey: key as NSString, cost: text.utf8.count * 4)
        return result
    }
}
