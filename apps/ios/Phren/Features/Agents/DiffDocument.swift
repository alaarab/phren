import Foundation
import PhrenKit

/// A unified patch prepared the way VS Code's diff editor presents one: full
/// rows with old/new line numbers, changed blocks (a run of removed lines
/// followed by the added lines that replaced them) for next/previous
/// navigation, the word runs that actually differ when a removed line pairs
/// with an added one, and the unmodified lines the patch folded away.
struct DiffDocument {
    enum Kind { case context, added, removed, hunk, header }

    struct Row: Identifiable {
        let id: Int
        let kind: Kind
        let old: Int?
        let new: Int?
        let text: String
        /// Ranges (in `text`) that differ word-by-word from the paired line —
        /// VS Code's stronger "inserted/removed text" tint.
        var inner: [Range<String.Index>] = []
        /// The change block this row belongs to; context rows have none.
        var change: Int?
    }

    /// A run of unmodified lines `git diff` left out, drawn as a fold bar
    /// before `beforeRow`.
    struct Fold: Identifiable {
        let id: Int
        let count: Int
        let oldStart: Int
        let beforeRow: Int
    }

    /// One side-by-side line: at most one row per column.
    struct SplitRow: Identifiable {
        let id: Int
        let left: Row?
        let right: Row?
        var hunk: Row? { left?.kind == .hunk ? left : nil }
    }

    let rows: [Row]
    /// Fold bars in document order.
    let folds: [Fold]
    /// Row index where each change block starts, in order.
    let changeStarts: [Int]
    let added: Int
    let removed: Int
    let truncated: Bool

    init(patch: String) {
        let preview = DiffPreview(patch)
        var rows = preview.lines.map { line in
            Row(id: line.id, kind: Self.kind(line.kind), old: line.old, new: line.new, text: line.text)
        }
        var starts: [Int] = []
        var index = 0
        while index < rows.count {
            guard rows[index].kind == .removed || rows[index].kind == .added else { index += 1; continue }
            let start = index
            var removedEnd = index
            while removedEnd < rows.count, rows[removedEnd].kind == .removed { removedEnd += 1 }
            var addedEnd = removedEnd
            while addedEnd < rows.count, rows[addedEnd].kind == .added { addedEnd += 1 }
            // A lone run of added lines is a block on its own.
            if addedEnd == start { addedEnd = removedEnd }
            let change = starts.count
            starts.append(start)
            for row in start..<addedEnd { rows[row].change = change }
            // Pair removed with added line-for-line, like VS Code's inner diff.
            let pairs = min(removedEnd - start, addedEnd - removedEnd)
            for offset in 0..<pairs {
                let left = start + offset, right = removedEnd + offset
                let oldBody = String(rows[left].text.dropFirst())
                let newBody = String(rows[right].text.dropFirst())
                let highlight = DiffWords.highlight(old: oldBody, new: newBody)
                // Nothing shared: the whole-line tint already says so.
                guard highlight.matched > 0 else { continue }
                rows[left].inner = Self.shifted(highlight.old, body: oldBody, in: rows[left].text)
                rows[right].inner = Self.shifted(highlight.new, body: newBody, in: rows[right].text)
            }
            index = addedEnd
        }
        self.rows = rows
        self.changeStarts = starts
        self.added = preview.added
        self.removed = preview.removed
        self.truncated = preview.truncated
        self.folds = Self.folds(rows: rows)
    }

    /// Rows paired into two columns: context on both sides, a change block's
    /// removed lines on the left beside the added lines on the right.
    var split: [SplitRow] {
        var result: [SplitRow] = []
        var index = 0
        while index < rows.count {
            let row = rows[index]
            if row.kind == .removed || row.kind == .added {
                var removedRows: [Row] = [], addedRows: [Row] = []
                while index < rows.count, rows[index].kind == .removed { removedRows.append(rows[index]); index += 1 }
                while index < rows.count, rows[index].kind == .added { addedRows.append(rows[index]); index += 1 }
                for line in 0..<max(removedRows.count, addedRows.count) {
                    let left = line < removedRows.count ? removedRows[line] : nil
                    let right = line < addedRows.count ? addedRows[line] : nil
                    result.append(SplitRow(id: (left ?? right)!.id, left: left, right: right))
                }
            } else {
                result.append(SplitRow(id: row.id, left: row, right: row.kind == .context ? row : nil))
                index += 1
            }
        }
        return result
    }

    private static func kind(_ kind: DiffPreview.Kind) -> Kind {
        switch kind {
        case .context: return .context
        case .added: return .added
        case .removed: return .removed
        case .hunk: return .hunk
        case .header: return .header
        }
    }

    /// The word runs are computed on the body (the line without its sign), so
    /// carry them over to the stored row text by character offset — a `String.Index`
    /// belongs to the string that made it, not to an equal copy.
    private static func shifted(_ ranges: [Range<String.Index>], body: String, in text: String) -> [Range<String.Index>] {
        ranges.compactMap { range in
            let lower = body.distance(from: body.startIndex, to: range.lowerBound) + 1
            let upper = body.distance(from: body.startIndex, to: range.upperBound) + 1
            guard let start = text.index(text.startIndex, offsetBy: lower, limitedBy: text.endIndex),
                  let end = text.index(text.startIndex, offsetBy: upper, limitedBy: text.endIndex) else { return nil }
            return start..<end
        }
    }

    /// Where the fold bars sit: the gap before a hunk lives directly above it.
    private static func folds(rows: [Row]) -> [Fold] {
        var hunks: [(row: Int, hunk: DiffFolds.Hunk)] = []
        for (index, row) in rows.enumerated() where row.kind == .hunk {
            if let hunk = hunkHeader(row.text) { hunks.append((index, hunk)) }
        }
        guard !hunks.isEmpty else { return [] }
        return DiffFolds.gaps(hunks.map { $0.hunk }).enumerated().map { order, gap in
            let before = gap.afterHunk < 0 ? 0 : gap.afterHunk + 1
            return Fold(id: order, count: gap.count, oldStart: gap.oldStart, beforeRow: hunks[min(before, hunks.count - 1)].row)
        }
    }

    /// `@@ -12,3 +14,2 @@` — the old side is all a fold needs. A missing count
    /// means one line; a missing old range (`@@ -0,0 +…`) means zero.
    static func hunkHeader(_ text: String) -> DiffFolds.Hunk? {
        guard let match = text.range(of: #"^@@ -([0-9]+)(?:,([0-9]+))? "#, options: .regularExpression) else { return nil }
        let numbers = text[match].dropFirst(4).prefix { $0.isNumber || $0 == "," }.split(separator: ",")
        guard let start = numbers.first.flatMap({ Int($0) }) else { return nil }
        let count = numbers.count > 1 ? Int(numbers[1]) ?? 1 : 1
        return DiffFolds.Hunk(oldStart: start, oldCount: count)
    }
}