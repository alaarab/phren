import XCTest
@testable import Phren

/// Holds the density pass's fixed measurements still. The before/after measure
/// is a count of fixed-height collapsed tool rows in an 800pt transcript
/// viewport; the screenshots themselves are covered by the UI suite.
final class ChatDensityTests: XCTestCase {
    func testChatChromeAndTranscriptMeasurements() {
        XCTAssertEqual(PhrenDensity.chatHeaderTop, 4)
        XCTAssertEqual(PhrenDensity.composerBottom, 4)
        XCTAssertEqual(PhrenDensity.transcriptRowSpacing, 6)
    }

    func testToolCardsStayCompact() {
        XCTAssertEqual(PhrenDensity.collapsedToolRowHeight, 44)
        XCTAssertEqual(PhrenDensity.toolCardPadding, 8)
        XCTAssertEqual(PhrenDensity.toolCardRowSpacing, PhrenTheme.Space.xs)
    }

    func testChangesScreenMeasurements() {
        XCTAssertEqual(PhrenDensity.changesRowHeight, 44)
        XCTAssertEqual(PhrenDensity.changesBandHeight, 40)
        XCTAssertEqual(PhrenDensity.changesIconTabHeight, 32)
        XCTAssertEqual(PhrenDensity.treeRowHeight, 32)
        XCTAssertEqual(PhrenDensity.treeIndent, 12)
    }

    /// A collapsed tool pill (44) plus the 6pt gap after it is a 50pt pitch,
    /// so an 800pt transcript fits 16 of them.
    func testCollapsedToolRowsThatFitInEightHundredPoints() {
        XCTAssertEqual(PhrenDensity.collapsedToolRowPitch, 50)
        XCTAssertEqual(PhrenDensity.collapsedToolRows(inHeight: 800), 16)
        XCTAssertEqual(PhrenDensity.collapsedToolRows(inHeight: 0), 0)
    }
}
