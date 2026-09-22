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
}
