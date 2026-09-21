import XCTest

final class MemoryConnectionTests: XCTestCase {
    @MainActor
    func testAgentsAndChatWorkWithoutGitHubAndMemoryConnectIsDismissible() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--agents-without-github", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Agents"].isSelected)
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(host.waitForExistence(timeout: 10)); host.tap()
        let chat = app.buttons["live-chat:w7:w7:t9"]
        XCTAssertTrue(chat.waitForExistence(timeout: 8)); chat.tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Agent without GitHub")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Agent without GitHub"].waitForExistence(timeout: 8))
        app.buttons["chat-close"].tap()
        app.tabBars.buttons["Settings"].tap()
        app.buttons["settings-connect-memory"].tap()
        XCTAssertTrue(app.staticTexts["Connect project memory"].waitForExistence(timeout: 5))
        app.buttons["Connect with a GitHub token"].tap()
        XCTAssertTrue(app.navigationBars["Token sign-in"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap(); app.buttons["Done"].tap()
        app.tabBars.buttons["Agents"].tap()
        XCTAssertTrue(chat.waitForExistence(timeout: 5))
        chat.tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Agent without GitHub"].waitForExistence(timeout: 5))
        attachUIScreenshot(app, "Native agent chat without GitHub")
    }
}
