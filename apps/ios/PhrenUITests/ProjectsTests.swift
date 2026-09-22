import XCTest

final class ProjectsTests: XCTestCase {
    @MainActor
    func testGridLeadsWithoutMoreAndDestinationsLiveInTheirTabs() {
        let app = launch()
        XCTAssertFalse(app.buttons["Files"].exists)
        XCTAssertFalse(app.buttons["Live sessions"].exists)
        XCTAssertFalse(app.buttons["Skills"].exists)
        XCTAssertFalse(app.buttons["Agent instructions"].exists)
        XCTAssertFalse(app.staticTexts["Agent setup"].exists)
        XCTAssertTrue(app.buttons["projects-add"].exists)
        XCTAssertFalse(app.buttons["projects-more"].exists)
        XCTAssertFalse(app.buttons["More"].exists)
        capture(app, "Projects grid")

        openMemoryGraph(from: app)
        XCTAssertTrue(app.webViews.staticTexts["PHONE"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["memory-files"].exists)
        XCTAssertTrue(app.buttons["memory-maintenance"].exists)
        XCTAssertFalse(app.buttons["Skills"].exists)
        XCTAssertFalse(app.buttons["Agent instructions"].exists)
        capture(app, "Memory owns graph files and maintenance")
        app.buttons["memory-files"].tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 5))
        app.navigationBars["Files"].buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["memory-maintenance"].waitForExistence(timeout: 5))
        app.buttons["memory-maintenance"].tap()
        XCTAssertTrue(app.navigationBars["Memory maintenance"].waitForExistence(timeout: 5))

        app.tabBars.buttons["Agents"].tap()
        XCTAssertTrue(app.navigationBars["Live sessions"].waitForExistence(timeout: 5))
        openSessionsAction("skills", in: app)
        XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 5))
        app.navigationBars["Skills"].buttons.firstMatch.tap()
        openSessionsAction("instructions", in: app)
        XCTAssertTrue(app.navigationBars["Agent setup"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testProjectsTitleSharesTheOtherTabsLeadingEdgeAndToolbarLine() {
        let app = launch()
        let title = app.navigationBars["Projects"].staticTexts["Projects"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let project = app.buttons["project:sample/brain:phone"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        let frame = title.frame
        XCTAssertGreaterThan(frame.width, 0)
        XCTAssertTrue(app.navigationBars["Projects"].frame.contains(frame))
        XCTAssertEqual(frame.minX, project.frame.minX, accuracy: 2, "The title leads the project grid")
        let stores = app.buttons["projects-stores"]
        XCTAssertTrue(stores.isHittable)
        XCTAssertGreaterThanOrEqual(stores.frame.minY, app.navigationBars["Projects"].frame.maxY,
                                    "The store filter leaves the title's leading edge clear")
        for identifier in ["projects-add", "projects-search-toggle", "projects-mic"] {
            let control = app.buttons[identifier]
            XCTAssertTrue(control.exists)
            XCTAssertGreaterThanOrEqual(control.frame.minX, frame.maxX)
            XCTAssertEqual(control.frame.midY, frame.midY, accuracy: 2, "\(identifier) shares the title line")
        }
        XCTAssertFalse(app.buttons["projects-more"].exists)
        XCTAssertFalse(app.buttons["More"].exists)
        capture(app, "Projects inline header")

        for (tab, heading) in [("Agents", "Live sessions"), ("Tasks", "Tasks"), ("Memory", "Memory")] {
            app.tabBars.buttons[tab].tap()
            let other = app.navigationBars[heading].staticTexts[heading]
            XCTAssertTrue(other.waitForExistence(timeout: 5))
            if tab == "Tasks" {
                // Tasks has Select on the leading side and Add on the trailing
                // side. Its inline title is centered between those actions.
                XCTAssertEqual(other.frame.midX, app.navigationBars[heading].frame.midX, accuracy: 2)
                XCTAssertGreaterThanOrEqual(other.frame.minX, app.buttons["task-selection-mode"].frame.maxX)
            } else {
                XCTAssertEqual(frame.minX, other.frame.minX, accuracy: 2, "Projects shares \(tab)'s title leading edge")
            }
            XCTAssertEqual(frame.midY, other.frame.midY, accuracy: 2, "Projects shares \(tab)'s title line")
            capture(app, "\(tab) header alignment")
        }
    }

    @MainActor
    func testHoldProjectChoosesComputerThenLaunchesExistingFlow() {
        let app = launch()
        let project = app.buttons["project:sample/brain:phone"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        project.press(forDuration: 0.5)
        let computer = app.buttons["project-agent-sheet:sample/brain:phone:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(computer.waitForExistence(timeout: 5))
        XCTAssertTrue(computer.label.contains("Test Mac"))
        XCTAssertTrue(computer.label.contains("session"))
        XCTAssertTrue(app.staticTexts["Open on computer · phone · brain"].exists)
        XCTAssertTrue(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: computer)], timeout: 8) == .completed)
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
