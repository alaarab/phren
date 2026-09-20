import Foundation

/// The word-level difference between a paired removed and added line. The diff
/// renderer tints these runs harder than the fuzzy whole-line change, so a
/// one-word edit reads as one word.
public enum DiffWords {
    public struct Highlight: Equatable, Sendable {
        /// Runs of `old` that have no counterpart in `new`, in order.
        public let old: [Range<String.Index>]
        /// Runs of `new` that have no counterpart in `old`, in order.
        public let new: [Range<String.Index>]
        /// How many whitespace-separated words the two lines share. Zero means
        /// the lines read as wholly different and the row tint alone is enough.
        public let matched: Int

        public init(old: [Range<String.Index>], new: [Range<String.Index>], matched: Int) {
            self.old = old
            self.new = new
            self.matched = matched
        }
    }

    private struct Token {
        let text: String
        let range: Range<String.Index>
        let isWord: Bool
    }

    /// More token pairs than this and the quadratic table is not worth it: the
    /// whole line is reported as changed, which is what a human reads anyway.
    private static let maximumTable = 40_000

    public static func highlight(old: String, new: String) -> Highlight {
        let oldTokens = tokens(old), newTokens = tokens(new)
        let oldWords = oldTokens.indices.filter { oldTokens[$0].isWord }
        let newWords = newTokens.indices.filter { newTokens[$0].isWord }
        let rows = oldWords.count, columns = newWords.count
        var matchedOld = Set<Int>(), matchedNew = Set<Int>()
        if !oldWords.isEmpty, !newWords.isEmpty, rows * columns <= maximumTable {
            var table = [[Int]](repeating: [Int](repeating: 0, count: columns + 1), count: rows + 1)
            for i in stride(from: rows - 1, through: 0, by: -1) {
                for j in stride(from: columns - 1, through: 0, by: -1) {
                    table[i][j] = oldTokens[oldWords[i]].text == newTokens[newWords[j]].text
                        ? table[i + 1][j + 1] + 1
                        : max(table[i + 1][j], table[i][j + 1])
                }
            }
            var i = 0, j = 0
            while i < rows, j < columns {
                if oldTokens[oldWords[i]].text == newTokens[newWords[j]].text {
                    matchedOld.insert(oldWords[i]); matchedNew.insert(newWords[j]); i += 1; j += 1
                } else if table[i + 1][j] >= table[i][j + 1] { i += 1 } else { j += 1 }
            }
        }
        // Over the cap, or with nothing to match, no words are marked matched
        // and each side reports its whole self as changed.
        return Highlight(old: runs(tokens: oldTokens, words: oldWords, matched: matchedOld),
                         new: runs(tokens: newTokens, words: newWords, matched: matchedNew),
                         matched: matchedOld.count)
    }

    private static func tokens(_ string: String) -> [Token] {
        var result: [Token] = []
        var index = string.startIndex
        while index < string.endIndex {
            let start = index
            let whitespace = string[index].isWhitespace
            while index < string.endIndex, string[index].isWhitespace == whitespace { index = string.index(after: index) }
            result.append(Token(text: String(string[start..<index]), range: start..<index, isWord: !whitespace))
        }
        return result
    }

    /// Consecutive unmatched words merge into one run, swallowing the
    /// whitespace between them; a matched word closes the run.
    private static func runs(tokens: [Token], words: [Int], matched: Set<Int>) -> [Range<String.Index>] {
        var result: [Range<String.Index>] = []
        var start: String.Index?, end: String.Index?
        for tokenIndex in words {
            if matched.contains(tokenIndex) {
                if let lower = start, let upper = end { result.append(lower..<upper) }
                start = nil; end = nil
            } else {
                if start == nil { start = tokens[tokenIndex].range.lowerBound }
                end = tokens[tokenIndex].range.upperBound
            }
        }
        if let lower = start, let upper = end { result.append(lower..<upper) }
        return result
    }
}

/// The unmodified lines a unified patch hides. `git diff` only prints a few
/// context lines around each hunk, so the gap between hunks is known from the
/// hunk headers even though its lines are not in the patch. The renderer draws
/// a fold for each gap and lets the reader jump over it.
public enum DiffFolds {
    /// One hunk's old-side range, parsed from a `@@ -start,count +… @@` header.
    public struct Hunk: Equatable, Sendable {
        public let oldStart: Int
        public let oldCount: Int

        public init(oldStart: Int, oldCount: Int) {
            self.oldStart = oldStart
            self.oldCount = oldCount
        }
    }

    /// A run of unmodified lines the patch omitted.
    public struct Gap: Equatable, Sendable {
        /// How many unmodified lines it stands for.
        public let count: Int
        /// The first hidden old line, 1-based.
        public let oldStart: Int
        /// Index of the hunk it follows, `-1` before the first hunk.
        public let afterHunk: Int

        public init(count: Int, oldStart: Int, afterHunk: Int) {
            self.count = count
            self.oldStart = oldStart
            self.afterHunk = afterHunk
        }
    }

    /// The leading gap and every gap between hunks, in document order.
    public static func gaps(_ hunks: [Hunk]) -> [Gap] {
        var result: [Gap] = []
        for (index, hunk) in hunks.enumerated() {
            if index == 0 {
                if hunk.oldStart > 1 { result.append(Gap(count: hunk.oldStart - 1, oldStart: 1, afterHunk: -1)) }
                continue
            }
            let previous = hunks[index - 1]
            // A `-start,0` hunk inserted after `start`; otherwise it ends on
            // `start + count - 1`.
            let lastOld = previous.oldCount == 0 ? previous.oldStart : previous.oldStart + previous.oldCount - 1
            let count = hunk.oldStart - lastOld - 1
            if count > 0 { result.append(Gap(count: count, oldStart: lastOld + 1, afterHunk: index - 1)) }
        }
        return result
    }
}