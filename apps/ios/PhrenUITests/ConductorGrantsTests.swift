import XCTest

final class ConductorGrantsTests: XCTestCase {
    @MainActor
    func testChatGrantAnswersAreOrderedChoiceRows() {
        for answer in ["approve", "allow-project", "allow-everywhere", "deny"] {
            let app = XCUIApplication()
            app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture",
                                   "--native-chat-fixture", "--chat-approval", "--conductor-grants-fixture"]
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
            app.tabBars.buttons["Agents"].tap()
            let chat = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"]
            XCTAssertTrue(chat.waitForExistence(timeout: 8)); chat.tap()
            let rows = ["approve", "allow-project", "allow-everywhere", "deny"].map { app.buttons["chat-approval-" + $0] }
            XCTAssertTrue(rows[0].waitForExistence(timeout: 8))
            for index in rows.indices {
                XCTAssertTrue(rows[index].isEnabled)
                XCTAssertGreaterThanOrEqual(rows[index].frame.height, 44)
                if index > 0 { XCTAssertGreaterThanOrEqual(rows[index].frame.minY, rows[index - 1].frame.maxY) }
            }
            attachUIScreenshot(app, "Conductor permission choices " + answer)
            app.buttons["chat-approval-" + answer].tap()
            XCTAssertTrue(rows[0].waitForNonExistence(timeout: 8))
            app.terminate()
        }
    }
}
