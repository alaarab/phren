import XCTest

final class ProjectsTests: XCTestCase {
    @MainActor
    func testGridLeadsAndMoreKeepsFilesAndAgentSetup() {
        let app = launch()
        XCTAssertFalse(app.buttons["Files"].exists)
        XCTAssertFalse(app.buttons["Live sessions"].exists)
        XCTAssertFalse(app.staticTexts["Agent setup"].exists)
        XCTAssertTrue(app.buttons["projects-add"].exists)
        capture(app, "Projects grid")
        app.buttons["projects-more"].tap()
        for item in ["files", "sessions", "skills", "instructions", "maintenance"] {
            XCTAssertTrue(app.buttons["projects-more-sheet:\(item)"].exists)
        }
        capture(app, "Projects More destinations")
        app.buttons["projects-more-sheet:files"].tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testHoldProjectChoosesComputerThenLaunchesExistingFlow() {
        let app = launch()
        let project = app.buttons["project:sample/brain:phone"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        project.press(forDuration: 0.5)
        let computer = app.buttons["project-agent-sheet:sample/brain:phone:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(computer.waitForExistence(timeout: 5))
        XCTAssertTrue(computer.label.contains("Open agent on"))
        capture(app, "Hold project computer chooser")
        computer.tap()
        XCTAssertTrue(app.navigationBars["Open phone"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["launch-computer"].exists)
        XCTAssertTrue(app.buttons["launch-harness:claude"].exists)
        capture(app, "Project launch harness choice")
    }

    @MainActor
    func testHoldComputerInProjectHeaderAndSessionsOffersItsProjects() {
        let app = launch()
        let project = app.buttons["project:sample/brain:phone"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        project.tap()
        let computer = app.buttons["project-computer:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(computer.waitForExistence(timeout: 5))
        computer.press(forDuration: 0.5)
        let action = app.buttons["project-agent-sheet:sample/brain:phone:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        capture(app, "Computer projects in project header")
        app.buttons["project-agent-sheet:close"].tap()
        computer.tap()
        XCTAssertTrue(app.navigationBars["Project sessions"].waitForExistence(timeout: 5))
        XCTAssertTrue(computer.waitForExistence(timeout: 5))
        computer.press(forDuration: 0.5)
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        capture(app, "Computer projects from project sessions")
        action.tap()
        XCTAssertTrue(app.navigationBars["Open phone"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "-phren-tab", "projects"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Projects"].tap()
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) { attachUIScreenshot(app, name) }
}
