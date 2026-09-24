import XCTest

/// The "Talk to my conductor" and "Pause all agents" intents, run through the
/// same app paths Siri, the Action button and Control Center use.
final class ConductorVoiceUITests: XCTestCase {
    /// Launches straight into what the intent opens: no list navigation first.
    @MainActor
    private func launch(extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture",
                               "--native-chat-fixture"] + extra
        app.launch()
        // The fixture runs the intent once the Agents list is up.
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        return app
    }

    @MainActor
    func testTalkToConductorOpensItsChatListening() {
        let app = launch(extra: ["--conductor-running-fixture", "--talk-fixture", "--talk-to-conductor-intent", "--chat-clear-drafts"])
        let status = app.staticTexts["talk-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 12), "The conductor's chat opens with talk mode on")
        XCTAssertTrue(app.buttons["chat-options"].exists)
        // The conductor's header is its name alone, with no project or location line.
        XCTAssertTrue(app.staticTexts["Conductor"].exists, "It is the conductor's chat, not another session's")
        XCTAssertFalse(app.staticTexts["chat-title"].exists)
        attachUIScreenshot(app, "Talk to my conductor")
        app.buttons["talk-stop"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["talk-bar"].waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testPauseAllConfirmsThenPausesTheWorkingAgents() {
        let app = launch(extra: ["--conductor-running-fixture", "--chat-working", "--pause-all-intent"])
        let dialog = app.descendants(matching: .any)["pause-all"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 12), "The control opens a confirmation, never a silent pause")
        XCTAssertTrue(app.staticTexts["Pause all agents?"].exists)
        let message = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Interrupts ")).firstMatch
        XCTAssertTrue(message.exists)
        XCTAssertTrue(message.label.contains("Polish the phone app"), message.label)
        XCTAssertFalse(message.label.contains("Phone conductor"), "The idle conductor is not paused")
        attachUIScreenshot(app, "Pause all agents confirmation")
        app.buttons["pause-all:confirm"].tap()
        let result = app.staticTexts["Paused 1 agent."]
        XCTAssertTrue(result.waitForExistence(timeout: 8))
        attachUIScreenshot(app, "Pause all agents result")
        app.buttons["pause-all-result:done"].tap()
        XCTAssertTrue(result.waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testCancellingPausesNothing() {
        let app = launch(extra: ["--conductor-running-fixture", "--chat-working", "--pause-all-intent"])
        XCTAssertTrue(app.buttons["pause-all:cancel"].waitForExistence(timeout: 12))
        app.buttons["pause-all:cancel"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["pause-all"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Paused")).firstMatch.exists)
    }
}
