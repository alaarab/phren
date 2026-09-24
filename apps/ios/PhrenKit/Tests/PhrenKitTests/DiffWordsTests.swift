import XCTest
@testable import PhrenKit

final class DiffWordsTests: XCTestCase {
    private func text(_ string: String, _ ranges: [Range<String.Index>]) -> [String] {
        ranges.map { String(string[$0]) }
    }

    func testHighlightsOnlyTheChangedWordRuns() {
        let cases: [(old: String, new: String, oldRuns: [String], newRuns: [String], matched: Int)] = [
            ("let accent = green", "let accent = purple", ["green"], ["purple"], 3),
            // Wholly different lines have no matched words.
            ("alpha", "beta", ["alpha"], ["beta"], 0),
            // Separated changes become separate runs.
            ("let a = 1 + 2", "let b = 1 + 3", ["a", "2"], ["b", "3"], 4),
            // A whitespace-only difference changes nothing.
            ("let x = 1", "let x =  1", [], [], 4),
            // Consecutive changed words merge into one run.
            ("keep alpha beta end", "keep gamma delta end", ["alpha beta"], ["gamma delta"], 2),
        ]
        for c in cases {
            let highlight = DiffWords.highlight(old: c.old, new: c.new)
            XCTAssertEqual(text(c.old, highlight.old), c.oldRuns, c.old)
            XCTAssertEqual(text(c.new, highlight.new), c.newRuns, c.new)
            XCTAssertEqual(highlight.matched, c.matched, c.old)
        }
    }
}

final class DiffFoldsTests: XCTestCase {
    func testLeadingAndBetweenHunkGaps() {
        let cases: [(hunks: [DiffFolds.Hunk], gaps: [DiffFolds.Gap])] = [
            ([.init(oldStart: 2, oldCount: 3), .init(oldStart: 10, oldCount: 2)],
             [.init(count: 1, oldStart: 1, afterHunk: -1), .init(count: 5, oldStart: 5, afterHunk: 0)]),
            // A hunk starting at line 1 has no leading gap.
            ([.init(oldStart: 1, oldCount: 2)], []),
            // Adjacent hunks have no gap between them.
            ([.init(oldStart: 1, oldCount: 3), .init(oldStart: 4, oldCount: 2)], []),
            // A pure insertion (oldCount 0) counts from its insertion point.
            ([.init(oldStart: 4, oldCount: 0), .init(oldStart: 9, oldCount: 1)],
             [.init(count: 3, oldStart: 1, afterHunk: -1), .init(count: 4, oldStart: 5, afterHunk: 0)]),
        ]
        for (index, c) in cases.enumerated() {
            XCTAssertEqual(DiffFolds.gaps(c.hunks), c.gaps, "case \(index)")
        }
    }
}
