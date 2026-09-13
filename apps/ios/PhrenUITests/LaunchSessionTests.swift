import XCTest

/// "Open on a computer" from a project: the store already says which
/// computer has the project and where, so it is pick, pick, open.
final class LaunchSessionTests: XCTestCase {
    @MainActor
    func testOpensAProjectOnAKnownComputerAndLandsInChat() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Projects"].tap()
        let project = app.buttons["project:sample/brain:phone"]
        XCTAssertTrue(project.waitForExistence(timeout: 10)); project.tap()
        app.buttons["Project session"].tap()
        app.buttons["project-open-on-computer"].tap()
        let mac = app.buttons["launch-computer:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(mac.waitForExistence(timeout: 5))
        XCTAssertTrue(mac.label.contains("has phone"), "machines.yaml + the profile say this computer carries the project")
        XCTAssertTrue(mac.isSelected, "The computer that has the project is chosen up front")
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
        let open = app.buttons["launch-open"]
        XCTAssertTrue(open.isEnabled)
        XCTAssertTrue(open.label.contains("Claude Code"))
        open.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 10), "The new session opens straight into chat")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "chat-provider").firstMatch.label, "Claude")
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("phone"))
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Chat opened on the launched session"; shot.lifetime = .keepAlways; add(shot)
    }

    @MainActor
    func testAFailedStartExplainsAndKeepsThePicker() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "--launch-fails"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Projects"].tap()
        let project = app.buttons["project:sample/brain:phone"]
        XCTAssertTrue(project.waitForExistence(timeout: 10)); project.tap()
        app.buttons["Project session"].tap()
        app.buttons["project-open-on-computer"].tap()
        XCTAssertTrue(app.buttons["launch-open"].waitForExistence(timeout: 5))
        app.buttons["launch-open"].tap()
        XCTAssertTrue(app.staticTexts["Couldn't open session"].waitForExistence(timeout: 8))
        // The harness is whichever was picked last (it persists), so match the verb only.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "couldn't start")).firstMatch.exists)
        app.buttons["OK"].tap()
        XCTAssertTrue(app.textFields["launch-folder"].exists, "The picker stays so the folder or harness can be changed")
    }
}
