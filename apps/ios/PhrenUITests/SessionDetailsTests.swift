import XCTest

final class SessionDetailsTests: XCTestCase {
    @MainActor
    func testRowsGrowForLargeTextAndKeepDetailsReachable() {
        let app = launch()
        let title = app.staticTexts["Polish the phone app"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        // One computer, fresh, nothing pending: no last line at all — the
        // section already says "Working".
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Working")).firstMatch.exists)
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
    func testActivityOrdersWaitingAboveWorking() {
        let app = launch()
        capture(app, "Workspace cards")
        app.buttons["host-session-view:activity"].tap()
        let waiting = app.buttons["live-detail:w8:w8:t1"]
        let working = app.buttons["live-detail:w7:w7:t9"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 5))
        XCTAssertLessThan(waiting.frame.minY, working.frame.minY)
        capture(app, "Activity grouped by state")
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
        XCTAssertTrue(graphProjectLabel("PHONE", in: app.webViews).waitForExistence(timeout: 20))
        app.buttons["graph-back"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let copy = app.buttons["Copy folder"]
        for _ in 0..<4 where !copy.isHittable { app.swipeUp() }
        XCTAssertTrue(app.staticTexts["Agent panes, 2"].exists)
        XCTAssertTrue(app.staticTexts["Total panes, 3"].exists)
        XCTAssertTrue(app.staticTexts["/work/phone/src"].exists)
        copy.tap()
        XCTAssertTrue(app.buttons["Folder copied"].exists)
        capture(app, "Session metadata and folder")
    }

    @MainActor
    func testPermissionLeftInTheTerminalLeadsTheDetailsAndIsApproved() {
        let app = launch(extra: ["--details-approval-fixture"])
        // The card names the wait instead of a bare "Blocked", and a tap on it
        // opens the request rather than the chat.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Permission needed")).firstMatch.waitForExistence(timeout: 5))
        app.buttons["live-chat:w8:w8:t1"].tap()
        XCTAssertTrue(app.navigationBars["Session details"].waitForExistence(timeout: 5))
        let hero = app.descendants(matching: .any).matching(identifier: "session-approval").firstMatch
        XCTAssertTrue(hero.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Manage task"].exists)
        XCTAssertTrue(app.staticTexts["PERMISSION"].exists)
        XCTAssertTrue(app.staticTexts["Do you want to proceed?"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "action: complete")).firstMatch.exists)
        let approve = app.buttons["session-approval-approve"], deny = app.buttons["session-approval-deny"]
        XCTAssertTrue(approve.isHittable && deny.isHittable)
        XCTAssertGreaterThanOrEqual(approve.frame.height, 44)
        // Hero first, then the ways in, then the answer, like Moshi.
        XCTAssertLessThan(hero.frame.maxY, app.buttons["session-detail-terminal"].frame.minY)
        XCTAssertLessThan(app.buttons["session-detail-terminal"].frame.maxY, approve.frame.minY)
        XCTAssertGreaterThan(approve.frame.minX, deny.frame.minX)
        capture(app, "Permission leading the session details")
        approve.tap()
        XCTAssertTrue(app.staticTexts["Approved. Claude continues."].waitForExistence(timeout: 5))
        XCTAssertFalse(approve.exists)
    }

    @MainActor
    func testClosedSessionRemovesActionsFromItsOpenDetails() {
        let app = launch(extra: ["--session-details-removed"])
        app.buttons["live-detail:w7:w7:t9"].tap()
        // The pushed page takes over polling at once, so the fixture's
        // second fetch (the removal) can land before the actions ever draw.
        XCTAssertTrue(app.staticTexts["Session no longer available"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["session-detail-chat"].exists)
        XCTAssertFalse(app.buttons["session-detail-project"].exists)
        app.navigationBars["Session details"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["No sessions running"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture"] + extra
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test Mac,")).firstMatch.tap()
        XCTAssertTrue(app.buttons["live-detail:w7:w7:t9"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}

