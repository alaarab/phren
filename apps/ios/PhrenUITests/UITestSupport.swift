import XCTest

extension XCTestCase {
    /// Attach a screenshot only when a design run asked for shots
    /// (`PHREN_UI_SHOTS=1`) or once this test has already failed, so an
    /// ordinary suite run does not pay for a capture at every step. Each test
    /// class keeps its own `capture(_:_:)` signature and delegates here.
    func attachUIScreenshot(_ app: XCUIApplication, _ name: String) {
        let wanted = ProcessInfo.processInfo.environment["PHREN_UI_SHOTS"] == "1"
        let failed = testRun?.hasSucceeded == false
        guard wanted || failed else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Open the pushed Memory graph screen from the Projects tab. The Explore
    /// list no longer carries a Memory graph row (the Memory tab is the graph
    /// now), so these tests go through the toolbar's More menu instead.
    @MainActor
    func openMemoryGraph(from app: XCUIApplication) {
        let more = app.buttons["More"]
        XCTAssertTrue(more.waitForExistence(timeout: 8), "Projects toolbar offers More")
        more.tap()
        // iOS exposes both the menu action and the obscured list shortcut.
        let item = app.buttons.matching(NSPredicate(format: "label == %@", "Memory graph"))
            .allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(item, "More menu offers Memory graph")
        item?.tap()
    }
}
