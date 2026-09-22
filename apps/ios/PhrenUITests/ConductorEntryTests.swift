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
        XCTAssertTrue((role.value as? String ?? "").contains("high"))
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
        XCTAssertTrue((role.value as? String ?? "").contains("low"))
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
        XCTAssertLessThan(startY, app.textFields["sessions-search"].frame.minY)
        app.terminate()

        let running = launch(extra: ["--conductor-running-fixture"])
        let card = running.buttons["overview-chat:\(conductorKey)"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertFalse(running.buttons["sessions-start-conductor"].exists)
        XCTAssertEqual(card.frame.minY, startY, accuracy: 1)
        XCTAssertEqual(running.buttons.matching(identifier: "overview-chat:\(conductorKey)").count, 1)
        XCTAssertLessThan(card.frame.minY, running.textFields["sessions-search"].frame.minY)
        XCTAssertLessThan(card.frame.minY,
                          running.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"].frame.minY)
        attachUIScreenshot(running, "Running conductor replaces the launch row")

        let search = running.textFields["sessions-search"]
        search.tap(); search.typeText("no-such-session")
        XCTAssertTrue(running.staticTexts["No matching sessions"].waitForExistence(timeout: 5))
        XCTAssertTrue(card.exists, "Searching ordinary sessions keeps the conductor pinned")
        XCTAssertFalse(running.buttons["sessions-start-conductor"].exists)
    }

    @MainActor
    func testGrantsOpensDirectlyFromConductorChatHeader() {
        let app = launch(extra: ["--conductor-running-fixture", "--conductor-grants-fixture"])
        let card = app.buttons["overview-chat:\(conductorKey)"]
        XCTAssertTrue(card.waitForExistence(timeout: 10)); card.tap()
        let grants = app.buttons["chat-conductor-grants"]
        XCTAssertTrue(grants.waitForExistence(timeout: 8))
        XCTAssertTrue(grants.isHittable)
        XCTAssertTrue(app.buttons["chat-options"].exists)
        XCTAssertFalse(app.buttons["chat-options-grants"].exists)
        attachUIScreenshot(app, "Conductor header Grants control")
        grants.tap()
        XCTAssertTrue(app.buttons["conductor-grant-add"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["conductor-grant-revoke:0"].exists)
        attachUIScreenshot(app, "Grants reached from the conductor header")
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
