import XCTest

/// The grouped Tasks backlog: one section per project ordered by open
/// count (api 8 open sits above demo 6 even though demo shows more backlog
/// rows), Active and Queue chips with a non-zero active count, folding per
/// project and from the top All control, folds remembered across relaunch,
/// and the existing filters still running inside the sections.
final class TasksTests: XCTestCase {
    @MainActor
    func testGroupingOrderCountsAndCollapse() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()

        let api = app.buttons["tasks-section-toggle:api"]
        let demo = app.buttons["tasks-section-toggle:demo"]
        XCTAssertTrue(api.waitForExistence(timeout: 5))
        XCTAssertTrue(demo.waitForExistence(timeout: 5))
        XCTAssertLessThan(api.frame.minY, demo.frame.minY,
                          "Ordered by open count (8 vs 6), not by visible backlog rows (2 vs 6)")

        func sectionMarker(_ project: String) -> XCUIElement {
            app.descendants(matching: .any).matching(identifier: "tasks-section:\(project)").firstMatch
        }
        XCTAssertTrue(sectionMarker("api").waitForExistence(timeout: 3))
        XCTAssertTrue(sectionMarker("demo").exists)

        XCTAssertTrue(api.label.contains("6 active"), api.label)
        XCTAssertTrue(api.label.contains("2 queue"), api.label)
        XCTAssertTrue(demo.label.contains("0 active"), demo.label)
        XCTAssertTrue(demo.label.contains("6 queue"), demo.label)

        let demoRow = app.buttons["task-detail:sample/brain/demo/dead0001"]
        let apiRow = app.buttons["task-detail:sample/brain/api/dead0201"]
        XCTAssertTrue(demoRow.waitForExistence(timeout: 5))
        XCTAssertTrue(apiRow.waitForExistence(timeout: 5))
        attachUIScreenshot(app, "Tasks grouped")

        // Folding one project leaves the other open; tapping it again unfolds.
        demo.tap()
        XCTAssertTrue(demoRow.waitForNonExistence(timeout: 2))
        XCTAssertTrue(apiRow.exists)
        demo.tap()
        XCTAssertTrue(demoRow.waitForExistence(timeout: 5))

        // All folds every visible section together, then unfolds them.
        app.buttons["tasks-section-all"].tap()
        XCTAssertTrue(demoRow.waitForNonExistence(timeout: 2))
        XCTAssertTrue(apiRow.waitForNonExistence(timeout: 2))
        XCTAssertTrue(demo.exists, "Folded headers stay put")
        attachUIScreenshot(app, "Tasks collapsed")
        app.buttons["tasks-section-all"].tap()
        XCTAssertTrue(demoRow.waitForExistence(timeout: 5))
        XCTAssertTrue(apiRow.exists)

        // Search still filters inside the sections: a section with no
        // matches disappears, the matching one keeps its header and chips.
        app.buttons["task-search-toggle"].tap()
        let search = app.textFields["task-search-field"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("short follow-up")
        XCTAssertTrue(api.waitForNonExistence(timeout: 2))
        XCTAssertTrue(demo.waitForExistence(timeout: 5))
        XCTAssertTrue(demo.label.contains("6 queue"), "Counts ignore the search")
        XCTAssertTrue(app.buttons["task-detail:sample/brain/demo/dead0002"].exists)
        XCTAssertTrue(demoRow.waitForNonExistence(timeout: 2))
    }

    /// A fold written to AppStorage survives leaving the tab and relaunching
    /// the app; a project that was never folded stays open.
    @MainActor
    func testFoldedSectionsAreRemembered() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()

        let demo = app.buttons["tasks-section-toggle:demo"]
        let demoRow = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(demo.waitForExistence(timeout: 5))
        XCTAssertTrue(demoRow.waitForExistence(timeout: 5))
        demo.tap()
        XCTAssertTrue(demoRow.waitForNonExistence(timeout: 2))

        app.launchArguments = ["--ui-testing", "--workflow-fixture", "--tasks-keep-collapsed"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()
        XCTAssertTrue(demo.waitForExistence(timeout: 5))
        XCTAssertTrue(demoRow.waitForNonExistence(timeout: 2), "The fold is remembered")
        XCTAssertTrue(app.buttons["task-detail:sample/brain/api/dead0201"].exists,
                      "A project that was never folded stays open")
        XCTAssertTrue(demo.label.contains("6 queue"), "Chips still report the folded section")
    }
}
