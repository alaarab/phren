import XCTest

/// What every chat UI test class shares: launching the app into the fixture
/// computer's chat, attaching the test image, and the screenshot and raw-JSON
/// helpers. Holds no tests of its own.
class AgentChatUITestCase: XCTestCase {
    @MainActor func attachImage(_ app: XCUIApplication) {
        app.buttons["Add attachment"].tap()
        XCTAssertTrue(app.buttons["Add test image"].waitForExistence(timeout: 5))
        app.buttons["Add test image"].tap()
    }

    @MainActor
    func launch(extra: [String] = [], chat: String = "live-chat:w7:w7:t9") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"] + extra
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        // The first launch of a test run sometimes comes up before the fixture
        // bootstrap finishes (no computers, no memory) and stays that way; a
        // relaunch always lands. Real launches are unaffected.
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
            app.tabBars.buttons["Agents"].tap()
            // The list's rows are lazy: the Computers section is only in the
            // tree once scrolled to, which at accessibility text sizes takes
            // many screens of session cards.
            let revealed = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "live-host:")).firstMatch
            if revealed.waitForExistence(timeout: attempt == 0 ? 12 : 25) || app.staticTexts["agents-introduction"].exists == false { break }
            if attempt == 0 { app.terminate() }
        }
        for _ in 0..<14 {
            if host.exists && host.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(host.waitForExistence(timeout: 5), "The fixture computer must appear in Agents")
        host.tap()
        XCTAssertTrue(app.buttons[chat].waitForExistence(timeout: 10))
        return app
    }

    /// Texts showing a brace — tool JSON leaking onto a card. The fixture's
    /// own 1-point report of what was copied is JSON by design.
    @MainActor func rawJSONTexts(_ app: XCUIApplication) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND identifier != %@", "{", "chat-fixture-copied"))
    }

    @MainActor func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}
