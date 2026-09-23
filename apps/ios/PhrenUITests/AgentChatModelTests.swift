import XCTest

/// The model picker, deferred switches and the /model command.
final class AgentChatModelTests: AgentChatUITestCase {
    @MainActor
    func testWorkingModelPickerOffersDeferredSwitchAndCancellation() {
        let app = launch(extra: ["--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/model")
        app.buttons["chat-send"].tap()
        let terra = app.buttons["model-option:gpt-5.6-terra"]
        XCTAssertTrue(terra.waitForExistence(timeout: 5))
        terra.tap()
        let afterTurn = app.buttons["chat-model-after-turn"]
        if !afterTurn.isHittable { app.swipeUp() }
        XCTAssertTrue(afterTurn.waitForExistence(timeout: 5))
        XCTAssertTrue(afterTurn.label.contains("Switch after this turn"))
        XCTAssertTrue(app.buttons["chat-model-cancel-switch"].exists)
        afterTurn.tap()
        let pending = app.buttons["chat-model-pending"]
        XCTAssertTrue(pending.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["chat-model-system-row"].exists)
        pending.tap()
        XCTAssertFalse(pending.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/model gpt-5.6-terra")).firstMatch.exists)
    }

    @MainActor
    func testDeferredModelSwitchRunsWhenTheTurnEnds() {
        let app = launch(extra: ["--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/model")
        app.buttons["chat-send"].tap()
        let terra = app.buttons["model-option:gpt-5.6-terra"]
        XCTAssertTrue(terra.waitForExistence(timeout: 5))
        terra.tap()
        let afterTurn = app.buttons["chat-model-after-turn"]
        XCTAssertTrue(afterTurn.waitForExistence(timeout: 5))
        afterTurn.tap()
        XCTAssertTrue(app.buttons["chat-model-pending"].waitForExistence(timeout: 5))
        app.buttons["chat-stop"].tap()
        let receipt = app.staticTexts["chat-model-system-row"]
        XCTAssertTrue(receipt.waitForExistence(timeout: 8))
        XCTAssertEqual(receipt.label, "Switched to GPT-5.6-Terra")
        XCTAssertFalse(app.buttons["chat-model-pending"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/model gpt-5.6-terra")).firstMatch.exists)
    }

    @MainActor
    func testSlashModelOpensAPickerAndShowsAVerifiedSystemRow() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/model")
        app.buttons["chat-send"].tap()
        let terra = app.buttons["model-option:gpt-5.6-terra"]
        XCTAssertTrue(terra.waitForExistence(timeout: 5), "The /model command opens the phone's own picker")
        XCTAssertTrue(app.buttons["model-option:gpt-6-astra"].exists, "The list is what the computer reports, not a built-in one")
        XCTAssertTrue(app.buttons["model-option:gpt-6-astra"].label.contains("default"))
        XCTAssertTrue(app.buttons["model-option:gpt-6-astra"].label.contains("Our most capable"))
        XCTAssertFalse(app.buttons["model-loading"].exists, "The catalogue has answered; no loading row remains")
        capture(app, "Model picker")
        terra.tap()
        let switched = app.staticTexts["chat-model-system-row"]
        XCTAssertTrue(switched.waitForExistence(timeout: 8))
        XCTAssertEqual(switched.label, "Switched to GPT-5.6-Terra")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/model gpt-5.6-terra")).firstMatch.exists)
        XCTAssertFalse(app.otherElements["herdr-terminal-header"].exists, "A model choice is answered in the transcript, not in the terminal")
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        // The same picker is one row in the options sheet.
        app.buttons["Chat options"].tap()
        XCTAssertTrue(app.buttons["chat-options-model"].waitForExistence(timeout: 5))
        app.buttons["chat-options-model"].tap()
        XCTAssertTrue(app.buttons["model-option:gpt-5.6-sol"].waitForExistence(timeout: 5))
        app.buttons["model-option-done"].tap()
    }

    @MainActor
    func testModelPickerWaitsOnTheComputersCatalogueAndThenShowsTheClaudeMenu() {
        let app = launch(extra: ["--chat-model-picker", "--chat-models-delayed", "--chat-model-1m"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/model")
        app.buttons["chat-send"].tap()
        // Until the computer's /v1/models answers: one loading row naming the
        // computer, no catalogue rows at all.
        let loading = app.buttons["model-loading"]
        XCTAssertTrue(loading.waitForExistence(timeout: 5), "The picker waits on the computer's catalogue")
        XCTAssertEqual(loading.label, "Loading models from Test Mac", "The loading row names the computer being asked")
        XCTAssertFalse(app.buttons["model-option:claude-fable-5-1"].exists, "No catalogue rows before the computer answers")
        capture(app, "Model picker loading")
        // The delayed answer is Claude Code's own /model menu, exact entries.
        let fable = app.buttons["model-option:claude-fable-5-1"]
        XCTAssertTrue(fable.waitForExistence(timeout: 10), "The Claude catalogue arrives")
        XCTAssertFalse(loading.exists, "The loading row leaves with the answer")
        for id in ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-1[1m]"] {
            XCTAssertTrue(app.buttons["model-option:\(id)"].exists, "The exact menu entry \(id)")
        }
        XCTAssertFalse(app.buttons["model-option:gpt-6-astra"].exists, "The list is Claude's, not Codex's")
        XCTAssertTrue(fable.label.contains("default"), "The default carries its chip")
        XCTAssertTrue(fable.frame.minY < app.buttons["model-option:claude-opus-5"].frame.minY,
                      "With no recents the default leads the catalogue")
        // The session runs on the 1M variant: its row, not the plain one, is checked.
        XCTAssertTrue(app.buttons["model-option:claude-fable-5-1[1m]"].isSelected,
                      "The session's exact id is the row checked")
        XCTAssertFalse(fable.isSelected, "The plain Fable row never steals the 1M row's mark")
        capture(app, "Model picker Claude")
        app.buttons["model-option-done"].tap()
    }

    @MainActor
    func testModelPickerFallsBackToThePerHarnessBuiltInListWhenTheRouteFails() {
        let app = launch(extra: ["--chat-model-picker", "--chat-models-fail"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/model")
        app.buttons["chat-send"].tap()
        let fable = app.buttons["model-option:claude-fable-5-1"]
        XCTAssertTrue(fable.waitForExistence(timeout: 5), "A failed route shows this harness's built-in list")
        XCTAssertFalse(app.buttons["model-loading"].exists, "The failure leaves the loading state")
        XCTAssertTrue(fable.label.contains("built-in"), "Built-in rows say so")
        XCTAssertTrue(fable.label.contains("default"), "The built-in default keeps its chip beside built-in")
        XCTAssertTrue(app.buttons["model-option:claude-fable-5-1[1m]"].exists, "The built-in list is Claude Code's menu")
        XCTAssertFalse(app.buttons["model-option:gpt-6-astra"].exists, "The fallback is this harness's list, never Codex's")
        capture(app, "Model picker built-in")
        app.buttons["model-option-done"].tap()
    }

    @MainActor
    func testModelPickerLeadsWithRecentlyUsedModels() {
        let app = launch(extra: ["--chat-model-picker"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/model")
        app.buttons["chat-send"].tap()
        let haiku = app.buttons["model-option:claude-haiku-4-5-20251001"]
        XCTAssertTrue(haiku.waitForExistence(timeout: 5))
        haiku.tap()
        let switched = app.staticTexts["chat-model-system-row"]
        XCTAssertTrue(switched.waitForExistence(timeout: 8))
        XCTAssertEqual(switched.label, "Switched to Haiku 4.5")
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        // The same picker is one row in the options sheet; the chosen model
        // now leads it, above the default the catalogue sent first.
        app.buttons["Chat options"].tap()
        XCTAssertTrue(app.buttons["chat-options-model"].waitForExistence(timeout: 5))
        app.buttons["chat-options-model"].tap()
        let recent = app.buttons["model-option:claude-haiku-4-5-20251001"]
        XCTAssertTrue(recent.waitForExistence(timeout: 5))
        let fable = app.buttons["model-option:claude-fable-5-1"]
        XCTAssertTrue(fable.exists)
        XCTAssertLessThan(recent.frame.minY, fable.frame.minY, "The recently used model leads the catalogue")
        XCTAssertLessThan(fable.frame.minY, app.buttons["model-option:claude-opus-5"].frame.minY,
                          "The catalogue tail keeps its order behind the recent lead")
        app.buttons["model-option-done"].tap()
    }
}
