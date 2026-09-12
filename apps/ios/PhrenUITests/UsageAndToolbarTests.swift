import XCTest

final class UsageAndToolbarTests: XCTestCase {
    @MainActor
    func testUsageShowsBothProvidersPercentagesAndResetTimes() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--account-usage-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Agents"].tap()
        let usage = app.buttons["all-account-usage"]
        XCTAssertTrue(usage.waitForExistence(timeout: 10)); usage.tap()
        XCTAssertTrue(app.staticTexts["Codex"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Claude"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "23.5% used")).count, 2)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "41.2% used")).count, 2)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Resets ")).firstMatch.exists)
        XCTAssertTrue(app.buttons["Refresh usage"].isHittable)
        capture(app, "Claude and Codex account usage")
    }

    @MainActor
    func testTerminalControlsCanBeAddedAndPersistAcrossLaunches() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture"]
        app.launch()
        openToolbar(app)
        restoreDefaults(app)
        let add = app.buttons["toolbar-add:enter"]
        scrollTo(add, in: app)
        XCTAssertTrue(add.isEnabled); add.tap()
        let selected = app.descendants(matching: .any).matching(identifier: "toolbar-selected:enter").firstMatch
        XCTAssertTrue(selected.exists)
        app.terminate(); app.launch()
        openToolbar(app)
        XCTAssertTrue(selected.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "toolbar-selected:keyboard").firstMatch.exists)
        capture(app, "Custom terminal toolbar")
        restoreDefaults(app)
        XCTAssertFalse(selected.exists)
    }

    @MainActor private func openToolbar(_ app: XCUIApplication) {
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-terminal-toolbar"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.navigationBars["Terminal toolbar"].waitForExistence(timeout: 5))
    }
    @MainActor private func restoreDefaults(_ app: XCUIApplication) {
        let restore = app.buttons["toolbar-restore-defaults"]
        scrollTo(restore, in: app); restore.tap()
        for _ in 0..<5 { app.swipeDown() }
    }
    @MainActor private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<10 where !element.isHittable { app.swipeUp() }
        XCTAssertTrue(element.isHittable)
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
