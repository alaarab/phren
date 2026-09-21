import XCTest

final class WorkflowTests: XCTestCase {
    @MainActor
    func testProjectsAndExploreRowsKeepACompactGroupedLayout() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Projects"].tap()
        let project = app.buttons["project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        XCTAssertLessThanOrEqual(project.frame.height, 60)
        let graph = app.buttons["Memory graph"].firstMatch
        XCTAssertTrue(graph.exists)
        XCTAssertLessThanOrEqual(graph.frame.height, 60)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Compact grouped projects and Explore rows"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    @MainActor
    func testGlobalSearchPublishesLatestQueryAndClearsOldResults() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Memory"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Memory"].tap()
        let field = app.textFields["memory-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("offline")
        let finding = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Cache repeated requests for offline use")).firstMatch
        XCTAssertTrue(finding.waitForExistence(timeout: 8))
        app.buttons["memory-search:clear"].tap()
        field.tap(); field.typeText("nomatchabcdef")
        XCTAssertTrue(app.staticTexts["No matches"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(finding.exists)
        app.buttons["memory-search:clear"].tap()
        XCTAssertTrue(app.staticTexts["memory-panel-counts"].waitForExistence(timeout: 5))
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
        let group = app.buttons["tasks-project:demo"]
        XCTAssertTrue(group.exists)
        XCTAssertLessThan(group.frame.minY - app.buttons["task-status"].frame.maxY, 32)
        XCTAssertLessThan(long.frame.minY - group.frame.maxY, 32)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Scannable backlog with full task details on demand"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        long.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "END OF PLAN")).firstMatch.exists)
        app.navigationBars["Task details"].buttons.element(boundBy: 0).tap()
        app.buttons["task-status"].tap()
        app.buttons["Active"].tap()
        XCTAssertTrue(app.staticTexts["No active tasks"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Settings"].tap()
        app.tabBars.buttons["Tasks"].tap()
        XCTAssertTrue(app.staticTexts["No active tasks"].waitForExistence(timeout: 5), "Tasks remembers the chosen workload view")
    }

    @MainActor
    func testTaskDetailsCanStartAnAgentAndActivateTheTask() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture", "--automatic-sessions-fixture", "--native-chat-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Tasks"].tap()
        let task = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(task.waitForExistence(timeout: 8)); task.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        let start = app.buttons["task-start-agent"]
        XCTAssertTrue(start.waitForExistence(timeout: 5)); start.tap()
        XCTAssertTrue(app.buttons["launch-computer:A1000000-0000-0000-0000-000000000001"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["launch-harness:codex"].exists)
        app.swipeUp()
        let launch = app.buttons["launch-open"]
        XCTAssertTrue(launch.waitForExistence(timeout: 5)); XCTAssertTrue(launch.label.contains("on task")); launch.tap()
        let close = app.buttons["chat-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Work on this Phren task")).firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Keep the full plan available from task details.")).firstMatch.exists)
        close.tap()
        XCTAssertTrue(app.buttons["launch-open"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        app.navigationBars["Task details"].buttons.element(boundBy: 0).tap()
        app.buttons["task-status"].tap(); app.buttons["Active"].tap()
        XCTAssertTrue(task.waitForExistence(timeout: 5), "A backlog task becomes active only after its prompt is delivered")
    }

    @MainActor
    func testTaskStaysInBacklogWhenAgentPromptDeliveryFails() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture", "--automatic-sessions-fixture", "--native-chat-fixture", "--chat-send-fails"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 15)); app.tabBars.buttons["Tasks"].tap()
        let task = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(task.waitForExistence(timeout: 8)); task.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        app.buttons["task-start-agent"].tap()
        XCTAssertTrue(app.buttons["launch-computer:A1000000-0000-0000-0000-000000000001"].waitForExistence(timeout: 5))
        app.swipeUp()
        let launch = app.buttons["launch-open"]
        XCTAssertTrue(launch.waitForExistence(timeout: 5)); launch.tap()
        XCTAssertTrue(app.staticTexts["Couldn't open session"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "task remains in Backlog")).firstMatch.exists)
        app.buttons["OK"].tap(); app.buttons["Cancel"].tap()
        app.navigationBars["Task details"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(task.waitForExistence(timeout: 5))
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
        let status = app.buttons["task-status"]
        let sort = app.buttons["task-sort"]
        XCTAssertLessThan(sort.frame.maxY - status.frame.minY, 58)
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
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Date unknown")).firstMatch.waitForExistence(timeout: 3))
        app.navigationBars["Task details"].buttons.element(boundBy: 0).tap()
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
        app.navigationBars["Memory entry"].buttons.element(boundBy: 0).tap()
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
