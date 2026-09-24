import XCTest
@testable import PhrenKit

final class DiffWordsTests: XCTestCase {
    private func text(_ string: String, _ ranges: [Range<String.Index>]) -> [String] {
        ranges.map { String(string[$0]) }
    }

    func testOneWordEditHighlightsJustThatWord() {
        let old = "let accent = green", new = "let accent = purple"
        let highlight = DiffWords.highlight(old: old, new: new)
        XCTAssertEqual(text(old, highlight.old), ["green"])
        XCTAssertEqual(text(new, highlight.new), ["purple"])
        XCTAssertEqual(highlight.matched, 3)
    }

    func testWhollyDifferentLinesHaveNoMatchedWords() {
        let old = "alpha", new = "beta"
        let highlight = DiffWords.highlight(old: old, new: new)
        XCTAssertEqual(text(old, highlight.old), ["alpha"])
        XCTAssertEqual(text(new, highlight.new), ["beta"])
        XCTAssertEqual(highlight.matched, 0)
    }

    func testSeparatedChangesBecomeSeparateRuns() {
        let old = "let a = 1 + 2", new = "let b = 1 + 3"
        let highlight = DiffWords.highlight(old: old, new: new)
        XCTAssertEqual(text(old, highlight.old), ["a", "2"])
        XCTAssertEqual(text(new, highlight.new), ["b", "3"])
        XCTAssertEqual(highlight.matched, 4)
    }

    func testWhitespaceOnlyDifferenceChangesNothing() {
        let old = "let x = 1", new = "let x =  1"
        let highlight = DiffWords.highlight(old: old, new: new)
        XCTAssertTrue(highlight.old.isEmpty); XCTAssertTrue(highlight.new.isEmpty)
        XCTAssertEqual(highlight.matched, 4)
    }

    func testConsecutiveChangedWordsMergeIntoOneRun() {
        let old = "keep alpha beta end", new = "keep gamma delta end"
        let highlight = DiffWords.highlight(old: old, new: new)
        XCTAssertEqual(text(old, highlight.old), ["alpha beta"])
        XCTAssertEqual(text(new, highlight.new), ["gamma delta"])
        XCTAssertEqual(highlight.matched, 2)
    }
}

final class DiffFoldsTests: XCTestCase {
    func testLeadingAndBetweenHunkGaps() {
        let gaps = DiffFolds.gaps([.init(oldStart: 2, oldCount: 3), .init(oldStart: 10, oldCount: 2)])
        XCTAssertEqual(gaps, [.init(count: 1, oldStart: 1, afterHunk: -1),
                              .init(count: 5, oldStart: 5, afterHunk: 0)])
    }

    func testHunkStartingAtOneHasNoLeadingGap() {
        XCTAssertTrue(DiffFolds.gaps([.init(oldStart: 1, oldCount: 2)]).isEmpty)
    }

    func testAdjacentHunksHaveNoGap() {
        XCTAssertTrue(DiffFolds.gaps([.init(oldStart: 1, oldCount: 3), .init(oldStart: 4, oldCount: 2)]).isEmpty)
    }

    func testPureInsertionHunkCountsFromItsInsertionPoint() {
        let gaps = DiffFolds.gaps([.init(oldStart: 4, oldCount: 0), .init(oldStart: 9, oldCount: 1)])
        XCTAssertEqual(gaps, [.init(count: 3, oldStart: 1, afterHunk: -1),
                              .init(count: 4, oldStart: 5, afterHunk: 0)])
    }
}