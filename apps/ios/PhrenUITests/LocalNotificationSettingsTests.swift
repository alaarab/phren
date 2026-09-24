import XCTest

final class LocalNotificationSettingsTests: XCTestCase {
    @MainActor
    func testNotificationSectionAndBothPhrenSwitches() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-notifications"]
        for _ in 0..<12 {
            if row.exists && !row.frame.isEmpty && row.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(row.isHittable)
        row.tap()
        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["notifications-local-section"].firstMatch.exists)
        for id in ["notifications-approvals", "notifications-schedules"] {
            let control = app.descendants(matching: .any)[id].firstMatch
            XCTAssertTrue(control.waitForExistence(timeout: 3))
            let before = control.value as? String
            control.tap()
            let expected = before == "On" ? "Off" : "On"
            XCTAssertTrue(control.waitForExistence(timeout: 3))
            XCTAssertEqual(control.value as? String, expected)
            control.tap()
            XCTAssertEqual(control.value as? String, before)
        }
    }

    /// Moshi's shape: one summary line, how alerts show while open, where a
    /// tap goes, and a test notification.
    @MainActor
    func testSummaryFollowsTheChoicesAndATestCanBeSent() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-notifications"]
        for _ in 0..<12 where !(row.exists && !row.frame.isEmpty && row.isHittable) { app.swipeUp() }
        row.tap()
        let summary = app.staticTexts["notifications-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 5))
        // Each choice from its picker sheet; the sheet closes before the next.
        func choose(_ field: String, _ option: String) {
            let control = app.descendants(matching: .any)[field].firstMatch
            for _ in 0..<4 where !(control.exists && control.isHittable) { app.swipeUp() }
            control.tap()
            let row = app.buttons["\(field):\(option)"]
            XCTAssertTrue(row.waitForExistence(timeout: 3), "\(field):\(option)")
            row.tap()
            XCTAssertTrue(row.waitForNonExistence(timeout: 3))
        }
        func summaryText() -> String {
            for _ in 0..<4 where !summary.isHittable { app.swipeDown() }
            return summary.label
        }
        choose("notifications-while-open", "quiet")
        choose("notifications-tap-opens", "agents")
        XCTAssertTrue(app.buttons["notifications-send-test"].exists)
        attachUIScreenshot(app, "Notifications settings")
        XCTAssertTrue(summaryText().hasPrefix("Open: Quiet"), summary.label)
        XCTAssertTrue(summary.label.hasSuffix("Tap: Agents"), summary.label)
        // Back to the defaults for the other tests.
        choose("notifications-tap-opens", "chat")
        choose("notifications-while-open", "alert")
        XCTAssertTrue(summaryText().hasPrefix("Open: Alert"), summary.label)
        XCTAssertTrue(summary.label.hasSuffix("Tap: Chat"), summary.label)
    }

    /// `--hook-health-fixture`: Desk has an APNs key, Linuxbox does not.
    @MainActor
    func testNamesTheComputerWithoutAnAPNsKey() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--hook-health-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-notifications"]
        for _ in 0..<12 {
            if row.exists && !row.frame.isEmpty && row.isHittable { break }
            app.swipeUp()
        }
        row.tap()
        let notice = app.descendants(matching: .any)["notifications-push-unconfigured"].firstMatch
        _ = notice.waitForExistence(timeout: 6)
        for _ in 0..<4 where !notice.exists { app.swipeUp() }
        XCTAssertTrue(notice.waitForExistence(timeout: 6))
        XCTAssertTrue(notice.label.contains("Instant alerts need an APNs key on"), notice.label)
        XCTAssertTrue(notice.label.contains("Linuxbox"), notice.label)
        XCTAssertFalse(notice.label.contains("Desk"), notice.label)
    }
}
