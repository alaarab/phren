import XCTest

/// The one agents Live Activity, as SpringBoard draws it: the expanded island
/// and the lock screen, led by a request with Deny and Approve.
final class FleetActivityUITests: XCTestCase {
    @MainActor
    func testFleetActivityLeadsWithTheRequestOnTheIslandAndLockScreen() throws {
        guard ProcessInfo.processInfo.environment["PHREN_UI_TEST_LIVE_ACTIVITY"] == "1" else {
            throw XCTSkip("Set PHREN_UI_TEST_LIVE_ACTIVITY=1 on a simulator runner with Live Activities enabled; SpringBoard's presentation is not deterministic in shared simulator runs.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--fleet-activity-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        allowLiveActivities(springboard)
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.025)).press(forDuration: 1.5)
        XCTAssertTrue(springboard.buttons["Approve"].waitForExistence(timeout: 10))
        XCTAssertTrue(springboard.buttons["Deny"].exists)
        XCTAssertTrue(springboard.staticTexts["3 working · 1 needs you · 2 computers"].exists)
        shot("Fleet island expanded")

        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        sleep(2)
        XCUIDevice.shared.press(.home)
        allowLiveActivities(springboard)
        XCTAssertTrue(springboard.staticTexts["Claude needs approval"].waitForExistence(timeout: 10))
        XCTAssertTrue(springboard.staticTexts["3 working · 1 needs you · 2 computers"].exists)
        shot("Fleet lock screen")
    }

    /// A fresh simulator asks once whether phren may show Live Activities.
    @MainActor private func allowLiveActivities(_ springboard: XCUIApplication) {
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
    }

    @MainActor private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
