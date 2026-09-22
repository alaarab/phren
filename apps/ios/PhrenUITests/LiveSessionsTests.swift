import XCTest

final class LiveSessionsTests: XCTestCase {
    @MainActor
    func testProjectControlBandClearsNavigationAndKeepsFourEqualCells() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--project-skills-fixture", "--code-fixture", "--schedules-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Projects"].tap()
        let project = app.buttons["project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 8)); project.tap()
        let band = app.descendants(matching: .any).matching(identifier: "project-control-band").firstMatch
        XCTAssertTrue(band.waitForExistence(timeout: 8))
        XCTAssertGreaterThanOrEqual(band.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        XCTAssertGreaterThanOrEqual(band.frame.height, 44)
        XCTAssertLessThanOrEqual(band.frame.height, 56)
        let cells = ["project-skills", "project-knobs-row", "project-schedules-row", "project-code-row"].map { app.buttons[$0] }
        for cell in cells {
            XCTAssertTrue(cell.exists)
            XCTAssertGreaterThanOrEqual(cell.frame.height, 44)
            XCTAssertEqual(cell.frame.width, cells[0].frame.width, accuracy: 1)
        }
        attachUIScreenshot(app, "Project four controls below navigation")
    }

    @MainActor
    func testConnectionSetupProjectGraphAndStaleStatus() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--live-sessions-fixture", "--live-sessions-offline"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let computer = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Desk,")).firstMatch
        if !computer.exists {
            app.buttons["Add computer"].tap()
            let name = app.textFields["live-host-name"]
            XCTAssertTrue(name.waitForExistence(timeout: 5))
            name.tap(); name.typeText("Desk")
            app.textFields["live-host-address"].tap()
            app.textFields["live-host-address"].typeText("fixture.invalid")
            app.textFields["live-host-username"].tap()
            app.textFields["live-host-username"].typeText("sam")
            app.swipeUp()
            app.buttons["Create device key"].tap()
            XCTAssertTrue(app.buttons["Copy SSH authorization line"].waitForExistence(timeout: 5))
            app.buttons["Save"].tap()
        }
        computer.tap()
        XCTAssertTrue(app.staticTexts["Build graph"].waitForExistence(timeout: 10))
        app.buttons["Connection settings"].tap()
        let orange = app.buttons["host-color:#FF8A5B"]
        XCTAssertTrue(orange.waitForExistence(timeout: 5))
        orange.tap()
        let customColor = app.textFields["host-color-hex"]
        customColor.tap()
        customColor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6))
        customColor.typeText("1A2B3C")
        XCTAssertEqual(customColor.value as? String, "1A2B3C")
        app.buttons["Cancel"].tap()
        app.navigationBars["Desk"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["session-computer-name"].waitForExistence(timeout: 10))
        computer.tap()
        XCTAssertTrue(app.staticTexts["Build graph"].waitForExistence(timeout: 10))
        app.buttons["live-detail:w1:w1:t1"].tap()
        if app.buttons["Change project link"].exists { app.buttons["Change project link"].tap() }
        else { app.buttons["Link to project"].tap() }
        let project = app.buttons["live-project:team/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        project.tap()
        let graph = app.buttons["Explore graph"]
        XCTAssertTrue(graph.waitForExistence(timeout: 5))
        graph.tap()
        XCTAssertTrue(app.webViews.staticTexts["DEMO"].firstMatch.waitForExistence(timeout: 20))
        app.buttons["graph-back"].tap()
        app.navigationBars["Session details"].buttons.element(boundBy: 0).tap()
        // A snapshot reads as live for 90s after its last successful update;
        // wait past that window for the disconnected fixture to go stale.
        let stale = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Showing previous status")).firstMatch
        XCTAssertTrue(stale.waitForExistence(timeout: 100))
        // The card's last line only says what the section can't: Stale.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Stale")).firstMatch.exists)
        attachUIScreenshot(app, "Live sessions retain clearly stale status")

        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        computer.tap()
        XCTAssertTrue(app.buttons["live-detail:w1:w1:t1"].waitForExistence(timeout: 10))
        app.buttons["live-detail:w1:w1:t1"].tap()
        XCTAssertTrue(graph.waitForExistence(timeout: 5))
        app.buttons["Change project link"].tap()
        app.buttons["Remove directory link"].tap()
        XCTAssertTrue(app.buttons["Link to project"].waitForExistence(timeout: 5))
        app.navigationBars["Session details"].buttons.element(boundBy: 0).tap()
        app.buttons["Connection settings"].tap()
        app.swipeUp()
        app.buttons["Forget computer"].tap()
        app.buttons["live-host-forget-dialog:forget"].tap()
        XCTAssertTrue(app.navigationBars["Computer removed"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Build graph"].exists)
    }

    @MainActor
    func testSessionsLayoutWithZeroOneAndSixSessions() {
        for count in [0, 1, 6] {
            let app = launchLayout(count: count)
            let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat:"))
            if count == 0 {
                XCTAssertTrue(app.staticTexts["sessions-empty"].waitForExistence(timeout: 10))
                XCTAssertEqual(cards.count, 0)
            } else {
                XCTAssertTrue(cards.firstMatch.waitForExistence(timeout: 10))
                XCTAssertEqual(cards.count, count)
                XCTAssertGreaterThanOrEqual(cards.firstMatch.frame.minY, app.navigationBars.firstMatch.frame.maxY)
            }
            XCTAssertFalse(app.staticTexts["Agent setup"].exists)
            XCTAssertFalse(app.buttons["Skills"].exists)
            XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Keep Tailscale connected")).firstMatch.exists)
            capture(app, "Sessions \(count) top")

            let computer = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
            let add = app.buttons["sessions-add-computer"]
            for _ in 0..<8 where !add.isHittable { app.scrollViews["sessions-scroll"].swipeUp() }
            XCTAssertTrue(computer.isHittable)
            XCTAssertTrue(add.isHittable)
            if count > 0 { XCTAssertGreaterThan(computer.frame.minY, cards.firstMatch.frame.minY) }
            capture(app, "Sessions \(count) computers")
            computer.tap()
            XCTAssertTrue(app.buttons["Connection settings"].waitForExistence(timeout: 5))
            app.terminate()
        }
    }

    @MainActor
    func testSkillsAndInstructionsOpenFromMore() {
        let app = launchLayout(count: 1, extra: ["--project-skills-fixture"])
        XCTAssertTrue(app.buttons["sessions-more"].waitForExistence(timeout: 5))
        app.buttons["sessions-more"].tap()
        let skills = app.buttons["sessions-more-sheet:skills"]
        XCTAssertTrue(skills.waitForExistence(timeout: 5))
        capture(app, "Sessions More")
        skills.tap()
        XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 5))
        capture(app, "Skills from Sessions More")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["sessions-more"].tap()
        let instructions = app.buttons["sessions-more-sheet:instructions"]
        XCTAssertTrue(instructions.waitForExistence(timeout: 5))
        instructions.tap()
        XCTAssertTrue(app.navigationBars["Agent setup"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testAddComputerFromMoreWithSixSessions() {
        let app = launchLayout(count: 6)
        app.buttons["sessions-more"].tap()
        app.buttons["sessions-more-sheet:add-computer"].tap()
        XCTAssertTrue(app.textFields["live-host-name"].waitForExistence(timeout: 5))
        capture(app, "Add computer from Sessions More")
    }

    @MainActor
    func testMemoryConnectionRemainsAvailableFromMore() {
        let app = launchLayout(count: 0, extra: ["--agents-without-github"])
        app.buttons["sessions-more"].tap()
        let connect = app.buttons["sessions-more-sheet:connectMemory"]
        XCTAssertTrue(connect.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["sessions-more-sheet:skills"].exists)
        connect.tap()
        XCTAssertTrue(app.staticTexts["Connect project memory"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testSessionSwipeStillOffersCloseInCustomScrollLayout() {
        let app = launchLayout(count: 1)
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat:")).firstMatch
        XCTAssertTrue(card.isHittable)
        card.swipeLeft()
        XCTAssertFalse(app.buttons["chat-close"].exists, "Swiping must not open the conversation")
        let close = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-close:")).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        capture(app, "Sessions swipe close")
        card.swipeRight()
        XCTAssertFalse(close.exists)
    }

    @MainActor
    private func launchLayout(count: Int, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture",
                               "--session-pins-reset", "--sessions-layout-count=\(count)"] + extra
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        XCTAssertTrue(app.navigationBars["Live sessions"].waitForExistence(timeout: 5))
        let ready = count == 0 ? app.staticTexts["sessions-empty"]
            : app.staticTexts["Polish the phone app"].firstMatch
        XCTAssertTrue(ready.waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

}
