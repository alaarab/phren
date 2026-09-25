import XCTest

final class AutomaticSessionTests: XCTestCase {
    @MainActor
    func testOfflineComputerDoesNotInventASession() {
        let app = launch(extra: ["--session-discovery-offline"])
        openProjectSessions(app)
        // An offline computer says so on its own row under Computers.
        XCTAssertTrue(app.descendants(matching: .any)["computer-status:A1000000-0000-0000-0000-000000000001"].waitForExistence(timeout: 15))
        app.buttons["live-host:A1000000-0000-0000-0000-000000000001"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "connection", "closed")).firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["Build phone app"].exists)
        XCTAssertFalse(app.buttons["chat-close"].exists)
    }

    @MainActor
    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--native-chat-fixture"] + extra
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 8))
        return app
    }

    @MainActor
    private func openProjectSessions(_ app: XCUIApplication) {
        // The Agents tab is the one way to a project's live sessions.
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
    }
}
