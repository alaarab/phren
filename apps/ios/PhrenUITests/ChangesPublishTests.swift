import XCTest

/// Finishing a session from Changes: the commit composer, Push and Open pull
/// request with their phren dialogs, and the session card's pull request chip.
final class ChangesPublishTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor
    func testCommitPushAndOpenAPullRequestThenTheCardShowsIt() {
        let app = launchChanges(extra: ["--changes-feature-branch"])
        let message = field(app)
        XCTAssertTrue(message.waitForExistence(timeout: 8))
        message.tap()
        message.typeText("Finish the pull request screen")
        attachUIScreenshot(app, "Changes commit composer")
        app.buttons["changes-commit"].tap()
        let landed = app.staticTexts["changes-publish-landed"]
        XCTAssertTrue(landed.waitForExistence(timeout: 8))
        XCTAssertTrue(landed.label.hasPrefix("Committed a1b2c3d Finish the pull request screen"), landed.label)
        // Only the staged file was committed; the unstaged edits stay.
        XCTAssertTrue(app.buttons["changes-stage:Sources/App.swift"].exists)
        XCTAssertFalse(app.buttons["changes-commit"].isEnabled, "Nothing is staged now")

        let push = app.buttons["changes-push"]
        XCTAssertEqual(push.label, "Push new branch")
        push.tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes-push-dialog"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Push changes/pulls?"].exists)
        attachUIScreenshot(app, "Changes push dialog")
        app.buttons["changes-push-dialog:push"].tap()
        expectation(for: NSPredicate(format: "label == %@", "Pushed to origin/changes/pulls"), evaluatedWith: landed)
        waitForExpectations(timeout: 8)

        app.buttons["changes-open-pr"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes-pr-dialog"].waitForExistence(timeout: 5))
        attachUIScreenshot(app, "Changes pull request dialog")
        app.buttons["changes-pr-dialog:open"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes-pr-opened"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["https://github.com/sam/phren/pull/42"].exists)
        attachUIScreenshot(app, "Changes pull request opened")
        app.buttons["changes-pr-opened:done"].tap()
        XCTAssertTrue(app.buttons["changes-view-pr"].waitForExistence(timeout: 8), "The branch's pull request replaces Open pull request")

        // Back on the computer's list, the card carries the pull request.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        if app.buttons["chat-close"].waitForExistence(timeout: 5) { app.buttons["chat-close"].tap() }
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "live-pr:")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 8))
        XCTAssertEqual(chip.label, "Pull request 42, open, checks passing")
        attachUIScreenshot(app, "Session card pull request")
    }

    @MainActor
    func testHookRefusalIsShownVerbatimAndTheDefaultBranchAsksFirst() {
        let app = launchChanges(extra: ["--changes-commit-hook-fails"])
        let message = field(app)
        XCTAssertTrue(message.waitForExistence(timeout: 8))
        message.tap()
        message.typeText("Tune the accent")
        app.buttons["changes-commit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes-commit-refused"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "'accent' is never read")).firstMatch.exists,
                      "The hook's own output is shown")
        attachUIScreenshot(app, "Changes commit refused")
        app.buttons["changes-commit-refused:ok"].tap()
        // The draft survives a refusal so it can be sent again.
        XCTAssertEqual(field(app).value as? String, "Tune the accent")

        app.buttons["changes-push"].tap()
        XCTAssertTrue(app.staticTexts["Push to main, the default branch?"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["changes-push-dialog:push"].label, "Push to main")
        attachUIScreenshot(app, "Changes push default branch")
        app.buttons["changes-push-dialog:push"].tap()
        let landed = app.staticTexts["changes-publish-landed"]
        XCTAssertTrue(landed.waitForExistence(timeout: 8))
        XCTAssertEqual(landed.label, "Pushed to origin/main")
        XCTAssertFalse(app.buttons["changes-open-pr"].isEnabled, "No pull request from the default branch")
    }

    @MainActor
    func testTheOverviewRefreshShowsTheBranchPullRequestOnTheCard() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture",
                               "--native-chat-fixture", "--changes-feature-branch", "--changes-pull-open"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-pr:")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 12), "The overview's first reveal asks for the branch's pull request")
        XCTAssertEqual(chip.label, "Pull request 42, open, checks failing")
        attachUIScreenshot(app, "Overview card pull request")
    }

    @MainActor
    private func field(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "changes-commit-message").firstMatch
    }

    @MainActor
    private func launchChanges(extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = extra + ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture",
                                       "--native-chat-fixture", "--chat-diffs"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        for _ in 0..<14 {
            if host.exists && host.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(host.waitForExistence(timeout: 8), "The fixture computer must appear in Agents")
        host.tap()
        XCTAssertTrue(app.buttons["live-chat:w7:w7:t9"].waitForExistence(timeout: 10))
        app.buttons["live-chat:w7:w7:t9"].tap()
        openRepositoryChanges(in: app)
        let list = app.buttons["changes-mode-list"]
        if list.waitForExistence(timeout: 8) { list.tap() }
        return app
    }
}
