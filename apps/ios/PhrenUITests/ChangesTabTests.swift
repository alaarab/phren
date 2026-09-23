import XCTest

/// The Changes tab reached through the chat's diff button: the fixture's
/// repository diff must draw fold bars and a numbered gutter in Diff mode.
final class ChangesTabTests: XCTestCase {
    @MainActor
    func testSessionCodeAndTreeSymbolsReturnNotesToTheSameAgent() {
        let app = launchChanges(extra: ["--code-fixture"])
        let code = app.buttons["changes-tab-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 8)); code.tap()
        XCTAssertTrue(app.textFields["code-search"].waitForExistence(timeout: 8))
        attachUIScreenshot(app, "Session Code tab")
        app.buttons["changes-tab-tree"].tap()
        let directory = app.buttons["changes-tree-entry:Sources"]
        XCTAssertTrue(directory.waitForExistence(timeout: 8)); directory.tap()
        let symbol = app.buttons["changes-tree-symbols:Sources/App.swift"]
        XCTAssertTrue(symbol.waitForExistence(timeout: 8))
        attachUIScreenshot(app, "Working tree symbol summaries")
        app.buttons["changes-tab-history"].tap()
        app.buttons["changes-tab-tree"].tap()
        XCTAssertTrue(symbol.waitForExistence(timeout: 8), "Expanded branches survive tab switches")
        app.scrollViews.firstMatch.swipeDown()
        XCTAssertTrue(symbol.waitForExistence(timeout: 8), "Expanded branches survive refresh")
        symbol.tap()
        let line = app.buttons["code-line:5"]
        XCTAssertTrue(line.waitForExistence(timeout: 8)); line.tap()
        let note = app.descendants(matching: .any).matching(identifier: "code-note").firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 5)); note.tap(); note.typeText("Keep coordinates stable.")
        app.buttons["code-send"].tap()
        XCTAssertTrue(app.staticTexts["Saved and sent to this session."].waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["Send code note"].exists)
        attachUIScreenshot(app, "Code note sent to originating session")
    }

    @MainActor
    func testTappingAFileInListOpensItsDiff() {
        let app = launchChanges()
        let list = app.buttons["changes-mode-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        list.tap()
        // The last file in the diff, so opening it has to scroll.
        let row = app.buttons.matching(identifier: "changes-open:Sources/App/Settings.swift").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8), "A changed file row opens its diff")
        row.tap()
        XCTAssertTrue(app.buttons["changes-mode-diff"].isSelected, "Tapping a file switches to Diff")
        let header = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "changes-diff-header:", "Sources/App/Settings.swift")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 10))
        XCTAssertTrue(header.isHittable, "The tapped file's diff is on screen")
        // The last file can only scroll as far as the end of the diff, so it
        // is checked for being on screen rather than at the very top.
        XCTAssertGreaterThanOrEqual(header.frame.minY, 0)
        XCTAssertLessThan(header.frame.maxY, app.frame.height, "The tapped file's diff is on screen")
        attachUIScreenshot(app, "File opened from List")
    }

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
        attachUIScreenshot(app, "Changes list")
        diffMode.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "changes-fold").firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "diff-gutter-number").firstMatch.waitForExistence(timeout: 5))
        let header = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "changes-diff-header:")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertEqual(header.frame.width, app.frame.width, accuracy: 2)
        if wrap.label == "Wrap long lines" { wrap.tap() }
        for name in ["Changes diff wrapped", "Changes diff scrolling"] {
            attachUIScreenshot(app, name)
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
        return app
    }

}
