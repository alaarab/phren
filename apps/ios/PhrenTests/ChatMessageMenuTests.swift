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
}
