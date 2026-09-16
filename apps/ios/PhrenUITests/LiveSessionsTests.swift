import XCTest

final class LiveSessionsTests: XCTestCase {
    @MainActor
    func testConnectionSetupProjectGraphAndStaleStatus() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--live-sessions-fixture", "--live-sessions-offline"]
        app.launch()
        XCTAssertTrue(app.buttons["More"].waitForExistence(timeout: 15))
        app.buttons["More"].tap()
        let liveItem = app.buttons.matching(NSPredicate(format: "label == %@", "Live sessions"))
            .allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(liveItem)
        liveItem?.tap()
        let computer = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test Mac,")).firstMatch
        if !computer.exists {
            app.buttons["Add computer"].tap()
            let name = app.textFields["live-host-name"]
            XCTAssertTrue(name.waitForExistence(timeout: 5))
            name.tap(); name.typeText("Test Mac")
            app.textFields["live-host-address"].tap()
            app.textFields["live-host-address"].typeText("fixture.invalid")
            app.textFields["live-host-username"].tap()
            app.textFields["live-host-username"].typeText("fixture")
            app.swipeUp()
            app.buttons["Create device key"].tap()
            XCTAssertTrue(app.buttons["Copy SSH authorization line"].waitForExistence(timeout: 5))
            app.buttons["Save"].tap()
        }
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
        let stale = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Showing previous status")).firstMatch
        XCTAssertTrue(stale.waitForExistence(timeout: 20))
        // The card's last line only says what the section can't: Stale.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Stale")).firstMatch.exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Live sessions retain clearly stale status"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["More"].waitForExistence(timeout: 15))
        app.buttons["More"].tap()
        let reopenedLiveItem = app.buttons.matching(NSPredicate(format: "label == %@", "Live sessions"))
            .allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(reopenedLiveItem)
        reopenedLiveItem?.tap()
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
        app.sheets.buttons["Forget computer"].tap()
        XCTAssertTrue(app.navigationBars["Computer removed"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Build graph"].exists)
    }
}
