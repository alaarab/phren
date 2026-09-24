import XCTest

/// The Changes screen's History and Branches tabs, opened from the existing
/// native-chat fixture, whose answers for `/v1/git/log` and `/v1/git/branches`
/// live in `AgentChatFixture`.
final class ChangesHistoryBranchesTests: XCTestCase {
    @MainActor
    func testHistoryAndBranchesTabs() {
        let app = launch(extra: ["--chat-diffs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        openRepositoryChanges(in: app)

        let history = app.buttons["changes-tab-history"]
        XCTAssertTrue(history.waitForExistence(timeout: 8), "The Changes screen shows a History tab")
        history.tap()
        let commit = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "changes-history-commit")).firstMatch
        XCTAssertTrue(commit.waitForExistence(timeout: 8), "A commit row is shown")
        capture(app, "Changes history")

        app.buttons["changes-tab-branches"].tap()
        let current = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "changes-branches-branch:main")).firstMatch
        XCTAssertTrue(current.waitForExistence(timeout: 8), "The current branch row is shown")
        capture(app, "Changes branches")
        app.buttons["changes-branches-branch:release/1.0"].tap()
        XCTAssertTrue(app.staticTexts["changes-history-ref"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "changes-history-commit:a1b2c3d").firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "changes-history-commit:9f8e7d6").firstMatch.exists)
        capture(app, "Selected branch history")
    }

    @MainActor
    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"] + extra
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
            app.tabBars.buttons["Agents"].tap()
            let revealed = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "live-host:")).firstMatch
            if revealed.waitForExistence(timeout: attempt == 0 ? 12 : 25) || app.staticTexts["agents-introduction"].exists == false { break }
            if attempt == 0 { app.terminate() }
        }
        for _ in 0..<14 {
            if host.exists && host.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(host.waitForExistence(timeout: 5), "The fixture computer must appear in Agents")
        host.tap()
        XCTAssertTrue(app.buttons["live-chat:w7:w7:t9"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}
