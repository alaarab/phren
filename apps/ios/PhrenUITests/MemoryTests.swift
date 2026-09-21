import XCTest

final class MemoryTests: XCTestCase {
    @MainActor
    func testMemoryTabReplacesSearchAndSearchSelectsANode() {
        let app = launch()
        XCTAssertFalse(app.tabBars.buttons["Search"].exists, "the Search tab is gone")
        XCTAssertTrue(app.tabBars.buttons["Memory"].exists)
        capture(app, "Memory contents")

        let field = app.textFields["memory-search"]
        field.tap()
        field.typeText("idempotency")
        let row = app.buttons["memory-row:finding:1a2b3c4d"]
        XCTAssertTrue(row.waitForExistence(timeout: 8), "the ledger finding is a result")
        XCTAssertTrue(app.staticTexts["memory-section:ledger"].exists, "results across projects are grouped by project")
        XCTAssertTrue(app.keyboards.element.waitForNonExistence(timeout: 5), "completed results dismiss the keyboard")
        expectation(for: NSPredicate(format: "value == %@", "full"), evaluatedWith: panel(app))
        waitForExpectations(timeout: 5)
        capture(app, "Memory results")

        row.tap()
        let selected = app.descendants(matching: .any)["memory-selected-row"]
        XCTAssertTrue(selected.waitForExistence(timeout: 10), "the dossier opens")
        XCTAssertTrue(selected.label.contains("Idempotency keys"), "the native dossier row identifies the selected finding")
        XCTAssertEqual(panel(app).value as? String, "collapsed", "the panel collapses under the dossier")
        XCTAssertTrue(app.buttons["Zoom in"].isHittable, "the graph stays interactive")
        capture(app, "Memory dossier")

        app.buttons["memory-show-in-list"].tap()
        XCTAssertTrue(selected.waitForNonExistence(timeout: 5), "Show in list closes the dossier")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.isHittable, "the list is scrolled to the row")
        XCTAssertEqual(panel(app).value as? String, "full", "the list opens full so the row has room")
        XCTAssertEqual(field.value as? String, "Search memory", "the query is cleared")
        capture(app, "Memory show in list")
    }

    @MainActor
    func testProjectChipNarrowsCountsAndContentChipsFilter() {
        let app = launch()
        let counts = app.staticTexts["memory-panel-counts"]
        XCTAssertTrue(counts.waitForExistence(timeout: 10))
        XCTAssertEqual(counts.label, "40 findings · 9 tasks · 6 topics")

        app.buttons["memory-scope:ledger"].tap()
        expectation(for: NSPredicate(format: "label == %@", "14 findings · 3 tasks · 6 topics"), evaluatedWith: counts)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(app.buttons["memory-row:finding:1a2b3c4d"].waitForExistence(timeout: 5), "findings come first, newest first")

        app.buttons["memory-filter:tasks"].tap()
        XCTAssertTrue(app.buttons["memory-row:task:70a7b8c9"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["memory-row:finding:1a2b3c4d"].exists, "Tasks hides findings")
        capture(app, "Memory ledger tasks")

        app.buttons["memory-filter:findings"].tap()
        XCTAssertTrue(app.buttons["memory-row:finding:1a2b3c4d"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "memory-row:task:")).firstMatch.exists,
                       "Findings hides tasks")

        app.buttons["memory-filter:topics"].tap()
        let topic = app.buttons["memory-row:topic:pitfall"]
        XCTAssertTrue(topic.waitForExistence(timeout: 5))
        capture(app, "Memory ledger topics")
        topic.tap()
        XCTAssertTrue(app.buttons["memory-row:finding:1a2b3c4d"].waitForExistence(timeout: 5), "a topic narrows to its findings")
        XCTAssertFalse(app.buttons["memory-row:finding:2b3c4d5e"].exists)
        app.buttons["memory-topic-clear"].tap()
        XCTAssertTrue(app.buttons["memory-row:finding:2b3c4d5e"].waitForExistence(timeout: 5))

        app.buttons["memory-scope:hub"].tap()
        XCTAssertTrue(app.staticTexts["memory-empty"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["memory-empty"].label, "Nothing saved for hub yet")
        capture(app, "Memory empty project")
    }

    @MainActor
    func testTaskRowActionMovesToDoneAndTheTasksTabAgrees() {
        let app = launch()
        let scope = app.buttons["memory-scope:phren"]
        scope.tap()
        expectation(for: NSPredicate(format: "selected == true"), evaluatedWith: scope)
        waitForExpectations(timeout: 5)
        let tasks = app.buttons["memory-filter:tasks"]
        tasks.tap()
        expectation(for: NSPredicate(format: "selected == true"), evaluatedWith: tasks)
        waitForExpectations(timeout: 5)
        let row = app.buttons["memory-row:task:10a1b2c3"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        // Under the Tasks filter the section chip is folded away, so the row reads by its text.
        XCTAssertTrue(row.label.contains("Fix the queue strip"))
        let actionButton = app.buttons["memory-row:task:10a1b2c3:actions"]
        XCTAssertTrue(actionButton.waitForExistence(timeout: 5))
        XCTAssertTrue(actionButton.isHittable)
        XCTAssertGreaterThanOrEqual(actionButton.frame.height, 44)
        actionButton.tap()
        let done = app.buttons["memory-actions:done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "the row actions offer Done")
        XCTAssertGreaterThanOrEqual(done.frame.height, 44)
        capture(app, "Memory task actions")
        done.tap()
        // A finished task sorts below the open ones, so the lazy list may no
        // longer draw this row; either it reads Done or it has left the view.
        expectation(for: NSPredicate(format: "exists == false OR label CONTAINS %@", "Done"), evaluatedWith: row)
        waitForExpectations(timeout: 10)

        app.tabBars.buttons["Tasks"].tap()
        XCTAssertTrue(app.buttons["task-status"].waitForExistence(timeout: 10))
        app.buttons["task-status"].tap()
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["task-detail:sample/brain/phren/10a1b2c3"].waitForExistence(timeout: 10),
                      "the Tasks tab lists the task under Done")
    }

    @MainActor
    func testPanelHeightsFollowTapsAndDrags() {
        let app = launch()
        let panel = panel(app)
        XCTAssertEqual(panel.value as? String, "half")
        let counts = app.staticTexts["memory-panel-counts"]
        XCTAssertTrue(counts.waitForExistence(timeout: 10))
        counts.tap()
        expectation(for: NSPredicate(format: "value == %@", "full"), evaluatedWith: panel)
        waitForExpectations(timeout: 5)
        capture(app, "Memory panel full")
        let start = counts.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 500)))
        expectation(for: NSPredicate(format: "value == %@", "collapsed"), evaluatedWith: panel)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(app.buttons["Zoom in"].isHittable)
        capture(app, "Memory panel collapsed")
    }

    @MainActor
    func testStaleStoreOffersPull() {
        let app = launch()
        XCTAssertFalse(app.buttons["memory-stale"].exists, "the synced store shows no stale dot")
        app.buttons["memory-store"].tap()
        let team = app.buttons["memory-store-sheet:team/brain"]
        XCTAssertTrue(team.waitForExistence(timeout: 5))
        team.tap()
        XCTAssertTrue(app.buttons["memory-scope:demo"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["memory-stale"].waitForExistence(timeout: 10), "a store that never synced shows the amber dot")
        XCTAssertTrue(app.buttons["memory-stale"].label.contains("not synced"))
        capture(app, "Memory stale store")
    }

    @MainActor
    func testAccessibilityXXXLLaysOut() {
        let app = launch(extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let chip = app.buttons["memory-scope:phren"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(chip.frame.height, 44)
        XCTAssertTrue(app.staticTexts["memory-panel-counts"].waitForExistence(timeout: 10))
        capture(app, "Memory XXXL")
        app.staticTexts["memory-panel-counts"].tap()
        XCTAssertTrue(app.buttons["memory-filter:tasks"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["memory-row:finding:a0000001"].waitForExistence(timeout: 5))
        capture(app, "Memory XXXL full")
    }

    @MainActor
    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--memory-fixture"] + extra
        for _ in 0..<2 {
            app.launch()
            if app.tabBars.buttons["Memory"].waitForExistence(timeout: 15) { break }
            app.terminate()
        }
        app.tabBars.buttons["Memory"].tap()
        XCTAssertTrue(app.textFields["memory-search"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["PHREN"].firstMatch.waitForExistence(timeout: 30), "the graph renders the store")
        return app
    }

    @MainActor
    private func panel(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "memory-panel").firstMatch
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
