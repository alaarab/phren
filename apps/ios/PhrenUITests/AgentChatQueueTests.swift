import XCTest

/// Held and steering messages, failed deliveries, and drafts that survive switching and relaunch.
final class AgentChatQueueTests: AgentChatUITestCase {
    @MainActor
    func testDraftAndAttachmentSurviveProcessRelaunch() {
        var app = launch(extra: ["--chat-persistent-draft", "--chat-clear-drafts"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        attachImage(app)
        composer.tap(); composer.typeText("Keep this across relaunch")
        app.terminate()
        app = launch(extra: ["--chat-persistent-draft"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let restored = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 8))
        XCTAssertEqual(restored.value as? String, "Keep this across relaunch")
        XCTAssertTrue(app.buttons["Preview Screenshot.png"].waitForExistence(timeout: 8))
        capture(app, "Draft restored after process relaunch")
    }

    @MainActor
    func testBlockedDeliveryRetainsDraftAndReusesSuccessfulUploadOnExplicitRetry() {
        let app = launch(extra: ["--chat-send-blocked-once"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        attachImage(app)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep this attachment")
        app.buttons["chat-send"].tap()
        let error = app.staticTexts["chat-delivery-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(error.label.hasPrefix("Your message hasn't been sent."))
        XCTAssertTrue(error.label.contains("pending question"))
        XCTAssertFalse(error.label.contains("upload"))
        XCTAssertEqual(composer.value as? String, "Keep this attachment")
        XCTAssertTrue(app.buttons["Remove Screenshot.png"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Received in codex")).firstMatch.exists)
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.buttons["View attached Screenshot.png"].waitForExistence(timeout: 8))
        XCTAssertFalse(error.exists, "The fixture rejects a duplicate upload, so a successful retry proves the path was reused")
        XCTAssertFalse(app.buttons["Remove Screenshot.png"].exists)
        XCTAssertEqual(composer.value as? String, "")
    }

    @MainActor
    func testCompletedTurnDrainsFollowUpsDespiteRepeatedStaleWorkingStatus() {
        let app = launch(extra: ["--chat-working", "--chat-queue-completion"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Working after the terminal answer."].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        for text in ["First", "Second"] {
            composer.tap(); composer.typeText(text)
            XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 3))
            app.buttons["chat-send"].tap()
        }
        // Finish the fixture's active turn once both messages are queued;
        // its status snapshots deliberately keep saying working. The draft
        // leaves the box on send, so the stop shows at once; it enables once
        // the send has finished.
        let stop = app.buttons["chat-stop"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: stop)], timeout: 5), .completed)
        stop.tap()
        XCTAssertTrue(app.staticTexts["Received: First"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Received: Second"].waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Third")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 3), "A follow-up after completion sends directly")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received: Third"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testRejectedSteeringWaitsForExplicitRetry() {
        let app = launch(extra: ["--chat-working", "--chat-send-rejected"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-stop"].waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Retry explicitly")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["chat-delivery-error"].waitForExistence(timeout: 8))
        XCTAssertEqual(composer.value as? String, "Retry explicitly")
        XCTAssertFalse(app.staticTexts["Received in codex on w7:p1: Retry explicitly"].waitForExistence(timeout: 2))
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Retry explicitly"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testSwitchAgentAcrossComputersPreservesSeparateDrafts() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--all-sessions-fixture", "--session-relative-time-fixture", "--native-chat-fixture", "--chat-persistent-draft", "--chat-clear-drafts"]
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let macID = "A1000000-0000-0000-0000-000000000001:herdr:default:w1:w1:t1"
        let linuxID = "A1000000-0000-0000-0000-000000000002:herdr:default:w1:w1:t1"
        let session = app.buttons["overview-chat:\(macID)"]
        XCTAssertTrue(session.waitForExistence(timeout: 8)); session.tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Mac draft")
        app.buttons["chat-switch-agent"].tap()
        let linux = app.buttons["switch-session:\(linuxID)"]
        app.buttons["agent-drawer-search-toggle"].tap()
        XCTAssertTrue(app.textFields["agent-drawer-search"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Finding your agents…"].exists, "The drawer reuses the revealed overview")
        app.buttons["agent-drawer-order-recent"].tap()
        capture(app, "Recent sessions drawer")
        app.buttons["agent-drawer-order-list"].tap()
        XCTAssertTrue(linux.waitForExistence(timeout: 8)); linux.tap()
        XCTAssertTrue(app.staticTexts["chat-location"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Test Linux"))
        XCTAssertNotEqual(composer.value as? String, "Mac draft")
        composer.tap(); composer.typeText("Linux draft")
        app.buttons["chat-switch-agent"].tap()
        let mac = app.buttons["switch-session:\(macID)"]
        XCTAssertTrue(mac.waitForExistence(timeout: 8)); mac.tap()
        let restored = NSPredicate { _, _ in composer.value as? String == "Mac draft" }
        expectation(for: restored, evaluatedWith: nil)
        waitForExpectations(timeout: 8)
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Test Mac"))
        capture(app, "Switched back to Mac with draft intact")
    }

    @MainActor
    func testRejectedSteeringSurvivesReactivationWithoutAnAutomaticRetry() {
        let app = launch(extra: ["--chat-send-rejected", "--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-stop"].waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep it up")
        app.buttons["chat-send"].tap()
        let error = app.staticTexts["chat-delivery-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(error.label.contains("The selected terminal is unavailable."))
        XCTAssertEqual(composer.value as? String, "Keep it up")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-remove:")).firstMatch.exists)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertFalse(app.staticTexts["Received in codex on w7:p1: Keep it up"].exists)
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Keep it up"].waitForExistence(timeout: 8))
        XCTAssertFalse(error.exists)
    }

    @MainActor
    func testClaudeSteeringAppearsAsAQueuedBubbleAndConsumptionClearsItsTag() {
        let app = launch(extra: ["--chat-working", "--chat-claude-queue"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-stop"].waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Run the queued checks")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Run the queued checks"].waitForExistence(timeout: 8))
        let tag = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-tag:")).firstMatch
        XCTAssertTrue(tag.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-remove:")).firstMatch.exists)
        capture(app, "Claude Code owns the queued instruction")
        app.buttons["chat-stop"].tap()
        XCTAssertTrue(app.staticTexts["Queued instructions consumed."].waitForExistence(timeout: 10))
        XCTAssertFalse(tag.exists)
        XCTAssertTrue(app.staticTexts["Run the queued checks"].exists)
    }

    @MainActor
    func testCodexSteeringGoesStraightToTheHarnessWhileWorking() {
        let app = launch(extra: ["--chat-working", "--chat-codex-queue"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-stop"].waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("First follow-up")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["First follow-up"].waitForExistence(timeout: 8))
        let tag = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-tag:")).firstMatch
        XCTAssertTrue(tag.waitForExistence(timeout: 5), "Only the harness transcript supplies queued state")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-remove:")).firstMatch.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-send:")).firstMatch.exists)
        app.buttons["chat-stop"].tap()
        XCTAssertTrue(app.staticTexts["Queued instructions consumed."].waitForExistence(timeout: 10))
        XCTAssertFalse(tag.exists)
        XCTAssertTrue(app.staticTexts["First follow-up"].exists)
    }

    @MainActor
    func testHeldPromptLabelsLocalPendingMessagesAndAllowsEditAndRemove() {
        let app = launch(extra: ["--chat-question"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Check the colors")
        let pending = app.buttons["chat-queue"]
        XCTAssertTrue(pending.waitForExistence(timeout: 5))
        pending.tap()
        XCTAssertTrue(app.staticTexts["Holding a prompt"].waitForExistence(timeout: 5))
        let edit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-edit:")).firstMatch
        XCTAssertTrue(edit.exists)
        edit.tap()
        XCTAssertEqual(composer.value as? String, "Check the colors")
        pending.tap()
        let remove = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-remove:")).firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        XCTAssertTrue(remove.waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testOfflineReconnectLivesInConnectionNoticeWithoutLosingDraft() {
        let app = launch(extra: ["--chat-offline"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep this while offline")
        let reconnect = app.buttons["chat-reconnect"]
        XCTAssertTrue(reconnect.waitForExistence(timeout: 8))
        app.buttons["Chat options"].tap()
        XCTAssertTrue(app.buttons["Herdr workspaces"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Herdr terminal"].exists)
        XCTAssertFalse(app.buttons["Slash commands"].exists)
        app.buttons["chat-options-done"].tap()
        XCTAssertTrue(reconnect.waitForExistence(timeout: 8))
        let pending = app.buttons["chat-queue"]
        XCTAssertTrue(pending.waitForExistence(timeout: 5))
        XCTAssertTrue(pending.isEnabled, "Offline text can be kept pending explicitly")
        XCTAssertEqual(pending.label, "Keep pending")
        XCTAssertFalse(app.buttons["chat-send"].exists)
        reconnect.tap()
        XCTAssertEqual(composer.value as? String, "Keep this while offline")
        XCTAssertFalse(app.staticTexts["Received in codex on w7:p1: Keep this while offline"].exists)
        capture(app, "Reconnect keeps the composer clear")
    }

    @MainActor
    func testFailedDeliveryKeepsDraftAndDoesNotRetryOnForeground() {
        let app = launch(extra: ["--chat-send-fails"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep this draft")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["chat-delivery-error"].waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "Keep this draft")
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertEqual(composer.value as? String, "Keep this draft")
        XCTAssertFalse(app.staticTexts["Received in codex on w7:p1: Keep this draft"].exists)
    }

    @MainActor
    func testProjectContextStaysInDraftUntilSentAndSurvivesReopening() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        app.buttons["Chat options"].tap()
        // Repository changes, linking and the model now share the options
        // sheet, so the Project section's last row starts below the medium fold.
        let addContext = app.buttons["Add project context"]
        let projectMemory = app.buttons["Project memory"]
        XCTAssertTrue(projectMemory.waitForExistence(timeout: 5))
        // The first swipe may grow the sheet to full height instead of
        // scrolling it, so open it fully first, then scroll to the row.
        let grabber = app.buttons["Sheet Grabber"]
        if grabber.exists { grabber.swipeUp() }
        for _ in 0..<6 where !(addContext.exists && addContext.isHittable) { projectMemory.swipeUp() }
        XCTAssertTrue(addContext.isHittable, "Add project context is reachable in the options sheet")
        addContext.tap()
        XCTAssertTrue(app.navigationBars["Project context"].waitForExistence(timeout: 5))
        app.buttons["[decision] Keep phone sessions connected to project memory"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue((composer.value as? String)?.contains("Finding — phone (sample/brain)") == true)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Received in codex")).firstMatch.exists)
        app.buttons["chat-close"].tap()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue((composer.value as? String)?.contains("Finding — phone (sample/brain)") == true)
    }
}
