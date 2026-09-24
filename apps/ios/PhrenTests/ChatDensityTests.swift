import XCTest
@testable import Phren

/// Holds the density pass's fixed measurements still. The before/after measure
/// is a count of fixed-height collapsed tool rows in an 800pt transcript
/// viewport; the screenshots themselves are covered by the UI suite.
final class ChatDensityTests: XCTestCase {
    func testChatChromeAndTranscriptMeasurements() {
        XCTAssertEqual(PhrenDensity.chatHeaderTop, 4)
        XCTAssertEqual(PhrenDensity.composerBottom, 4)
        XCTAssertEqual(PhrenDensity.composerAboveKeyboard, 10)
        XCTAssertEqual(PhrenDensity.transcriptRowSpacing, 6)
    }

    func testToolCardsStayCompact() {
        XCTAssertEqual(PhrenDensity.collapsedToolRowHeight, 36)
        // The drawn pill is 36 points; its touch target still reaches 44.
        XCTAssertEqual(PhrenDensity.collapsedToolRowHeight + 2 * PhrenDensity.toolRowTouchOutset, 44)
        XCTAssertEqual(PhrenDensity.toolCardPadding, 6)
        XCTAssertEqual(PhrenDensity.toolCardRowSpacing, 2)
    }

    func testChangesScreenMeasurements() {
        XCTAssertEqual(PhrenDensity.changesRowHeight, 44)
        XCTAssertEqual(PhrenDensity.changesBandHeight, 40)
        XCTAssertEqual(PhrenDensity.changesIconTabHeight, 32)
        XCTAssertEqual(PhrenDensity.treeRowHeight, 32)
        XCTAssertEqual(PhrenDensity.treeIndent, 12)
    }

    /// A collapsed tool pill (36) plus the 6pt gap after it is a 42pt pitch,
    /// so an 800pt transcript fits 19 of them (16 at the old 44pt pill).
    func testCollapsedToolRowsThatFitInEightHundredPoints() {
        XCTAssertEqual(PhrenDensity.collapsedToolRowPitch, 42)
        XCTAssertEqual(PhrenDensity.collapsedToolRows(inHeight: 800), 19)
        XCTAssertEqual(PhrenDensity.collapsedToolRows(inHeight: 0), 0)
    }
}
