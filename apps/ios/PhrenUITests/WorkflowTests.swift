import XCTest

final class WorkflowTests: XCTestCase {
    /// Grouped sections can push a row past the first screen; scroll until
    /// it is in the tree. Never swipe down: the list pulls to refresh at the
    /// top.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 8) {
        for _ in 0..<attempts where !element.isHittable { app.swipeUp() }
    }

    @MainActor
    func testProjectsLayoutAndMemorySearch() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Memory"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Memory"].tap()
        app.buttons["memory-mode:list"].tap()
        XCTAssertTrue(app.staticTexts["memory-counts"].waitForExistence(timeout: 8))
        app.buttons["memory-search-toggle"].tap()
        let field = app.textFields["memory-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("offline")
        let finding = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Cache repeated requests for offline use")).firstMatch
        XCTAssertTrue(finding.waitForExistence(timeout: 8))
        app.buttons["memory-search:clear"].tap()
        XCTAssertFalse(field.waitForExistence(timeout: 3), "clearing the field slides it away")
        app.buttons["memory-search-toggle"].tap()
        let again = app.textFields["memory-search"]
        XCTAssertTrue(again.waitForExistence(timeout: 5))
        again.tap(); again.typeText("nomatchabcdef")
        XCTAssertTrue(app.staticTexts["No matches"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(finding.exists)
        app.buttons["memory-search:clear"].tap()
        XCTAssertTrue(app.staticTexts["memory-counts"].waitForExistence(timeout: 5))

        // The Projects grid leads, and Memory owns Files.
        app.tabBars.buttons["Projects"].tap()
        let project = app.buttons["project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        XCTAssertLessThanOrEqual(project.frame.height, 60)
        XCTAssertFalse(app.buttons["Files"].exists)
        attachUIScreenshot(app, "Projects grid leads the screen")
        XCTAssertFalse(app.buttons["projects-more"].exists)
        app.tabBars.buttons["Memory"].tap()
        let files = app.buttons["memory-files"]
        XCTAssertTrue(files.waitForExistence(timeout: 5))
        files.tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testBacklogIsOptionalAndLongTasksStayScannable() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        waitForWorkflowStore(in: app)
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.tabBars.buttons["Review"].exists)
        app.tabBars.buttons["Tasks"].tap()
        app.buttons["tasks-status"].tap()
        app.buttons["tasks-status:active"].tap()
        // Active work lives in api; demo's backlog rows stay out of the way.
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "tasks-section-toggle:api").firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["task-detail:sample/brain/demo/dead0001"].exists)
        attachUIScreenshot(app, "Calm active tasks state")
        app.buttons["tasks-status"].tap()
        app.buttons["tasks-status:backlog"].tap()
        let long = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(long.waitForExistence(timeout: 5))
        XCTAssertLessThan(long.frame.height, 180)
        let all = app.buttons["tasks-section-all"]
        XCTAssertTrue(all.exists)
        XCTAssertLessThan(all.frame.minY - app.buttons["tasks-status"].frame.maxY, 32)
        let group = app.descendants(matching: .any).matching(identifier: "tasks-section-toggle:demo").firstMatch
        XCTAssertTrue(group.exists)
        // Compare both headers on screen, without asking an off-screen
        // List row for a frame. Folding does not change project order.
        group.tap()
        let api = app.descendants(matching: .any).matching(identifier: "tasks-section-toggle:api").firstMatch
        XCTAssertTrue(api.waitForExistence(timeout: 5))
        XCTAssertLessThan(group.frame.minY, api.frame.minY,
                          "Backlog orders sections by queue count (demo 6, api 2)")
        group.tap()
        XCTAssertTrue(long.waitForExistence(timeout: 5))
        XCTAssertLessThan(group.frame.minY, long.frame.minY)
        XCTAssertLessThan(long.frame.minY - group.frame.maxY, 32)
        attachUIScreenshot(app, "Scannable backlog with full task details on demand")
        long.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "END OF PLAN")).firstMatch.exists)
        app.navigationBars["Task details"].buttons.element(boundBy: 0).tap()
        app.buttons["tasks-status"].tap()
        app.buttons["tasks-status:active"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "tasks-section-toggle:api").firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["task-detail:sample/brain/demo/dead0001"].exists)
        app.tabBars.buttons["Settings"].tap()
        app.tabBars.buttons["Tasks"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "tasks-section-toggle:api").firstMatch.waitForExistence(timeout: 5),
                      "Tasks remembers the chosen workload view")
    }

    @MainActor
    func testTaskDetailsCanStartAnAgentAndActivateTheTask() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture", "--automatic-sessions-fixture", "--native-chat-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()
        chooseTaskStatus("backlog", in: app)
        let task = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(task.waitForExistence(timeout: 8)); task.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        let start = app.buttons["task-start-agent"]
        XCTAssertTrue(start.waitForExistence(timeout: 5)); start.tap()
        let chooser = app.buttons["launch-computer"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 5)); chooser.tap()
        XCTAssertTrue(app.buttons["launch-computer:A1000000-0000-0000-0000-000000000001"].waitForExistence(timeout: 5))
        app.buttons["launch-computer-done"].tap()
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
        app.buttons["tasks-status"].tap(); app.buttons["tasks-status:active"].tap()
        reveal(task, in: app)
        XCTAssertTrue(task.waitForExistence(timeout: 5), "A backlog task becomes active only after its prompt is delivered")
    }

    @MainActor
    func testTaskStaysInBacklogWhenAgentPromptDeliveryFails() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture", "--automatic-sessions-fixture", "--native-chat-fixture", "--chat-send-fails"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8)); app.tabBars.buttons["Tasks"].tap()
        chooseTaskStatus("backlog", in: app)
        let task = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(task.waitForExistence(timeout: 8)); task.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        app.buttons["task-start-agent"].tap()
        let chooser = app.buttons["launch-computer"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 5)); chooser.tap()
        XCTAssertTrue(app.buttons["launch-computer:A1000000-0000-0000-0000-000000000001"].waitForExistence(timeout: 5))
        app.buttons["launch-computer-done"].tap()
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
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()
        chooseTaskStatus("backlog", in: app)
        XCTAssertFalse(app.segmentedControls.buttons["Backlog"].exists)
        XCTAssertFalse(app.textFields["task-search-field"].exists)
        let status = app.buttons["tasks-status"]
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
        let unknownDate = app.buttons["task-filters-sheet:age-Date unknown"]
        let filters = app.scrollViews["task-filters-sheet:scroll"]
        for _ in 0..<8 where !unknownDate.isHittable { filters.swipeUp() }
        XCTAssertTrue(unknownDate.isHittable)
        unknownDate.tap()
        let unknown = app.buttons["task-detail:sample/brain/demo/dead0003"]
        XCTAssertTrue(unknown.waitForExistence(timeout: 5))
        XCTAssertFalse(recent.exists)
        XCTAssertTrue(app.staticTexts["Date unknown"].firstMatch.exists)
        unknown.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Date unknown")).firstMatch.waitForExistence(timeout: 3))
        app.navigationBars["Task details"].buttons.element(boundBy: 0).tap()
        app.buttons["task-filters"].tap()
        tapTaskFilter("clear", in: app)
        app.buttons["task-filters"].tap()
        tapTaskFilter("priority-high", in: app)
        XCTAssertTrue(old.waitForExistence(timeout: 5))
        XCTAssertFalse(recent.exists)
        attachUIScreenshot(app, "Compact task controls, creation dates and priority filtering")
        app.buttons["task-filters"].tap()
        tapTaskFilter("clear", in: app)
        app.buttons["task-sort"].tap()
        app.buttons["Task order"].tap()
    }

    @MainActor
    func testMoveSelectedTasksTogetherAndMoveOneToActive() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()
        chooseTaskStatus("backlog", in: app)
        let first = app.buttons["task-detail:sample/brain/demo/dead0001"]
        let second = app.buttons["task-detail:team/brain/demo/dead0001"]
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        app.buttons["task-selection-mode"].tap()
        first.tap()
        if !second.isHittable { app.swipeUp() }
        second.tap()
        XCTAssertFalse(app.buttons["task-bulk-Start"].exists, "Several tasks can move together, but cannot start agents together")
        app.buttons["task-bulk-Move to Active"].tap()
        XCTAssertTrue(app.staticTexts["task-move-notice"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["task-move-notice"].label, "2 tasks moved to Active")
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Backlog")
        app.buttons["task-move-follow"].tap()
        reveal(first, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["task-bulk-Start"].exists)
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Active")
        XCTAssertFalse(app.buttons["task-detail:sample/brain/demo/dead0002"].exists)
        app.buttons["task-selection-mode"].tap()
        app.buttons["Select all"].tap()
        app.buttons["task-bulk-Done"].tap()
        XCTAssertTrue(app.buttons["task-move-follow"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["task-move-follow"].label, "View Done")
        app.buttons["task-move-follow"].tap()
        reveal(first, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Done")
        app.buttons["task-selection-mode"].tap()
        app.buttons["Select all"].tap()
        app.buttons["task-bulk-Backlog"].tap()
        XCTAssertTrue(app.buttons["task-move-follow"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["task-move-follow"].label, "View Backlog")
        app.buttons["task-move-follow"].tap()
        reveal(first, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Backlog")
        app.buttons["task-actions:sample/brain/demo/dead0001"].tap()
        XCTAssertTrue(app.buttons["task-actions-sheet:move-active"].waitForExistence(timeout: 5))
        app.buttons["task-actions-sheet:move-active"].tap()
        XCTAssertTrue(app.staticTexts["task-move-notice"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["task-move-notice"].label, "Moved to Active")
        app.buttons["task-move-follow"].tap()
        reveal(first, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertFalse(second.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Created Jan 1, 2026")).firstMatch.exists)
        attachUIScreenshot(app, "Compact active workload after bulk moves and Move to Active")
    }

    @MainActor
    private func tapTaskFilter(_ id: String, in app: XCUIApplication) {
        let option = app.buttons["task-filters-sheet:\(id)"]
        let scroll = app.scrollViews["task-filters-sheet:scroll"]
        for _ in 0..<8 where !option.isHittable { scroll.swipeUp() }
        XCTAssertTrue(option.isHittable)
        option.tap()
    }

    @MainActor
    func testMaintenanceGroupsByStoreAndOffersAnAgentRequest() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
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
        attachUIScreenshot(app, "Optional maintenance grouped by project and store")
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
