import XCTest

/// "Open on a computer" from a session: a stalled thread offers a new one on
/// the project's own computer, and the store already says where it lives.
final class LaunchSessionTests: XCTestCase {
    @MainActor
    func testOpensAProjectOnAKnownComputerAndLandsInChat() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "--chat-history-stalled"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let session = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"]
        XCTAssertTrue(session.waitForExistence(timeout: 10)); session.tap()
        let newThread = app.buttons["New thread"]
        XCTAssertTrue(newThread.waitForExistence(timeout: 8)); newThread.tap()
        let chooser = app.buttons["launch-computer"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 5))
        chooser.tap()
        let mac = app.buttons["launch-computer:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(mac.waitForExistence(timeout: 5))
        XCTAssertTrue(mac.label.contains("has phone"), "machines.yaml + the profile say this computer carries the project")
        XCTAssertTrue(mac.isSelected, "The computer that has the project is chosen up front")
        app.buttons["launch-computer-done"].tap()
        let folder = app.textFields["launch-folder"]
        XCTAssertTrue(app.buttons["launch-found:/work/phone"].waitForExistence(timeout: 5), "The computer reports where the project is")
        XCTAssertEqual(folder.value as? String, "/work/phone", "The folder is the computer's own answer")
        XCTAssertTrue(app.buttons["launch-found:/Users/fixture/Projects/phone"].exists)
        app.buttons["launch-found:/Users/fixture/Projects/phone"].tap()
        XCTAssertEqual(folder.value as? String, "/Users/fixture/Projects/phone", "A candidate fills the field")
        app.buttons["launch-found:/work/phone"].tap()
        XCTAssertEqual(folder.value as? String, "/work/phone")
        app.buttons["launch-harness:claude"].tap()
        XCTAssertTrue(app.buttons["launch-harness:claude"].isSelected)
        app.swipeUp()
        let open = app.buttons["launch-open"]
        XCTAssertTrue(open.isEnabled)
        XCTAssertTrue(open.label.contains("Claude Code"))
        open.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 10), "The new session opens straight into chat")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "chat-provider").firstMatch.label, "Claude")
        XCTAssertTrue(app.staticTexts.matching(identifier: "chat-location").firstMatch.label.contains("phone"))
        attachUIScreenshot(app, "Chat opened on the launched session")
    }

    @MainActor
    func testAFailedStartExplainsAndKeepsThePicker() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "--launch-fails", "--chat-history-stalled"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let session = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"]
        XCTAssertTrue(session.waitForExistence(timeout: 10)); session.tap()
        let newThread = app.buttons["New thread"]
        XCTAssertTrue(newThread.waitForExistence(timeout: 8)); newThread.tap()
        app.swipeUp()
        XCTAssertTrue(app.buttons["launch-open"].waitForExistence(timeout: 5))
        app.buttons["launch-open"].tap()
        XCTAssertTrue(app.staticTexts["Couldn't open session"].waitForExistence(timeout: 8))
        // The harness is whichever was picked last (it persists), so match the verb only.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "couldn't start")).firstMatch.exists)
        app.buttons["OK"].tap()
        app.swipeDown()
        XCTAssertTrue(app.textFields["launch-folder"].exists, "The picker stays so the folder or harness can be changed")
    }
}
