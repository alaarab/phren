import XCTest

final class SelectionSheetTests: XCTestCase {
    @MainActor
    func testLongMultiSelectSearchChipsAndCount() {
        let app = multiSelect(long: true)
        let done = app.buttons["controls-multiselect-done"]
        XCTAssertEqual(done.label, "Done (0)")
        app.buttons["controls-multiselect:project-1"].tap()
        app.buttons["controls-multiselect:project-2"].tap()
        XCTAssertEqual(done.label, "Done (2)")
        let search = app.textFields["controls-multiselect-search"]
        search.tap()
        search.typeText("22")
        let match = app.buttons["controls-multiselect:project-22"]
        XCTAssertTrue(match.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["controls-multiselect:project-1"].exists)
        XCTAssertTrue(app.buttons["controls-multiselect-chip:project-1"].isHittable)
        match.tap()
        XCTAssertTrue(match.isSelected)
        XCTAssertEqual(done.label, "Done (3)")
        app.buttons["controls-multiselect-chip:project-1"].tap()
        XCTAssertEqual(done.label, "Done (2)")
        XCTAssertFalse(app.buttons["controls-multiselect-chip:project-1"].exists)
        attachUIScreenshot(app, "Search keeps chosen project chips and Done count")
        app.buttons["controls-multiselect-all"].tap()
        XCTAssertEqual(done.label, "Done (22)", "All applies beyond the filtered results")
        app.buttons["controls-multiselect-none"].tap()
        XCTAssertEqual(done.label, "Done (0)")
        done.tap()
        XCTAssertTrue(done.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["controls-next"].isHittable)
    }

    @MainActor
    func testShortMultiSelectFitsItsRowsWithoutSearchOrEmptyScrollSpace() {
        let app = multiSelect(long: false)
        XCTAssertFalse(app.textFields["controls-multiselect-search"].exists)
        let first = app.buttons["controls-multiselect:Findings"]
        let last = app.buttons["controls-multiselect:Topics"]
        let done = app.buttons["controls-multiselect-done"]
        XCTAssertEqual(first.frame.height, 40, accuracy: 1)
        XCTAssertLessThan(done.frame.maxY - first.frame.minY, 245)
        XCTAssertLessThanOrEqual(done.frame.minY - last.frame.maxY, 16)
        last.tap()
        XCTAssertTrue(app.buttons["controls-multiselect-chip:Topics"].isHittable)
        XCTAssertEqual(done.label, "Done (1)")
        attachUIScreenshot(app, "Four kind multi select fits content")
    }

    @MainActor
    func testFiftyComputerChooserOrdersByReachabilityAndRecency() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--project-chooser-fixture", "-phren-tab", "projects"]
        app.launch()
        let project = app.buttons["project:sample/brain:phone"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.press(forDuration: 0.5)
        let prefix = "project-agent-sheet:sample/brain:phone:D1000000-0000-0000-0000-"
        let recent = app.buttons["project-agent-sheet:recent"]
        let linux = app.buttons[prefix + "000000000001"]
        let desk = app.buttons[prefix + "000000000000"]
        let unused = app.buttons[prefix + "000000000003"]
        XCTAssertTrue(linux.waitForExistence(timeout: 8))
        XCTAssertTrue(waitUntilEnabled(linux))
        XCTAssertTrue(recent.label.contains("Open on Linuxbox"))
        XCTAssertLessThan(recent.frame.minY, linux.frame.minY)
        XCTAssertLessThan(linux.frame.minY, desk.frame.minY)
        XCTAssertLessThan(desk.frame.minY, unused.frame.minY)
        XCTAssertTrue(linux.label.contains("Idle · 1 session"))
        XCTAssertTrue(desk.label.contains("Working · 2 sessions"))
        XCTAssertFalse(desk.label.contains("phone"), "Project and store belong to the sheet title")
        attachUIScreenshot(app, "Computer chooser recent and reachable first")
        let search = app.textFields["project-agent-sheet:search"]
        search.tap()
        search.typeText("Desk02")
        let offline = app.buttons[prefix + "000000000002"]
        XCTAssertTrue(offline.waitForExistence(timeout: 5))
        XCTAssertFalse(offline.isEnabled)
        XCTAssertTrue(offline.label.contains("Offline"))
        XCTAssertTrue(offline.label.contains("SSH connection refused."))
        XCTAssertFalse(linux.exists)
        attachUIScreenshot(app, "Offline computer remains searchable with reason")
    }

    @MainActor
    private func multiSelect(long: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--controls-fixture", "--controls-page", "options",
                               "--controls-presentation", long ? "long-multi" : "multi"]
        app.launch()
        XCTAssertTrue(app.buttons["controls-multiselect-done"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    private func waitUntilEnabled(_ element: XCUIElement) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)], timeout: 8) == .completed
    }
}
