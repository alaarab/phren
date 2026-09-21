import XCTest

final class WhatsNewTests: XCTestCase {
    /// The running version's changelog section comes up once after an update,
    /// and the whole changelog lives under Settings → About.
    @MainActor
    func testWhatsNewSheetAndChangelogInSettings() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--whats-new"]
        app.launch()
        let sheet = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "What's new in ")).firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["NEW"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Memory is map or list")).firstMatch.exists)
        app.buttons["whats-new-done"].tap()
        XCTAssertFalse(sheet.waitForExistence(timeout: 1))
        app.tabBars.buttons["Settings"].tap()
        let row = app.descendants(matching: .any).matching(identifier: "settings-whats-new").firstMatch
        for _ in 0..<6 where !row.exists || !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(app.navigationBars["What's new"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["1.0.0"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["0.0.7"].exists)
        XCTAssertTrue(app.staticTexts["Earlier"].exists)
    }
}
