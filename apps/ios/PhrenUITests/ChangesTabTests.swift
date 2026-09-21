import XCTest

/// The Changes tab reached through the chat's diff button: the fixture's
/// repository diff must draw fold bars and a numbered gutter in Diff mode.
final class ChangesTabTests: XCTestCase {
    @MainActor
    func testChangesDiffModeDrawsFoldBarAndGutter() {
        let app = launchChanges()
        let diffMode = app.buttons["changes-mode-diff"]
        XCTAssertTrue(diffMode.waitForExistence(timeout: 10), "The Changes tab must offer a Diff mode")
        let tabBar = app.descendants(matching: .any).matching(identifier: "changes-tab-bar").firstMatch
        XCTAssertTrue(tabBar.exists)
        XCTAssertLessThan(tabBar.frame.height, 40, "The Changes tabs stay compact")
        app.buttons["changes-tab-tree"].tap()
        let treeRow = app.descendants(matching: .any).matching(identifier: "changes-tree-row:Sources").firstMatch
        XCTAssertTrue(treeRow.waitForExistence(timeout: 8))
        XCTAssertLessThan(treeRow.frame.height, 36, "Working tree rows stay compact")
        app.buttons["changes-tab-changes"].tap()
        app.buttons["changes-mode-list"].tap()
        let title = app.staticTexts["changes-title"]
        XCTAssertEqual(title.label, "Uncommitted changes")
        let wrap = app.navigationBars.buttons["changes-wrap-toggle"]
        XCTAssertTrue(wrap.exists, "Wrapping belongs in the navigation bar")
        let listShot = XCTAttachment(screenshot: app.screenshot())
        listShot.name = "Changes list"; listShot.lifetime = .keepAlways; add(listShot)
        diffMode.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "changes-fold").firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "diff-gutter-number").firstMatch.waitForExistence(timeout: 5))
        let header = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "changes-diff-header:")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertEqual(header.frame.width, app.frame.width, accuracy: 2)
        if wrap.label == "Wrap long lines" { wrap.tap() }
        for name in ["Changes diff wrapped", "Changes diff scrolling"] {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = name; shot.lifetime = .keepAlways; add(shot)
            wrap.tap()
            XCTAssertEqual(header.frame.width, app.frame.width, accuracy: 2)
        }
    }

    @MainActor
    func testChangesActionsRefreshTheSharedStatus() {
        let app = launchChanges()
        app.buttons["changes-mode-list"].tap()
        let stage = app.buttons["changes-stage:Sources/App.swift"]
        XCTAssertTrue(stage.waitForExistence(timeout: 8))
        stage.tap()
        let status = app.descendants(matching: .any).matching(identifier: "changes-status-line").firstMatch
        let staged = NSPredicate(format: "label CONTAINS %@", "1 unstaged")
        expectation(for: staged, evaluatedWith: status)
        waitForExpectations(timeout: 8)
        let unstage = app.buttons["changes-stage:Sources/App.swift"]
        if !unstage.isHittable { app.swipeUp() }
        unstage.tap()
        expectation(for: NSPredicate(format: "label CONTAINS %@", "2 unstaged"), evaluatedWith: status)
        waitForExpectations(timeout: 8)
        app.buttons["changes-revert:Notes.md"].tap()
        XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5))
        app.buttons["Discard"].tap()
        expectation(for: NSPredicate(format: "label CONTAINS %@", "0 untracked"), evaluatedWith: status)
        waitForExpectations(timeout: 8)
    }

    @MainActor
    private func launchChanges(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = extra + ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture",
                               "--native-chat-fixture", "--chat-diffs"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
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
        XCTAssertTrue(app.buttons["chat-diff"].waitForExistence(timeout: 8))
        app.buttons["chat-diff"].tap()
        return app
    }

}
