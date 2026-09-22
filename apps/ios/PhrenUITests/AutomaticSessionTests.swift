import XCTest

final class AutomaticSessionTests: XCTestCase {
    @MainActor
    func testProjectDiscoveryWaitsForSelectionThenOpensNativeChat() {
        let app = launch()
        openProjectSessions(app)
        let row = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["chat-close"].exists)
        openSessionsAction("refresh", in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Test Mac"))
        XCTAssertFalse(app.buttons["Open in Moshi"].exists)
    }

    @MainActor
    func testMultipleMatchesRemainSelectableWithoutGuessing() {
        let app = launch(extra: ["--multiple-project-sessions"])
        openProjectSessions(app)
        XCTAssertTrue(app.staticTexts["Review phone changes"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Build phone app"].exists)
        app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t10"].tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testOfflineComputerDoesNotInventASession() {
        let app = launch(extra: ["--session-discovery-offline"])
        openProjectSessions(app)
        app.buttons["overview-reconnect:A1000000-0000-0000-0000-000000000001"].tap()
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
