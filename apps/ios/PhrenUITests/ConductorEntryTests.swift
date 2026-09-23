import XCTest

final class ConductorEntryTests: XCTestCase {
    private let conductorKey = "A1000000-0000-0000-0000-000000000001:herdr:default:w9:w9:t1"

    @MainActor
    func testStartFromAgentsRestoresConductorChoicesAndCanChangeStore() {
        let app = launch(extra: ["--conductor-remembered-fixture"])
        let start = app.buttons["sessions-start-conductor"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        XCTAssertTrue(start.label.contains("sample/brain"))
        start.tap()

        let role = app.buttons["launch-role"]
        XCTAssertTrue(role.waitForExistence(timeout: 5))
        XCTAssertTrue((role.value as? String ?? "").contains("Conductor"))
        XCTAssertTrue((role.value as? String ?? "").contains("Claude Opus"))
        XCTAssertTrue((role.value as? String ?? "").contains("High"))
        role.tap()
        XCTAssertTrue(app.buttons["launch-role:conductor"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["launch-role:conductor"].isSelected)
        app.buttons["launch-role-done"].tap()

        app.buttons["launch-computer"].tap()
        let remembered = app.buttons["launch-computer:A1000000-0000-0000-0000-000000000002"]
        XCTAssertTrue(remembered.waitForExistence(timeout: 5))
        XCTAssertTrue(remembered.isSelected, "Restore the last conductor computer even when another computer has the project")
        app.buttons["launch-computer-done"].tap()
        attachUIScreenshot(app, "Conductor launch from Agents with remembered choices")

        app.buttons["launch-store"].tap()
        let team = app.buttons["launch-store:team/brain"]
        XCTAssertTrue(team.waitForExistence(timeout: 5)); team.tap()
        XCTAssertTrue(role.waitForExistence(timeout: 5))
        XCTAssertTrue((role.value as? String ?? "").contains("Conductor"))
        XCTAssertTrue((role.value as? String ?? "").contains("Codex"))
        XCTAssertTrue((role.value as? String ?? "").contains("Low"))
        app.buttons["launch-computer"].tap()
        let teamComputer = app.buttons["launch-computer:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(teamComputer.waitForExistence(timeout: 5))
        XCTAssertTrue(teamComputer.isSelected, "Each store remembers its own conductor computer")
        app.buttons["launch-computer-done"].tap()
        app.buttons["launch-cancel"].tap()
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        XCTAssertTrue(start.label.contains("team/brain"))
    }

    @MainActor
    func testRunningConductorReplacesStartAtTheSamePosition() {
        let app = launch()
        let start = app.buttons["sessions-start-conductor"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        let startY = start.frame.minY
        app.terminate()

        let running = launch(extra: ["--conductor-running-fixture"])
        let card = running.buttons["overview-chat:\(conductorKey)"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertFalse(running.buttons["sessions-start-conductor"].exists)
        XCTAssertEqual(card.frame.minY, startY, accuracy: 1)
        XCTAssertEqual(running.buttons.matching(identifier: "overview-chat:\(conductorKey)").count, 1)
        XCTAssertLessThan(card.frame.minY,
                          running.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"].frame.minY)
        attachUIScreenshot(running, "Running conductor replaces the launch row")
    }

    @MainActor
    func testGrantsOpensFromConductorChatOptions() {
        let app = launch(extra: ["--conductor-running-fixture", "--conductor-grants-fixture"])
        let card = app.buttons["overview-chat:\(conductorKey)"]
        XCTAssertTrue(card.waitForExistence(timeout: 10)); card.tap()
        // The conductor's header is its name and the options button only:
        // no store path, no changes, no grants control.
        let options = app.buttons["chat-options"]
        XCTAssertTrue(options.waitForExistence(timeout: 8))
        XCTAssertTrue(options.isHittable)
        XCTAssertFalse(app.staticTexts["chat-location"].exists)
        XCTAssertFalse(app.buttons["chat-diff"].exists)
        XCTAssertFalse(app.buttons["chat-conductor-grants"].exists)
        attachUIScreenshot(app, "Conductor header")
        options.tap()
        let grants = app.buttons["chat-options-grants"]
        XCTAssertTrue(grants.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat-diff"].exists)
        XCTAssertFalse(app.buttons["chat-link-project"].exists)
        grants.tap()
        XCTAssertTrue(app.buttons["conductor-grant-add"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["conductor-grant-revoke:0"].exists)
        attachUIScreenshot(app, "Grants reached from the conductor's chat options")
        // The editor's pickers open their cards (they raised a flag nothing presented).
        app.buttons["conductor-grant-add"].tap()
        let scope = app.buttons["conductor-grant-scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 5))
        scope.tap()
        let everywhere = app.buttons["conductor-grant-scope-option:global"]
        XCTAssertTrue(everywhere.waitForExistence(timeout: 5), "The Scope pill opens its choices")
        everywhere.tap()
        XCTAssertFalse(everywhere.waitForExistence(timeout: 1))
        let computers = app.buttons["conductor-grant-computers"]
        if computers.exists {
            computers.tap()
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "conductor-grant-computer-option:"))
                .firstMatch.waitForExistence(timeout: 5), "The Computers pill opens its choices")
        }
        attachUIScreenshot(app, "Grant editor pickers")
    }

    @MainActor
    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture",
                               "--native-chat-fixture", "--session-pins-reset", "--conductor-entry-fixture"] + extra
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        XCTAssertTrue(app.navigationBars["Live sessions"].waitForExistence(timeout: 5))
        return app
    }
}
