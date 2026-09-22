import XCTest

final class ScheduleEditorTests: XCTestCase {
    @MainActor
    func testCreatesDailyScheduleWithComputerHarnessAndModel() {
        let app = launchSchedules()
        app.buttons["schedule-add"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["schedule-editor"].waitForExistence(timeout: 5))

        let name = app.textFields["schedule-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText("Morning review")
        let prompt = app.descendants(matching: .any)["schedule-prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.tap()
        prompt.typeText("Review open work and summarize the next steps.")

        let project = app.buttons["schedule-project"]
        if project.exists {
            tap(project, in: app)
            app.buttons["schedule-project:demo"].tap()
        }
        tap(app.buttons["schedule-computer"], in: app)
        app.buttons["schedule-computer:Desk"].tap()
        tap(app.buttons["schedule-harness"], in: app)
        app.buttons["schedule-harness:codex"].tap()
        tap(app.buttons["schedule-model"], in: app)
        let model = app.buttons["schedule-model:gpt-5.6-sol"]
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        model.tap()
        tap(app.buttons["schedule-every:daily"], in: app)
        capture(app, "Schedule editor daily fields")
        app.buttons["schedule-save"].tap()

        let saved = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@", "Morning review", "Daily at 07:30"
        )).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 8))
    }

    @MainActor
    func testEditsDailyScheduleToWeeklyWithThreeDays() {
        let app = launchSchedules()
        let row = app.descendants(matching: .any)["schedule-row:7f3a2c1d"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["schedule-editor"].waitForExistence(timeout: 5))

        capture(app, "Schedule editor name and prompt")
        tap(app.buttons["schedule-every:weekly"], in: app)
        let tuesday = app.buttons["schedule-day:tue"]
        let thursday = app.buttons["schedule-day:thu"]
        tap(tuesday, in: app)
        tap(thursday, in: app)
        capture(app, "Schedule editor weekly fields")
        app.buttons["schedule-save"].tap()

        XCTAssertTrue(app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Mon, Wed, Fri")).firstMatch.waitForExistence(timeout: 8))
    }

    @MainActor
    func testHistoryShowsThreeRunsAndFailureReason() {
        let app = launchSchedules()
        let history = app.descendants(matching: .any)["schedule-history:7f3a2c1d"]
        XCTAssertTrue(history.waitForExistence(timeout: 8))
        history.tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))

        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "schedule-history-row:"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 8))
        XCTAssertEqual(rows.count, 3)
        capture(app, "Schedule run history")
        let failed = app.descendants(matching: .any)["schedule-history-row:history-failed"]
        XCTAssertTrue(failed.exists)
        XCTAssertTrue(failed.label.localizedCaseInsensitiveContains("failed: Tests failed"), failed.label)
    }

    @MainActor
    func testNotifyStartStaysOnAfterSavingAndReopening() {
        let app = launchSchedules()
        let row = app.descendants(matching: .any)["schedule-row:7f3a2c1d"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()

        // Notify is a drop-down of check rows now.
        let notify = app.buttons["schedule-notify"]
        XCTAssertTrue(notify.waitForExistence(timeout: 5))
        notify.tap()
        let start = app.buttons["schedule-notify:start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        XCTAssertFalse(start.isSelected)
        start.tap()
        XCTAssertTrue(start.isSelected)
        app.buttons["schedule-notify-done"].tap()
        app.buttons["schedule-save"].tap()

        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()
        let reopened = app.buttons["schedule-notify"]
        XCTAssertTrue(reopened.waitForExistence(timeout: 5))
        reopened.tap()
        let reopenedStart = app.buttons["schedule-notify:start"]
        XCTAssertTrue(reopenedStart.waitForExistence(timeout: 5))
        XCTAssertTrue(reopenedStart.isSelected)
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }

    @MainActor
    private func launchSchedules() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ui-testing", "--automatic-sessions-fixture", "--native-chat-fixture",
            "--schedules-fixture", "-phren-tab", "agents",
        ]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        openSessionsAction("schedules", in: app)
        XCTAssertTrue(app.navigationBars["Schedules"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor
    private func tap(_ element: XCUIElement, in app: XCUIApplication) {
        let scroll = app.scrollViews["schedule-editor-scroll"]
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        for _ in 0..<8 where !element.isHittable { scroll.swipeUp(velocity: .slow) }
        XCTAssertTrue(element.isHittable)
        element.tap()
    }
}
