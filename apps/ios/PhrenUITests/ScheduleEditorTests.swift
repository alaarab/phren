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

        let project = app.buttons["schedule-project:demo"]
        if project.exists { tap(project, in: app) }
        tap(app.buttons["schedule-computer:Desk"], in: app)
        tap(app.buttons["schedule-harness:codex"], in: app)
        let model = app.buttons["schedule-model:gpt-5.6-sol"]
        tap(model, in: app)
        tap(app.buttons["Daily"], in: app)
        app.buttons["schedule-save"].tap()

        let saved = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@", "Morning review", "Daily at 07:30"
        )).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 8))
    }

    @MainActor
    func testEditsDailyScheduleToWeeklyWithTwoDays() {
        let app = launchSchedules()
        let row = app.descendants(matching: .any)["schedule-row:7f3a2c1d"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["schedule-editor"].waitForExistence(timeout: 5))

        tap(app.buttons["Weekly"], in: app)
        let tuesday = app.buttons["schedule-day:tue"]
        let thursday = app.buttons["schedule-day:thu"]
        tap(tuesday, in: app)
        tap(thursday, in: app)
        app.buttons["schedule-save"].tap()

        XCTAssertTrue(app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Mon, Wed, Fri")).firstMatch.waitForExistence(timeout: 8))
    }

    @MainActor
    func testHistoryShowsThreeRunsAndFailureReason() {
        let app = launchSchedules()
        let history = app.buttons.matching(NSPredicate(
            format: "identifier == %@ OR label CONTAINS[c] %@", "schedule-history:7f3a2c1d", "ago"
        )).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 8))
        history.tap()

        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "schedule-history-row:"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 8))
        XCTAssertEqual(rows.count, 3)
        XCTAssertTrue(app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "failed:")).firstMatch.exists)
    }

    @MainActor
    private func launchSchedules() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ui-testing", "--automatic-sessions-fixture", "--native-chat-fixture",
            "--schedules-fixture", "-phren-tab", "agents",
        ]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Agents"].tap()
        let schedules = app.buttons["schedules-all"]
        XCTAssertTrue(schedules.waitForExistence(timeout: 10))
        schedules.tap()
        XCTAssertTrue(app.navigationBars["Schedules"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor
    private func tap(_ element: XCUIElement, in app: XCUIApplication) {
        let scroll = app.scrollViews["schedule-editor-scroll"]
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        for _ in 0..<8 where !element.isHittable { scroll.swipeUp() }
        XCTAssertTrue(element.isHittable)
        element.tap()
    }
}
