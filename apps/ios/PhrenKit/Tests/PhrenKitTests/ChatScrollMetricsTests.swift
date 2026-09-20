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

    func testClampNeverScrollsPastTheLaidOutEnd() {
        let metrics = ChatScrollMetrics(contentHeight: 3000, viewportHeight: 800, offsetY: 0)
        XCTAssertEqual(ChatScrollMetrics.clamp(5000, in: metrics), 2200, "A target beyond the content clamps to the real end")
        XCTAssertEqual(ChatScrollMetrics.clamp(1200, in: metrics), 1200, "A target inside the content is left alone")
        XCTAssertEqual(ChatScrollMetrics.clamp(-40, in: metrics), 0, "A target above the top clamps to zero")
        XCTAssertEqual(ChatScrollMetrics.clamp(500, in: ChatScrollMetrics(contentHeight: 400, viewportHeight: 800, offsetY: 0)), 0, "Short content has no scrollable end")
    }

    func testEstimateJumpOnlyForContentFarTallerThanTheViewport() {
        let base = ChatScrollMetrics(contentHeight: 1000, viewportHeight: 500, offsetY: 500)
        XCTAssertTrue(ChatScrollMetrics.isEstimateJump(old: base, new: ChatScrollMetrics(contentHeight: 4000, viewportHeight: 500, offsetY: 500)),
                      "A 4x jump in reported height is a lazy estimate, not real growth")
        XCTAssertFalse(ChatScrollMetrics.isEstimateJump(old: base, new: ChatScrollMetrics(contentHeight: 1300, viewportHeight: 500, offsetY: 500)),
                       "A normal append is followed")
        XCTAssertFalse(ChatScrollMetrics.isEstimateJump(old: base, new: ChatScrollMetrics(contentHeight: 600, viewportHeight: 500, offsetY: 500)),
                       "A shrink is not an estimate jump")
        XCTAssertFalse(ChatScrollMetrics.isEstimateJump(old: base, new: ChatScrollMetrics(contentHeight: 4000, viewportHeight: 0, offsetY: 500)),
                       "Without a viewport there is nothing to judge a jump against")
    }

    func testShrinkWhileSettlingFollowsTheNewBottom() {
        XCTAssertEqual(ChatScrollMetrics.correctiveOffset(ChatScrollMetrics(contentHeight: 2000, viewportHeight: 800, offsetY: 2200)), 1200,
                       "A lazy estimate that corrects downward pulls the offset back to the new bottom")
    }
}
