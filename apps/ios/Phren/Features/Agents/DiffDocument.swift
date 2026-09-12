import SwiftUI

/// A unified patch prepared the way VS Code's diff editor presents one: full
/// rows with old/new line numbers, changed blocks (a run of removed lines
/// followed by the added lines that replaced them) for next/previous
/// navigation, and the inner character range that actually differs when a
/// removed line pairs with an added one, so a one-word edit reads as one word.
struct DiffDocument {
    enum Kind { case context, added, removed, hunk, header }

    struct Row: Identifiable {
        let id: Int
        let kind: Kind
        let old: Int?
        let new: Int?
        let text: String
        /// Character range (in `text`) that differs from the paired line —
        /// VS Code's stronger "inserted/removed text" tint.
        var inner: Range<String.Index>?
        /// The change block this row belongs to; context rows have none.
        var change: Int?
    }

    /// One side-by-side line: at most one row per column.
    struct SplitRow: Identifiable {
        let id: Int
        let left: Row?
        let right: Row?
        var hunk: Row? { left?.kind == .hunk ? left : nil }
    }

    let rows: [Row]
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
                if let (a, b) = Self.innerDifference(rows[left].text, rows[right].text) {
                    rows[left].inner = a; rows[right].inner = b
                }
            }
            index = addedEnd
        }
        self.rows = rows
        self.changeStarts = starts
        self.added = preview.added
        self.removed = preview.removed
        self.truncated = preview.truncated
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

    /// The differing middle after trimming the common prefix and suffix. The
    /// diff body starts after the `+`/`-` sign, which both lines share in
    /// position, so it is skipped. Nil when the lines have nothing in common
    /// worth pointing at (the whole line changed) — then the row tint alone
    /// says so, as VS Code does.
    static func innerDifference(_ a: String, _ b: String) -> (Range<String.Index>, Range<String.Index>)? {
        let bodyA = a.dropFirst(), bodyB = b.dropFirst()
        guard !bodyA.isEmpty, !bodyB.isEmpty else { return nil }
        var prefix = 0
        var ia = bodyA.startIndex, ib = bodyB.startIndex
        while ia < bodyA.endIndex, ib < bodyB.endIndex, bodyA[ia] == bodyB[ib] {
            prefix += 1; ia = bodyA.index(after: ia); ib = bodyB.index(after: ib)
        }
        var ea = bodyA.endIndex, eb = bodyB.endIndex
        while ea > ia, eb > ib, bodyA[bodyA.index(before: ea)] == bodyB[bodyB.index(before: eb)] {
            ea = bodyA.index(before: ea); eb = bodyB.index(before: eb)
        }
        let shared = prefix + bodyA.distance(from: ea, to: bodyA.endIndex)
        let longest = max(bodyA.count, bodyB.count)
        // Under a third in common reads better as two whole lines.
        guard shared * 3 >= longest else { return nil }
        return (ia..<ea, ib..<eb)
    }
}
