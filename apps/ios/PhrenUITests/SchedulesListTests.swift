import XCTest

final class SchedulesListTests: XCTestCase {
    @MainActor
    func testProjectSchedulesCanPauseRunAndDelete() {
        let app = launch(tab: "projects")
        let project = app.buttons["project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()

        let entry = app.buttons["project-schedules-row"]
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        entry.tap()

        let daily = row(app, "7f3a2c1d")
        let weekly = row(app, "8a4b3c2d")
        XCTAssertTrue(daily.waitForExistence(timeout: 5))
        XCTAssertTrue(weekly.waitForExistence(timeout: 5))
        XCTAssertTrue(daily.label.contains("Daily at 07:30"), daily.label)
        XCTAssertTrue(weekly.label.contains("Weekdays at 07:30"), weekly.label)

        capture(app, "Schedules project list")
        weekly.swipeLeft()
        let pause = app.buttons["schedule-pause:8a4b3c2d"]
        XCTAssertTrue(pause.waitForExistence(timeout: 3))
        pause.tap()
        XCTAssertTrue(waitFor(row(app, "8a4b3c2d"), labelContains: "paused"))

        app.buttons["schedule-run:7f3a2c1d"].tap()
        XCTAssertTrue(waitFor(daily, value: "running"))

        weekly.swipeLeft()
        app.buttons["schedule-delete:8a4b3c2d"].tap()
        let confirm = app.buttons["schedule-delete-confirm:8a4b3c2d"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 3))
        confirm.tap()
        XCTAssertTrue(waitForDisappearance(weekly))
    }

    @MainActor
    func testAllSchedulesAreGroupedByProject() {
        let app = launch(tab: "agents", extra: ["--automatic-sessions-fixture"])
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Agents"].tap()

        let all = app.buttons["schedules-all"]
        XCTAssertTrue(all.waitForExistence(timeout: 5))
        all.tap()

        let daily = row(app, "7f3a2c1d")
        let weekly = row(app, "8a4b3c2d")
        XCTAssertTrue(daily.waitForExistence(timeout: 5))
        XCTAssertTrue(weekly.exists)
        let once = row(app, "9b5c4d3e")
        XCTAssertTrue(once.exists)
        XCTAssertTrue(daily.label.contains("Daily at 07:30"), daily.label)
        XCTAssertTrue(weekly.label.contains("Weekdays at 07:30"), weekly.label)
        XCTAssertTrue(once.label.contains("Once, Sep 21 at 09:00"), once.label)
        XCTAssertTrue(once.label.contains("done"), once.label)
        capture(app, "Schedules all projects")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "demo")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "other")).firstMatch.exists)
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    @MainActor
    private func launch(tab: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--schedules-fixture", "-phren-tab", tab] + extra
        app.launch()
        return app
    }

    private func row(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)["schedule-row:\(id)"]
    }

    @MainActor
    private func waitFor(_ element: XCUIElement, labelContains text: String) -> Bool {
        let predicate = NSPredicate { _, _ in element.exists && element.label.localizedCaseInsensitiveContains(text) }
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 5) == .completed
    }

    @MainActor
    private func waitFor(_ element: XCUIElement, value: String) -> Bool {
        let predicate = NSPredicate { _, _ in element.exists && (element.value as? String) == value }
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 5) == .completed
    }

    @MainActor
    private func waitForDisappearance(_ element: XCUIElement) -> Bool {
        let predicate = NSPredicate(format: "exists == false")
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: 5) == .completed
    }
}
