import XCTest
import SwiftUI
@testable import Phren

final class ChatMessageMenuTests: XCTestCase {
    func testMenuFlipsWithoutCoveringMessageAndFitsLongMessages() {
        let bounds = CGRect(x: 8, y: 8, width: 374, height: 700)
        let nearTop = CGRect(x: 12, y: 30, width: 366, height: 100)
        let nearBottom = CGRect(x: 12, y: 560, width: 366, height: 120)
        let size = CGSize(width: 320, height: 292)
        let below = ChatMessageMenuLayout(bounds: bounds, source: nearTop, menuSize: size)
        XCTAssertGreaterThan(below.menu.minY, below.preview.maxY)
        let above = ChatMessageMenuLayout(bounds: bounds, source: nearBottom, menuSize: size)
        XCTAssertLessThan(above.menu.maxY, above.preview.minY)
        for source in [nearTop, nearBottom, CGRect(x: 12, y: -400, width: 366, height: 2_000)] {
            for height in [292.0, 900.0] {
                let layout = ChatMessageMenuLayout(bounds: bounds, source: source, menuSize: CGSize(width: 320, height: height))
                XCTAssertTrue(bounds.contains(layout.preview))
                XCTAssertTrue(bounds.contains(layout.menu))
                XCTAssertFalse(layout.preview.intersects(layout.menu))
                XCTAssertGreaterThan(layout.preview.height, 0)
            }
        }
    }

    @MainActor
    func testHoldRightAfterAScrollDoesNotOpenTheMenu() {
        let menu = ChatMessageMenu()
        XCTAssertTrue(menu.acceptsHold())
        menu.noteUserScroll()
        XCTAssertFalse(menu.acceptsHold(), "A hold that began while scrolling is not a hold")
        XCTAssertFalse(menu.acceptsHold(now: .now + ChatMessageMenu.holdDuration), "Nor one that began as the scroll stopped")
        XCTAssertTrue(menu.acceptsHold(now: .now + ChatMessageMenu.holdDuration + 0.2))
    }

    @MainActor
    func testTheTapThatEndsAHoldIsRecognised() {
        let menu = ChatMessageMenu()
        let start = Date()
        XCTAssertFalse(menu.tapEndsAHold(now: start))
        menu.notePress(true, now: start)
        XCTAssertFalse(menu.tapEndsAHold(now: start + 0.1), "A short press is a tap")
        XCTAssertTrue(menu.tapEndsAHold(now: start + 0.7), "Still pressing past the hold")
        menu.notePress(false, now: start + 0.7)
        XCTAssertTrue(menu.tapEndsAHold(now: start + 0.75), "Just lifted from a hold")
        XCTAssertFalse(menu.tapEndsAHold(now: start + 2), "A later tap dismisses again")
        menu.notePress(true, now: start + 3)
        menu.notePress(false, now: start + 3.1)
        XCTAssertFalse(menu.tapEndsAHold(now: start + 3.1))
    }
}
