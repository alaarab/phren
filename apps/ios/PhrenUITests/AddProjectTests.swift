import XCTest

/// "Add project" from the Projects tab: pick the computer, pick one of the
/// repositories it offers (or paste a URL to clone), and land in the new
/// project once the store has it.
final class AddProjectTests: XCTestCase {
    @MainActor
    func testAddsARepositoryFromTheComputerAndOpensIt() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Projects"].tap()
        XCTAssertTrue(app.buttons["projects-add"].waitForExistence(timeout: 10))
        app.buttons["projects-add"].tap()
        let mac = app.buttons["add-project-computer:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(mac.waitForExistence(timeout: 5))
        XCTAssertTrue(mac.isSelected, "The verified computer is chosen up front")
        XCTAssertTrue(app.buttons["add-project-repo:nightjar"].waitForExistence(timeout: 5), "The computer lists its untracked checkouts")
        XCTAssertTrue(app.buttons["add-project-repo:lantern"].exists)
        XCTAssertFalse(app.buttons["add-project-repo:phren"].exists, "A repository phren already tracks is not offered")
        XCTAssertTrue(app.staticTexts["Already in phren"].exists)
        let submit = app.buttons["add-project-submit"]
        XCTAssertFalse(submit.isEnabled, "Nothing chosen yet")
        app.buttons["add-project-repo:nightjar"].tap()
        XCTAssertEqual(app.textFields["add-project-folder"].value as? String, "/work/nightjar", "Choosing a repository fills the folder")
        XCTAssertTrue(submit.isEnabled)
        attachUIScreenshot(app, "Add project sheet")
        submit.tap()
        // Two fixture stores, so the title carries the store name too.
        let title = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'nightjar'")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 15), "The sheet closes on the new project")
        XCTAssertTrue(app.buttons["Project session"].exists, "Open on a computer is one tap away")
        attachUIScreenshot(app, "New project after Add project")
    }

    @MainActor
    func testCloneModeTakesAURLAndAFailureKeepsTheSheet() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "--enroll-fails"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Projects"].tap()
        XCTAssertTrue(app.buttons["projects-add"].waitForExistence(timeout: 10))
        app.buttons["projects-add"].tap()
        XCTAssertTrue(app.buttons["add-project-computer:A1000000-0000-0000-0000-000000000001"].waitForExistence(timeout: 5))
        app.segmentedControls["add-project-mode"].buttons["Clone from GitHub"].tap()
        let url = app.textFields["add-project-url"]
        XCTAssertTrue(url.waitForExistence(timeout: 5))
        url.tap(); url.typeText("https://github.com/alaarab/lantern")
        let submit = app.buttons["add-project-submit"]
        XCTAssertTrue(submit.isEnabled)
        submit.tap()
        XCTAssertTrue(app.alerts["Couldn't add project"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.alerts.staticTexts.element(boundBy: 1).label.contains("git clone failed"))
        app.alerts.buttons["OK"].tap()
        XCTAssertTrue(url.exists, "The picker stays so the URL can be fixed")
    }
}
