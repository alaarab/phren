import XCTest

final class SessionDetailsTests: XCTestCase {
    @MainActor
    func testRowsGrowForLargeTextAndKeepDetailsReachable() {
        let app = launch()
        let title = app.staticTexts["Polish the phone app"]
        let metadata = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "codex", "Working")).firstMatch
        XCTAssertTrue(metadata.exists)
        XCTAssertLessThanOrEqual(title.frame.maxY, metadata.frame.minY)
        let details = app.buttons["live-detail:w7:w7:t9"]
        XCTAssertTrue(details.isHittable)
        XCTAssertGreaterThanOrEqual(details.frame.height, 44)
        capture(app, "Readable compact session rows at larger text sizes")
        details.tap()
        XCTAssertTrue(app.navigationBars["Session details"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testSessionRowsFitWithoutRepeatedActionTiles() {
        let app = launch()
        let first = app.buttons["live-chat:w7:w7:t9"]
        XCTAssertLessThanOrEqual(first.frame.height, 96)
        XCTAssertGreaterThanOrEqual(first.frame.height, 44)
        XCTAssertTrue(app.buttons["live-detail:w8:w8:t1"].isHittable)
        let status = app.descendants(matching: .any).matching(identifier: "live-connection-status").firstMatch
        XCTAssertLessThanOrEqual(status.frame.height, 60)
        XCTAssertFalse(app.buttons["Chat"].exists)
        capture(app, "Compact sessions and inline connection status")
    }

    @MainActor
    func testSearchAndActivityKeepTheMatchingSession() {
        let app = launch()
        capture(app, "Workspace cards")
        app.segmentedControls.buttons["Activity"].tap()
        let waiting = app.buttons["live-detail:w8:w8:t1"]
        let working = app.buttons["live-detail:w7:w7:t9"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 5))
        XCTAssertLessThan(waiting.frame.minY, working.frame.minY)
        capture(app, "Activity grouped by state")
        let search = app.searchFields.firstMatch
        search.tap()
        search.typeText("deployment")
        XCTAssertTrue(waiting.waitForExistence(timeout: 5))
        XCTAssertFalse(working.exists)
        search.typeText(" unmatched")
        XCTAssertTrue(app.staticTexts["No matching sessions"].waitForExistence(timeout: 5))
        XCTAssertFalse(waiting.exists)
    }

    @MainActor
    func testDetailsExposeMetadataProjectAndNativeChat() {
        let app = launch(extra: ["--native-chat-fixture"])
        app.buttons["live-detail:w7:w7:t9"].tap()
        let title = app.navigationBars["Session details"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Polish the phone app"].exists)
        capture(app, "Session details and project shortcuts")
        app.buttons["session-detail-chat"].tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        app.buttons["chat-close"].tap()
        app.buttons["session-detail-project"].tap()
        XCTAssertTrue(app.navigationBars["phone · brain"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Explore graph"].tap()
        XCTAssertTrue(app.webViews.staticTexts["PHONE"].firstMatch.waitForExistence(timeout: 20))
        app.buttons["graph-back"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let list = app.collectionViews.firstMatch
        let copy = app.buttons["Copy folder"]
        for _ in 0..<4 where !copy.isHittable { list.swipeUp() }
        XCTAssertTrue(app.staticTexts["Agent panes, 2"].exists)
        XCTAssertTrue(app.staticTexts["Total panes, 3"].exists)
        XCTAssertTrue(app.staticTexts["/work/phone/src"].exists)
        copy.tap()
        XCTAssertTrue(app.buttons["Folder copied"].exists)
        capture(app, "Session metadata and folder")
    }

    @MainActor
    func testClosedSessionRemovesActionsFromItsOpenDetails() {
        let app = launch(extra: ["--session-details-removed"])
        app.buttons["live-detail:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["session-detail-chat"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Session no longer available"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["session-detail-chat"].exists)
        XCTAssertFalse(app.buttons["session-detail-project"].exists)
        app.navigationBars["Session details"].buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["No sessions running"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture"] + extra
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Agents"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test Mac,")).firstMatch.tap()
        XCTAssertTrue(app.buttons["live-detail:w7:w7:t9"].waitForExistence(timeout: 10))
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
