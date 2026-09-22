import XCTest

/// Grouped Tasks: Open orders by open count (api 8 above demo 6), while
/// Backlog orders by queue count (demo 6 above api 2). Count chips, folding per
/// project and from the top All control, folds remembered across relaunch,
/// and the existing filters still running inside the sections.
final class TasksTests: XCTestCase {
    @MainActor
    func testRowAndSwipeStartOpenLaunchSheetAndCancelKeepsBacklog() {
        let app = launchTaskFixture()
        let task = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(task.waitForExistence(timeout: 5))

        app.buttons["task-actions:sample/brain/demo/dead0001"].tap()
        let start = app.buttons["task-actions-sheet:start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["task-actions-sheet:move-active"].exists)
        start.tap()
        assertTaskLaunchAndCancel(in: app)
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Backlog")
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["task-move-notice"].exists)

        task.swipeRight()
        let swipeStart = app.buttons["task-swipe-start:sample/brain/demo/dead0001"]
        XCTAssertTrue(swipeStart.waitForExistence(timeout: 5))
        swipeStart.tap()
        assertTaskLaunchAndCancel(in: app)
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Backlog")
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["task-move-notice"].exists)
        chooseTaskStatus("active", in: app)
        XCTAssertTrue(task.waitForNonExistence(timeout: 5), "Cancel must never move the task to Active")
    }

    @MainActor
    func testMoveToActiveAndDoneExplainWhereTheTaskWentAndOfferFollow() {
        let app = launchTaskFixture()
        let task = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        app.buttons["task-actions:sample/brain/demo/dead0001"].tap()
        let move = app.buttons["task-actions-sheet:move-active"]
        XCTAssertTrue(move.waitForExistence(timeout: 5))
        XCTAssertEqual(move.label, "Move to Active")
        move.tap()

        let notice = app.staticTexts["task-move-notice"]
        let follow = app.buttons["task-move-follow"]
        XCTAssertTrue(notice.waitForExistence(timeout: 5))
        XCTAssertEqual(notice.label, "Moved to Active")
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Backlog")
        XCTAssertTrue(task.waitForNonExistence(timeout: 3))
        XCTAssertFalse(app.buttons["launch-cancel"].exists, "Bookkeeping does not open an agent")
        XCTAssertEqual(follow.label, "View Active")
        attachUIScreenshot(app, "Task moved to Active with a way to follow")
        follow.tap()
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Active")
        revealByScrolling(task, in: app)
        XCTAssertTrue(task.waitForExistence(timeout: 5))

        app.buttons["task-select:sample/brain/demo/dead0001"].tap()
        XCTAssertTrue(notice.waitForExistence(timeout: 5))
        XCTAssertEqual(notice.label, "Moved to Done")
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Active")
        XCTAssertTrue(task.waitForNonExistence(timeout: 3))
        XCTAssertEqual(follow.label, "View Done")
        follow.tap()
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Done")
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        XCTAssertFalse(notice.exists)
        app.buttons["task-actions:sample/brain/demo/dead0001"].tap()
        XCTAssertTrue(app.buttons["task-actions-sheet:move-active"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["task-actions-sheet:start"].exists, "Reopen completed work with a move")
    }

    @MainActor
    func testStartIsAvailableForOneSelectedTaskAndAbsentForSeveral() {
        let app = launchTaskFixture()
        let first = app.buttons["task-detail:sample/brain/demo/dead0001"]
        let second = app.buttons["task-detail:sample/brain/demo/dead0002"]
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        app.buttons["task-selection-mode"].tap()
        first.tap()
        let start = app.buttons["task-bulk-Start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.tap()
        assertTaskLaunchAndCancel(in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue(start.waitForExistence(timeout: 5), "Cancel preserves the single selection")
        revealByScrolling(second, in: app)
        second.tap()
        XCTAssertTrue(start.waitForNonExistence(timeout: 3))
        XCTAssertFalse(app.buttons["task-actions:sample/brain/demo/dead0001"].exists)
        XCTAssertTrue(app.buttons["task-bulk-Move to Active"].isEnabled)
        XCTAssertTrue(app.buttons["task-bulk-Done"].isEnabled)
        XCTAssertTrue(app.buttons["task-bulk-Backlog"].exists)
        attachUIScreenshot(app, "Several selected tasks offer moves only")
        app.buttons["task-bulk-Move to Active"].tap()
        XCTAssertTrue(app.staticTexts["task-move-notice"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["task-move-notice"].label, "2 tasks moved to Active")
        app.buttons["task-move-follow"].tap()
        revealByScrolling(first, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        revealByScrolling(second, in: app)
        XCTAssertTrue(second.waitForExistence(timeout: 5))
    }

    @MainActor
    func testRowStartDeliversTaskThenMovesItToActive() {
        let app = launchTaskFixture()
        let task = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        app.buttons["task-actions:sample/brain/demo/dead0001"].tap()
        XCTAssertTrue(app.buttons["task-actions-sheet:start"].waitForExistence(timeout: 5))
        app.buttons["task-actions-sheet:start"].tap()
        XCTAssertTrue(app.buttons["launch-harness:codex"].waitForExistence(timeout: 5))
        app.buttons["launch-harness:codex"].tap()
        let launch = app.buttons["launch-open"]
        for _ in 0..<6 where !launch.isHittable { app.swipeUp() }
        XCTAssertTrue(launch.isEnabled)
        launch.tap()
        let close = app.buttons["chat-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Work on this Phren task")).firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Store: sample/brain")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Project: demo")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Keep the full plan available from task details.")).firstMatch.exists)
        close.tap()
        XCTAssertTrue(app.buttons["launch-cancel"].waitForExistence(timeout: 5))
        app.buttons["launch-cancel"].tap()
        XCTAssertTrue(app.staticTexts["task-move-notice"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["task-move-notice"].label, "Moved to Active")
        XCTAssertEqual(app.buttons["tasks-status"].value as? String, "Backlog")
        XCTAssertTrue(task.waitForNonExistence(timeout: 3))
        app.buttons["task-move-follow"].tap()
        revealByScrolling(task, in: app)
        XCTAssertTrue(task.waitForExistence(timeout: 5))
    }

    @MainActor
    private func launchTaskFixture() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture", "--automatic-sessions-fixture", "--native-chat-fixture"]
        app.launch()
        waitForWorkflowStore(in: app)
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()
        chooseTaskStatus("backlog", in: app)
        return app
    }

    @MainActor
    private func assertTaskLaunchAndCancel(in app: XCUIApplication) {
        XCTAssertTrue(app.navigationBars["Open demo"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["launch-computer"].exists)
        XCTAssertTrue(app.buttons["launch-harness:codex"].exists)
        XCTAssertTrue(app.buttons["launch-cancel"].exists)
        app.buttons["launch-cancel"].tap()
    }

    @MainActor
    func testGroupingOrderCountsAndCollapse() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--workflow-fixture"]
        app.launch()
        waitForWorkflowStore(in: app)
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()

        let api = app.descendants(matching: .any).matching(identifier: "tasks-section-toggle:api").firstMatch
        let demo = app.descendants(matching: .any).matching(identifier: "tasks-section-toggle:demo").firstMatch
        XCTAssertTrue(api.waitForExistence(timeout: 5))
        XCTAssertTrue(api.label.contains("6 active"), api.label)
        XCTAssertTrue(api.label.contains("2 queue"), api.label)
        // Folding api makes both headers visible while preserving Open order.
        api.tap()
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

        chooseTaskStatus("backlog", in: app)
        XCTAssertTrue(demo.waitForExistence(timeout: 5))
        // Backlog orders by queue count. Fold demo to expose api's header.
        demo.tap()
        XCTAssertTrue(api.waitForExistence(timeout: 5))
        XCTAssertLessThan(demo.frame.minY, api.frame.minY)
        api.tap()
        demo.tap()

        let demoRow = app.buttons["task-detail:sample/brain/demo/dead0001"]
        let apiRow = app.buttons["task-detail:sample/brain/api/dead0201"]
        XCTAssertTrue(demoRow.waitForExistence(timeout: 5))
        // The list is lazy: api's rows sit below demo's six and only exist
        // once scrolled near the viewport.
        revealByScrolling(apiRow, in: app)
        XCTAssertTrue(apiRow.waitForExistence(timeout: 5))
        attachUIScreenshot(app, "Tasks grouped")
        scrollToTop(in: app, until: demo)

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
        revealByScrolling(apiRow, in: app)
        XCTAssertTrue(apiRow.exists)
        scrollToTop(in: app, until: demo)

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
        waitForWorkflowStore(in: app)
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()
        chooseTaskStatus("backlog", in: app)

        let demo = app.descendants(matching: .any).matching(identifier: "tasks-section-toggle:demo").firstMatch
        let demoRow = app.buttons["task-detail:sample/brain/demo/dead0001"]
        XCTAssertTrue(demo.waitForExistence(timeout: 5))
        XCTAssertTrue(demoRow.waitForExistence(timeout: 5))
        demo.tap()
        XCTAssertTrue(demoRow.waitForNonExistence(timeout: 2))

        app.launchArguments = ["--ui-testing", "--workflow-fixture", "--tasks-keep-collapsed"]
        app.launch()
        waitForWorkflowStore(in: app)
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Tasks"].tap()
        chooseTaskStatus("backlog", in: app)
        XCTAssertTrue(demo.waitForExistence(timeout: 5))
        XCTAssertTrue(demoRow.waitForNonExistence(timeout: 2), "The fold is remembered")
        XCTAssertTrue(app.buttons["task-detail:sample/brain/api/dead0201"].exists,
                      "A project that was never folded stays open")
        XCTAssertTrue(demo.label.contains("6 queue"), "Chips still report the folded section")
    }

    /// Swipes the screen up until the lazy list has materialized the element
    /// (or gives up after a screenful of tries); swipes back down afterwards
    /// are the caller's business.
    @MainActor
    private func scrollToTop(in app: XCUIApplication, until element: XCUIElement) {
        for _ in 0..<8 where !element.isHittable { app.swipeDown(velocity: .slow) }
    }

    @MainActor
    private func revealByScrolling(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<8 where !element.isHittable { app.swipeUp(velocity: .slow) }
    }
}
