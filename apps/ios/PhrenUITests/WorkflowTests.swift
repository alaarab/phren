import XCTest

final class WorkflowTests: XCTestCase {
    @MainActor
    func testGlobalSearchPublishesLatestQueryAndClearsOldResults() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Search"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Search"].tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("offline")
        let finding = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Cache repeated requests for offline use")).firstMatch
        XCTAssertTrue(finding.waitForExistence(timeout: 8))
        field.buttons["Clear text"].tap()
        field.typeText("nomatchabcdef")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "No Results")).firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(finding.exists)
        field.buttons["Clear text"].tap()
        XCTAssertTrue(app.staticTexts["Search your memory"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testBacklogIsOptionalAndLongTasksStayScannable() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.tabBars.buttons["Review"].exists)
        app.tabBars.buttons["Tasks"].tap()
        app.buttons["task-status"].tap()
        app.buttons["Active"].tap()
        XCTAssertTrue(app.staticTexts["No active tasks"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["task-detail:sample/brain/demo/dead0001"].exists)
        let activeScreenshot = XCTAttachment(screenshot: app.screenshot())
        activeScreenshot.name = "Calm active tasks state"
        activeScreenshot.lifetime = .keepAlways
        add(activeScreenshot)
        app.buttons["View backlog (6)"].tap()
        let long = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(long.waitForExistence(timeout: 5))
        XCTAssertLessThan(long.frame.height, 180)
        XCTAssertLessThan(long.frame.minY - app.otherElements["task-controls"].frame.maxY, 32)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Scannable backlog with full task details on demand"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        long.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "END OF PLAN")).firstMatch.exists)
        app.navigationBars.buttons["Done"].tap()
        app.buttons["task-status"].tap()
        app.buttons["Active"].tap()
        XCTAssertTrue(app.staticTexts["No active tasks"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Settings"].tap()
        app.tabBars.buttons["Tasks"].tap()
        XCTAssertTrue(app.staticTexts["No active tasks"].waitForExistence(timeout: 5), "Tasks remembers the chosen workload view")
    }

    @MainActor
    func testCompactTaskControlsDatesSearchAndSorting() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Tasks"].tap()
        XCTAssertFalse(app.segmentedControls.buttons["Backlog"].exists)
        XCTAssertFalse(app.textFields["task-search-field"].exists)
        let controls = app.otherElements["task-controls"]
        XCTAssertLessThan(controls.frame.height, 58)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Created Jan 1, 2026")).firstMatch.exists)

        app.buttons["task-sort"].tap()
        app.buttons["Newest first"].tap()
        let recent = app.buttons["task-detail:sample/brain/demo/dead0002"]
        let old = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(recent.waitForExistence(timeout: 5))
        XCTAssertLessThan(recent.frame.minY, old.frame.minY)

        app.buttons["task-search-toggle"].tap()
        let search = app.textFields["task-search-field"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("short follow-up")
        XCTAssertTrue(recent.exists)
        XCTAssertFalse(old.exists)
        app.buttons["task-search-toggle"].tap()
        XCTAssertFalse(search.exists)

        app.buttons["task-filters"].tap()
        if app.buttons["Created"].exists { app.buttons["Created"].tap() }
        app.buttons["Date unknown"].tap()
        let unknown = app.buttons["task-detail:sample/brain/demo/dead0003"]
        XCTAssertTrue(unknown.waitForExistence(timeout: 5))
        XCTAssertFalse(recent.exists)
        XCTAssertTrue(app.staticTexts["Date unknown"].firstMatch.exists)
        unknown.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Date unknown"].exists)
        app.navigationBars.buttons["Done"].tap()
        app.buttons["task-filters"].tap()
        app.buttons["Clear filters"].tap()
        app.buttons["task-filters"].tap()
        if app.buttons["Priority"].exists { app.buttons["Priority"].tap() }
        app.buttons["High"].tap()
        XCTAssertTrue(old.waitForExistence(timeout: 5))
        XCTAssertFalse(recent.exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Compact task controls, creation dates and priority filtering"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["task-filters"].tap()
        app.buttons["Clear filters"].tap()
        app.buttons["task-sort"].tap()
        app.buttons["Task order"].tap()
    }

    @MainActor
    func testMoveSelectedTasksTogetherAndStartOneWithSwipe() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Tasks"].tap()
        let first = app.buttons["task-detail:sample/brain/demo/dead0001"]
        let second = app.buttons["task-detail:team/brain/demo/dead0001"]
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        app.buttons["task-selection-mode"].tap()
        first.tap(); second.tap()
        app.buttons["task-bulk-Start"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["task-bulk-Start"].exists)
        XCTAssertTrue(app.buttons["task-status"].label.contains("Active"))
        XCTAssertFalse(app.buttons["task-detail:sample/brain/demo/dead0002"].exists)
        app.buttons["task-selection-mode"].tap()
        app.buttons["Select all"].tap()
        app.buttons["task-bulk-Done"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["task-status"].label.contains("Done"))
        app.buttons["task-selection-mode"].tap()
        app.buttons["Select all"].tap()
        app.buttons["task-bulk-Backlog"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["task-status"].label.contains("Backlog"))
        first.swipeRight()
        app.buttons["Start"].firstMatch.tap()
        app.buttons["task-status"].tap()
        app.buttons["Active"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertFalse(second.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Created Jan 1, 2026")).firstMatch.exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Compact active workload after bulk moves and quick Start"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    @MainActor
    func testMaintenanceGroupsByStoreAndOffersAnAgentRequest() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Settings"].tap()
        let maintenance = app.buttons["Memory maintenance"]
        if !maintenance.isHittable { app.swipeUp() }
        XCTAssertTrue(maintenance.waitForExistence(timeout: 5))
        maintenance.tap()
        let personal = app.buttons["maintenance-project:sample/brain:demo"]
        let team = app.buttons["maintenance-project:team/brain:demo"]
        XCTAssertTrue(personal.waitForExistence(timeout: 5))
        XCTAssertTrue(team.exists)
        XCTAssertFalse(app.staticTexts["Candidate for team memory"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Optional maintenance grouped by project and store"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        team.tap()
        XCTAssertTrue(app.staticTexts["Candidate for team memory"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Candidate for sample memory"].exists)
        XCTAssertFalse(app.buttons["Triage"].exists)
        app.staticTexts["Candidate for team memory"].tap()
        XCTAssertTrue(app.navigationBars["Memory entry"].waitForExistence(timeout: 5))
        app.navigationBars["Memory entry"].buttons["Done"].tap()
        app.buttons["Copy request for my agent"].tap()
        XCTAssertTrue(app.buttons["Agent request copied"].waitForExistence(timeout: 5))
        app.buttons["Select"].tap()
        XCTAssertTrue(app.staticTexts["None selected"].waitForExistence(timeout: 5))
        app.staticTexts["Candidate for team memory"].tap()
        XCTAssertTrue(app.staticTexts["1 selected"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Memory entry"].exists)
        app.buttons["Select All"].tap()
        XCTAssertTrue(app.staticTexts["3 selected"].waitForExistence(timeout: 5))
        app.buttons["Deselect All"].tap()
        XCTAssertTrue(app.staticTexts["None selected"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Candidate for team memory"].exists)
    }
}
