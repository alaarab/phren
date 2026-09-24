import XCTest

/// The chat's ••• sheet lists only this session's own web servers.
final class SessionWebServersTests: AgentChatUITestCase {
    @MainActor
    func testChatListsItsOwnWebServersAndOpensOne() {
        let app = launch(extra: ["--session-web-servers-fixture"])
        openServers(app)
        let started = app.buttons["session-server:5173"]
        XCTAssertTrue(started.waitForExistence(timeout: 8), "The server this session started is listed")
        XCTAssertTrue(started.label.contains("Vite App"))
        let mentioned = app.buttons["session-server:8000"]
        XCTAssertTrue(mentioned.exists, "A live port the transcript names is listed")
        XCTAssertTrue(mentioned.label.contains("mentioned in this chat"))
        XCTAssertFalse(app.descendants(matching: .any)["session-servers-empty"].exists)
        capture(app, "Session web servers")
        started.tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(started.isHittable, "Opening a server covers the list with its preview")
        capture(app, "Session web server opened")
    }

    @MainActor
    func testSessionWithoutServersSaysSo() {
        let app = launch(extra: ["--session-web-servers-fixture", "--session-web-servers-none"])
        openServers(app)
        XCTAssertTrue(app.descendants(matching: .any)["session-servers-empty"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["No web servers from this session"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "session-server:")).firstMatch.exists)
        capture(app, "Session without web servers")
    }

    @MainActor
    private func openServers(_ app: XCUIApplication) {
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 8))
        app.buttons["Chat options"].tap()
        let row = app.buttons["chat-options-web-servers"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "The ••• sheet offers this session's web servers")
        row.tap()
        XCTAssertTrue(app.navigationBars["Web servers"].waitForExistence(timeout: 5))
    }
}
