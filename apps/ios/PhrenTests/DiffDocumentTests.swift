import XCTest
@testable import Phren

final class DiffDocumentTests: XCTestCase {
    func testChangeBlocksPairRemovedWithAddedAndTintOnlyTheDifference() {
        let document = DiffDocument(patch: "@@ -1,3 +1,3 @@\n import SwiftUI\n-let accent = green\n+let accent = purple\n let radius = 12")
        XCTAssertEqual(document.changeStarts, [2])
        XCTAssertEqual(document.added, 1); XCTAssertEqual(document.removed, 1)
        let removed = document.rows[2], added = document.rows[3]
        XCTAssertEqual(removed.change, 0); XCTAssertEqual(added.change, 0); XCTAssertNil(document.rows[1].change)
        XCTAssertEqual(removed.inner.map { String(removed.text[$0]) }, "green")
        XCTAssertEqual(added.inner.map { String(added.text[$0]) }, "purple")
        XCTAssertEqual(DiffRowView.spoken(added), "+let accent = purple")
        XCTAssertEqual(String(DiffRowView.attributed(added).characters), "let accent = purple")
    }

    func testWhollyDifferentLinesGetNoInnerRangeAndLoneAdditionsAreABlock() {
        let document = DiffDocument(patch: "@@ -1,2 +1,3 @@\n-alpha\n+zzzzzzzzzzzz\n context\n+new line")
        XCTAssertEqual(document.changeStarts, [1, 4])
        XCTAssertNil(document.rows[1].inner); XCTAssertNil(document.rows[2].inner)
        XCTAssertEqual(document.rows[4].change, 1)
    }

    func testSplitAlignsRemovedBesideAddedAndPadsTheShorterSide() {
        let document = DiffDocument(patch: "@@ -1,3 +1,2 @@\n-one\n-two\n+uno\n keep")
        let split = document.split
        XCTAssertEqual(split.count, 4) // hunk, one|uno, two|—, keep|keep
        XCTAssertEqual(split[1].left?.text, "-one"); XCTAssertEqual(split[1].right?.text, "+uno")
        XCTAssertEqual(split[2].left?.text, "-two"); XCTAssertNil(split[2].right)
        XCTAssertEqual(split[3].left?.text, " keep"); XCTAssertEqual(split[3].right?.text, " keep")
    }

    func testStatusLettersFollowGitPorcelain() {
        XCTAssertEqual(DiffStatusBadge.letter(" M").0, "M")
        XCTAssertEqual(DiffStatusBadge.letter("A ").0, "A")
        XCTAssertEqual(DiffStatusBadge.letter(" D").0, "D")
        XCTAssertEqual(DiffStatusBadge.letter("R ").0, "R")
        XCTAssertEqual(DiffStatusBadge.letter("??").0, "U")
    }
}
