import XCTest
@testable import PhrenKit

final class ChatScrollMetricsTests: XCTestCase {
    func testCorrectiveOffsetOnlyWhenPastTheEnd() {
        XCTAssertEqual(ChatScrollMetrics.correctiveOffset(ChatScrollMetrics(contentHeight: 3000, viewportHeight: 800, offsetY: 2600)), 2200)
        XCTAssertNil(ChatScrollMetrics.correctiveOffset(ChatScrollMetrics(contentHeight: 3000, viewportHeight: 800, offsetY: 2200)))
        XCTAssertNil(ChatScrollMetrics.correctiveOffset(ChatScrollMetrics(contentHeight: 3000, viewportHeight: 800, offsetY: 900)))
        XCTAssertNil(ChatScrollMetrics.correctiveOffset(ChatScrollMetrics(contentHeight: 3000, viewportHeight: 0, offsetY: 2600)), "No viewport yet means nothing to correct against")
        XCTAssertEqual(ChatScrollMetrics.correctiveOffset(ChatScrollMetrics(contentHeight: 500, viewportHeight: 800, offsetY: 40)), 0, "Short content dragged past zero by a stale pin comes back")
    }

    func testRepinFollowsGrowthAndPastEndOffsetsOnly() {
        let base = ChatScrollMetrics(contentHeight: 3000, viewportHeight: 800, offsetY: 2200)
        XCTAssertEqual(ChatScrollMetrics.shouldRepin(old: base, new: ChatScrollMetrics(contentHeight: 3200, viewportHeight: 800, offsetY: 2200), userDriven: false), 2400)
        XCTAssertNil(ChatScrollMetrics.shouldRepin(old: base, new: ChatScrollMetrics(contentHeight: 3000, viewportHeight: 500, offsetY: 2200), userDriven: false), "A keyboard shrinking the viewport is not transcript growth")
        XCTAssertEqual(ChatScrollMetrics.shouldRepin(old: base, new: ChatScrollMetrics(contentHeight: 3000, viewportHeight: 800, offsetY: 2900), userDriven: false), 2200)
        XCTAssertNil(ChatScrollMetrics.shouldRepin(old: base, new: ChatScrollMetrics(contentHeight: 3200, viewportHeight: 800, offsetY: 2200), userDriven: true))
    }
}
