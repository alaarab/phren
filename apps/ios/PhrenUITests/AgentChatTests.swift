import XCTest

final class AgentChatTests: XCTestCase {
    @MainActor
    func testDownwardDragOnComposerAndIconsDismissesKeyboardWithoutSending() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        let draft = "Keep my draft while I swipe"
        composer.tap(); composer.typeText(draft)
        let horizontalStart = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
        horizontalStart.press(forDuration: 0.05, thenDragTo: horizontalStart.withOffset(CGVector(dx: 100, dy: 0)))
        XCTAssertTrue(app.keyboards.firstMatch.exists, "A horizontal editing gesture must not dismiss the keyboard")

        for surface in [composer, app.buttons["chat-composer-terminal"], app.buttons["chat-send"]] {
            composer.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 8, dy: 110)))
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
            XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
            XCTAssertEqual(composer.value as? String, draft)
            XCTAssertTrue(app.buttons["chat-close"].isHittable, "Swiping a terminal icon must not open it")
            XCTAssertFalse(app.staticTexts["Received in codex on w7:p1: \(draft)"].exists, "Swiping Send must not send")
        }
        capture(app, "Keyboard dismissed by dragging the message box or icons")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: \(draft)"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testOpeningSpinnerIsCenteredInTheConversation() {
        let app = launch(extra: ["--chat-opening-slow"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let spinner = app.activityIndicators["chat-opening-spinner"]
        XCTAssertTrue(spinner.waitForExistence(timeout: 2))
        let conversation = app.scrollViews["chat-transcript"]
        XCTAssertTrue(conversation.exists)
        XCTAssertEqual(spinner.frame.midY, conversation.frame.midY, accuracy: 12)
        XCTAssertEqual(spinner.frame.midX, conversation.frame.midX, accuracy: 12)
        capture(app, "Conversation loading centered above composer")
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 8))
        XCTAssertFalse(spinner.exists)
    }

    @MainActor
    func testLargeTextCommandMenuLeavesComposerAndKeyboardUsable() {
        let app = launch(extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/")
        let menu = app.descendants(matching: .any).matching(identifier: "chat-command-menu").firstMatch
        XCTAssertLessThan(menu.frame.height, 300)
        XCTAssertTrue(composer.isHittable)
        XCTAssertTrue(app.buttons["chat-send"].isHittable)
        XCTAssertTrue(app.buttons["chat-command:/model"].isHittable)
        capture(app, "Vertical slash commands with accessibility text")
        app.buttons["chat-command:/model"].tap()
        XCTAssertEqual(composer.value as? String, "/model ")
    }

    @MainActor
    func testTranscriptLinkStillOpensWhileKeyboardIsVisible() {
        let app = launch(extra: ["--chat-link", "--capture-chat-links"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Keep my draft")
        let link = app.links["Open linked page"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        app.buttons["chat-close"].tap()
        let captured = app.staticTexts["chat-opened-url"]
        XCTAssertTrue(captured.waitForExistence(timeout: 5))
        XCTAssertEqual(captured.label, "https://example.org/phren-fixture")
    }

    @MainActor
    func testCompactBottomComposerAndTapToDismissKeyboard() {
        let app = launch(extra: ["--chat-markdown"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertLessThan(composer.frame.height, 60)
        let box = app.descendants(matching: .any).matching(identifier: "chat-message-box").firstMatch
        XCTAssertGreaterThan(box.frame.maxY, app.frame.maxY - 50)
        XCTAssertLessThan(box.frame.height, 100)
        XCTAssertGreaterThan(composer.frame.width, app.frame.width - 55)
        let lastLine = app.staticTexts["Ready to test."]
        XCTAssertTrue(lastLine.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        composer.tap(); composer.typeText("Keep this draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        capture(app, "Smaller chat text and bottom composer")
        app.staticTexts["Ready to test."].tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertEqual(composer.value as? String, "Keep this draft")
        XCTAssertGreaterThan(box.frame.maxY, app.frame.maxY - 50)
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.buttons["Copy code"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)], timeout: 5), .completed)
        capture(app, "Chat keyboard dismissed without losing the draft")
    }

    @MainActor
    func testCopilotChatAndCustomSlashCommandOpenExactTerminal() {
        let app = launch(extra: ["--chat-copilot"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Copilot is connected to this project. What would you like to change?"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Copilot"))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Check the layout")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in copilot on w7:p1: Check the layout"].waitForExistence(timeout: 8))
        capture(app, "Native GitHub Copilot chat")
        composer.tap(); composer.typeText("/my-plugin/review path.swift --strict")
        XCTAssertTrue(app.buttons["chat-all-commands"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        app.buttons["herdr-terminal-back"].tap()
        XCTAssertTrue(app.staticTexts["Received in copilot on w7:p1: /my-plugin/review path.swift --strict"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testSlashSuggestionsAndFullMenuPreserveDraftWithoutSubmitting() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/mo")
        XCTAssertTrue(app.buttons["chat-command:/model"].label.contains("Choose the model"))
        let menu = app.descendants(matching: .any).matching(identifier: "chat-command-menu").firstMatch
        XCTAssertLessThan(menu.frame.maxY, composer.frame.minY)
        XCTAssertGreaterThan(menu.frame.width, app.frame.width - 40)
        capture(app, "Vertical slash command suggestions above the draft")
        app.buttons["chat-command:/model"].tap()
        XCTAssertEqual(composer.value as? String, "/model ")
        app.buttons["chat-all-commands"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        let report = app.staticTexts["terminal-fixture-report"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let value = try? JSONSerialization.jsonObject(with: Data(report.label.utf8)) as? [String: Any]
            return value?["input"] as? String == "/"
        }, object: report)], timeout: 5), .completed)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertEqual(composer.value as? String, "/model ")
    }

    @MainActor
    func testSlashMenuRowsStayVerticalAndScrollable() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/")
        let first = app.buttons["chat-command:/model"].frame
        let second = app.buttons["chat-command:/permissions"].frame
        XCTAssertEqual(first.minX, second.minX, accuracy: 1)
        XCTAssertGreaterThanOrEqual(second.minY, first.maxY)
        XCTAssertGreaterThanOrEqual(first.height, 44)
        XCTAssertLessThan(app.descendants(matching: .any).matching(identifier: "chat-command-menu").firstMatch.frame.height, 300)
        capture(app, "Compact vertical command menu")
        app.scrollViews["chat-command-list"].swipeUp()
        XCTAssertTrue(app.buttons["chat-command:/mcp"].isHittable)
        app.buttons["chat-command:/mcp"].tap()
        XCTAssertEqual(composer.value as? String, "/mcp ")
        XCTAssertFalse(app.buttons["chat-command:/model"].exists)
    }

    @MainActor
    func testCompactActivityAndDirectTerminalKeepConversationUsable() {
        let app = launch(extra: ["--chat-design"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let group = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 8))
        XCTAssertEqual(group.label, "Shell, 1 operation")
        XCTAssertEqual(group.value as? String, "Collapsed")
        XCTAssertLessThanOrEqual(group.frame.height, 44, "The compact tool pill retains a larger accessible tap target")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        XCTAssertFalse(app.staticTexts["All 4 timeline tests passed."].exists)
        XCTAssertFalse(app.buttons["Latest messages"].exists, "A settled conversation already at the bottom does not need a jump button")
        let introduction = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "I'll tighten the session header")).firstMatch
        XCTAssertLessThanOrEqual(group.frame.minY - introduction.frame.maxY, 18, "Trailing transcript newlines must not add space above tools")
        capture(app, "Custom chat with compact activity")
        group.tap()
        XCTAssertEqual(group.value as? String, "Expanded")
        XCTAssertFalse(app.staticTexts["All 4 timeline tests passed."].exists, "Another tool must stay collapsed")
        XCTAssertTrue(app.staticTexts["3 files changed, 42 insertions(+), 18 deletions(-)"].exists)
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:")).element(boundBy: 1)
        XCTAssertEqual(second.value as? String, "Collapsed")
        second.tap()
        XCTAssertTrue(app.staticTexts["All 4 timeline tests passed."].exists)
        second.tap()
        capture(app, "Expanded commands and results")
        group.tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep the Phren details")
        capture(app, "Integrated composer with keyboard")
        app.buttons["chat-terminal"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Agent chat"].exists)
        XCTAssertEqual(composer.value as? String, "Keep the Phren details")
        app.buttons["chat-close"].tap()
        XCTAssertTrue(app.buttons["live-chat:w7:w7:t9"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testCustomChatWithLargeTextKeepsActionsReachable() {
        let app = launch(extra: ["--chat-design", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 8))
        for identifier in ["chat-close", "chat-terminal", "Chat options", "Add attachment", "Dictate message"] {
            XCTAssertTrue(app.buttons[identifier].isHittable, identifier)
        }
        capture(app, "Custom chat at accessibility text size")
        app.buttons["chat-close"].tap()
        XCTAssertTrue(app.buttons["live-chat:w7:w7:t9"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testWaitingProgressTokenUsageAndFinishedReply() {
        let app = launch(extra: ["--chat-streaming"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Ready to stream a reply."].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Show me the reply")
        app.buttons["chat-send"].tap()
        let activity = app.descendants(matching: .any).matching(identifier: "chat-activity").firstMatch
        let header = app.descendants(matching: .any).matching(identifier: "chat-header").firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 3))
        XCTAssertEqual(activity.label, "Waiting for agent…")
        XCTAssertTrue(header.frame.contains(activity.frame), "Activity belongs in the existing header")
        XCTAssertLessThanOrEqual(activity.frame.height, 16)
        XCTAssertFalse(app.buttons["chat-token-usage"].exists, "Usage must not take space above the composer")
        capture(app, "Waiting for the agent to respond")
        let growing = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "The reply is arriving word by word.")).firstMatch
        var partialCount = 0
        // Observe the text in the same polling pass as the activity state.
        // A second waitForExistence adds a full polling interval, which can
        // miss the short reveal entirely on fast devices.
        let receiving = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard growing.exists, activity.label == "Receiving reply…" else { return false }
            partialCount = growing.label.count
            return partialCount > 0
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [receiving], timeout: 8), .completed)
        capture(app, "Reply appearing progressively")
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Finished"), object: activity)
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 15), .completed)
        XCTAssertFalse(app.buttons["chat-token-usage"].exists)
        let reply = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "The reply is arriving word by word.")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertTrue(reply.label.hasSuffix("conversation."))
        XCTAssertGreaterThan(reply.label.count, partialCount, "The reply should grow after its first visible words")
        capture(app, "Completed streamed reply and reported tokens")
        app.buttons["Chat options"].tap()
        XCTAssertTrue(app.buttons["chat-token-usage"].waitForExistence(timeout: 5))
        app.buttons["chat-token-usage"].tap()
        XCTAssertTrue(app.staticTexts["Latest model response"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "usage-output").firstMatch.label.contains("85"))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "usage-total-input").firstMatch.label.contains("128"))
        capture(app, "Latest model response usage")
    }

    @MainActor
    func testHerdrWorkspaceBrowserAndNamedServerSelection() {
        let app = launch()
        app.buttons["Herdr workspaces & terminal"].tap()
        XCTAssertTrue(app.navigationBars["Herdr"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Phone work"].waitForExistence(timeout: 8))
        capture(app, "Herdr workspace browser")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Herdr server")).firstMatch.tap()
        app.buttons["work"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Herdr server", "work")).firstMatch.waitForExistence(timeout: 8))
        app.buttons["Open Herdr terminal"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Test Mac · work"].waitForExistence(timeout: 8))
    }
    @MainActor
    func testInlineApprovalAndQuestionAnswers() {
        var app = launch(extra: ["--chat-approval"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["Approve"].waitForExistence(timeout: 8))
        capture(app, "Inline approval in Phren")
        app.buttons["Approve"].tap()
        XCTAssertTrue(app.staticTexts["Answer received in this conversation."].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Approve"].exists)
        app.terminate()
        app = launch(extra: ["--chat-question"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["Send answer"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Send answer"].isEnabled)
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Keep the Phren accent")).firstMatch.tap()
        capture(app, "Inline question in Phren")
        XCTAssertTrue(app.buttons["Send answer"].isEnabled)
        app.buttons["Send answer"].tap()
        XCTAssertTrue(app.staticTexts["Answer received in this conversation."].waitForExistence(timeout: 8))
    }

    @MainActor
    func testApprovalStaysVisibleAboveHistoryAndCanBeDenied() {
        let app = launch(extra: ["--chat-approval", "--chat-long-history"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let deny = app.buttons["chat-approval-deny"]
        XCTAssertTrue(deny.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["chat-approval-terminal"].isHittable)
        app.scrollViews["chat-transcript"].swipeDown()
        XCTAssertTrue(deny.isHittable)
        capture(app, "Pinned permission controls")
        deny.tap()
        let cleared = NSPredicate(format: "exists == false")
        expectation(for: cleared, evaluatedWith: deny)
        waitForExpectations(timeout: 8)
        XCTAssertFalse(deny.exists)
    }

    @MainActor
    func testLiveActivityCanDenyTheExactRequest() {
        let app = launch(extra: ["--chat-approval", "--approval-live-activity"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-approval-deny"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.025)).press(forDuration: 1.5)
        XCTAssertTrue(springboard.buttons["Deny"].waitForExistence(timeout: 10))
        capture(springboard, "Permission Live Activity")
        springboard.buttons["Deny"].tap()
        XCTAssertTrue(app.alerts["Permission request"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Denial sent."].exists)
        app.alerts.buttons["OK"].tap()
    }

    @MainActor
    func testHistoricalImageDiffAndNativeHerdrNavigation() {
        let app = launch(extra: ["--chat-historical-image"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["View conversation image"].waitForExistence(timeout: 8))
        app.buttons["View conversation image"].tap()
        XCTAssertTrue(app.navigationBars["Conversation image.jpg"].waitForExistence(timeout: 5))
        app.navigationBars["Conversation image.jpg"].buttons["Done"].tap()
        app.buttons["Chat options"].tap()
        app.buttons["Repository changes"].tap()
        XCTAssertTrue(app.staticTexts["Theme.swift"].waitForExistence(timeout: 5))
        app.staticTexts["Theme.swift"].tap()
        capture(app, "Native repository diff")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Chat options"].tap()
        app.buttons["Herdr terminal"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Toggle terminal keyboard"].waitForExistence(timeout: 8))
        capture(app, "Native Herdr terminal")
    }

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
    func testLongToolOutputStaysBoundedAndOpensSeparately() {
        let app = launch(extra: ["--chat-long-tools"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 8))
        XCTAssertEqual(rows.count, 3)
        rows.firstMatch.tap()
        let preview = app.staticTexts["chat-tool-preview:3:0"]
        XCTAssertTrue(preview.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(preview.frame.height, 110)
        XCTAssertFalse(preview.label.contains("line 6:"))
        XCTAssertEqual(rows.element(boundBy: 1).value as? String, "Collapsed")
        XCTAssertEqual(rows.element(boundBy: 2).value as? String, "Collapsed")
        capture(app, "Independent tool rows with six-line output preview")
        app.buttons["chat-tool-output:3:0"].tap()
        XCTAssertTrue(app.navigationBars["Tool Result"].waitForExistence(timeout: 3))
        app.buttons["chat-tool-output-last"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final output marker 0")).firstMatch.exists)
        app.buttons["chat-tool-output-done"].tap()
        rows.firstMatch.tap()
        XCTAssertEqual(rows.firstMatch.value as? String, "Collapsed")
        XCTAssertTrue(app.buttons["chat-close"].isHittable)
    }

    @MainActor
    func testDenseToolOutputPagesKeepEveryLineReachable() {
        let app = launch(extra: ["--chat-dense-tools"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 8))
        rows.firstMatch.tap()
        app.buttons["chat-tool-output:3:0"].tap()
        XCTAssertTrue(app.navigationBars["Tool Result"].waitForExistence(timeout: 3))
        let range = app.staticTexts["chat-tool-output-page-range"]
        guard range.waitForExistence(timeout: 3) else {
            XCTFail("Dense output must use bounded pages instead of laying out all 8,001 lines")
            return
        }
        XCTAssertEqual(range.label, "Lines 1–120 of 8001")
        app.buttons["chat-tool-output-next"].tap()
        XCTAssertEqual(range.label, "Lines 121–240 of 8001")
        app.buttons["chat-tool-output-last"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final dense output marker 0")).firstMatch.exists)
        app.buttons["chat-tool-output-previous"].tap()
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final dense output marker 0")).firstMatch.exists)
        app.buttons["chat-tool-output-first"].tap()
        XCTAssertEqual(range.label, "Lines 1–120 of 8001")
        app.buttons["chat-tool-output-done"].tap()
        XCTAssertEqual(rows.element(boundBy: 1).value as? String, "Collapsed")
        XCTAssertTrue(app.buttons["chat-close"].isHittable)
    }

    @MainActor
    func testDensePatchPagesPreserveSemanticRowsAndCollapse() {
        let app = launch(extra: ["--chat-dense-diff"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let group = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 8))
        group.tap()
        let expand = app.buttons["chat-patch-expand"]
        XCTAssertTrue(expand.waitForExistence(timeout: 3))
        expand.tap()
        let range = app.staticTexts["chat-patch-page-range"]
        XCTAssertTrue(range.waitForExistence(timeout: 3))
        XCTAssertEqual(range.label, "Lines 1–120 of 2002")
        app.buttons["chat-patch-next"].tap()
        XCTAssertEqual(range.label, "Lines 121–240 of 2002")
        app.buttons["chat-patch-last"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+Final dense patch marker")).firstMatch.exists)
        XCTAssertTrue(app.buttons["Copy patch"].exists)
        expand.tap()
        XCTAssertFalse(range.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+Final dense patch marker")).firstMatch.exists)
        XCTAssertTrue(app.buttons["chat-close"].isHittable)
    }

    @MainActor
    func testToolPatchShowsChangesAndUnwrapsResult() {
        let app = launch(extra: ["--chat-diffs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let group = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 8))
        XCTAssertTrue(group.label.contains("Patch"))
        group.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let action = phrenPurple")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Updated Theme.swift"].exists)
        XCTAssertTrue(app.buttons["Copy patch"].exists)
        capture(app, "Phren purple actions and native tool diff")
    }
    /// Seed this simulator with `xcrun simctl addmedia <device> <test-image>`.
    @MainActor
    func testSystemPhotoPickerPreparesAnAttachment() throws {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        app.buttons["Add attachment"].tap()
        app.buttons["Photos"].tap()
        let picker = app.scrollViews["photosView_content_scroll_view"]
        XCTAssertTrue(picker.waitForExistence(timeout: 8))
        let introduction = picker.buttons["Close"].firstMatch
        if introduction.exists { introduction.tap() }
        let photo = picker.images.firstMatch
        guard photo.waitForExistence(timeout: 8) else {
            throw XCTSkip("Seed the UI test simulator with a photo to exercise the system picker")
        }
        // Photos' remote grid exposes its image frame but not AX hit testing.
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let done = app.navigationBars["Photos"].buttons["Done"]
        if done.waitForExistence(timeout: 3) { done.tap() }
        else { app.buttons["Add"].firstMatch.tap() }
        let preview = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Preview Image.")).firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 10))
        capture(app, "System photo picker attachment")
    }

    @MainActor
    func testImageAttachmentCanBeRemovedPreviewedAndSent() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        attachImage(app)
        XCTAssertTrue(app.buttons["Preview Screenshot.png"].waitForExistence(timeout: 5))
        app.buttons["Preview Screenshot.png"].tap()
        XCTAssertTrue(app.navigationBars["Screenshot.png"].waitForExistence(timeout: 5))
        app.navigationBars["Screenshot.png"].buttons["Done"].tap()
        app.buttons["Remove Screenshot.png"].tap()
        XCTAssertFalse(app.buttons["Preview Screenshot.png"].exists)
        attachImage(app)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Review this screenshot")
        capture(app, "Image and prompt ready to send")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.buttons["View attached Screenshot.png"].waitForExistence(timeout: 8))
        capture(app, "Sent image in conversation")
        if app.buttons["Latest messages"].isHittable { app.buttons["Latest messages"].tap() }
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Received in codex", "/tmp/phren-fixture/")).firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Remove Screenshot.png"].exists)
    }

    @MainActor
    func testFailedUploadRetainsImageAndTextWithoutSending() {
        let app = launch(extra: ["--chat-upload-fails"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        attachImage(app)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep my screenshot")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["chat-delivery-error"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["chat-delivery-error"].label.contains("message hasn't been sent"))
        XCTAssertEqual(composer.value as? String, "Keep my screenshot")
        XCTAssertTrue(app.buttons["Remove Screenshot.png"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Received in codex")).firstMatch.exists)
    }

    @MainActor
    func testEarlierHistorySurvivesLiveRefresh() {
        let app = launch(extra: ["--chat-history"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Earlier project discussion"].waitForExistence(timeout: 5))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(app.staticTexts["Earlier project discussion"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-history"].exists)
    }

    @MainActor
    func testHistoryContinuesPastMetadataOnlyPage() {
        let app = launch(extra: ["--chat-history", "--chat-metadata-history"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Earlier project discussion"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Retry loading earlier messages"].exists)
    }

    @MainActor
    func testScrollingUpLoadsHistoryWithoutAButton() {
        let app = launch(extra: ["--chat-history", "--chat-long-history"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Recent discussion 19.")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Earlier project discussion"].exists)
        for _ in 0..<10 where !app.staticTexts["Earlier project discussion"].exists { transcript.swipeDown(velocity: .fast) }
        XCTAssertTrue(app.staticTexts["Earlier project discussion"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Load earlier messages"].exists)
        XCTAssertTrue(app.buttons["chat-close"].exists)
    }

    @MainActor
    func testSwitchAgentAcrossComputersPreservesSeparateDrafts() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--all-sessions-fixture", "--native-chat-fixture", "--chat-persistent-draft", "--chat-clear-drafts"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
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
    func testStopAndCodeCardsWorkInsideChat() {
        let app = launch(extra: ["--chat-working", "--chat-markdown"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-stop"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-send"].exists, "Stop occupies the send control")
        app.buttons["Copy code"].tap()
        app.buttons["chat-stop"].tap()
        XCTAssertTrue(app.staticTexts["Turn stopped in the selected pane."].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["chat-send"].exists)
        XCTAssertFalse(app.buttons["chat-stop"].exists)
        capture(app, "Native code card and stopped turn")
    }

    @MainActor private func attachImage(_ app: XCUIApplication) {
        app.buttons["Add attachment"].tap()
        XCTAssertTrue(app.buttons["Add test image"].waitForExistence(timeout: 5))
        app.buttons["Add test image"].tap()
    }

    @MainActor
    func testNativeChatReadsAndRepliesToTheSelectedConversation() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Use the cyan accent")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Use the cyan accent"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Open workspace link"].exists)
        capture(app, "Native agent conversation in Phren")
        app.buttons["Chat options"].tap()
        app.buttons["Project memory"].tap()
        XCTAssertTrue(app.navigationBars["phone · brain"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testMultipleAgentsRequireAPaneChoiceAndReplyToThatPane() {
        let app = launch(extra: ["--chat-multiple"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-pane:w7:p2"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-send"].isEnabled)
        app.buttons["chat-pane:w7:p2"].tap()
        XCTAssertTrue(app.staticTexts["I reviewed the changes. The project navigation looks consistent."].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Check the toolbar")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in claude on w7:p2: Check the toolbar"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testRejectedSendKeepsDraftAndAllowsExplicitRetry() {
        let app = launch(extra: ["--chat-send-rejected", "--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep it up")
        app.buttons["chat-send"].tap()
        let error = app.staticTexts["chat-delivery-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(error.label.contains("The selected terminal is unavailable."))
        XCTAssertFalse(error.label.contains("update moshi-hook"))
        XCTAssertEqual(composer.value as? String, "Keep it up")
        XCTAssertTrue(app.buttons["chat-send"].isEnabled)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertFalse(app.staticTexts["Received in codex on w7:p1: Keep it up"].exists)
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["chat-send"])
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 8), .completed)
        capture(app, "Rejected message keeps an editable draft")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Keep it up"].waitForExistence(timeout: 8))
        XCTAssertFalse(error.exists)
    }

    @MainActor
    func testOfflineReconnectLivesInHeaderMenuWithoutLosingDraft() {
        let app = launch(extra: ["--chat-offline"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep this while offline")
        XCTAssertFalse(app.buttons["chat-reconnect"].exists)
        app.buttons["Chat options"].tap()
        let reconnect = app.buttons["chat-reconnect"]
        XCTAssertTrue(reconnect.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat-send"].isEnabled)
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
        app.buttons["Add project context"].tap()
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

    @MainActor
    func testBlockedAgentRequiresTerminalAndCannotSend() {
        let app = launch(extra: ["--chat-blocked"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-answer-terminal"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep this for later")
        XCTAssertFalse(app.buttons["chat-send"].isEnabled)
    }

    @MainActor
    func testSessionHasOnlyNativeChatAndTerminalActions() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        app.buttons["Chat options"].tap()
        XCTAssertFalse(app.buttons["Open in Moshi"].exists)
    }

    @MainActor
    func testProjectMenuOpensNativeChat() {
        let app = launch()
        app.tabBars.buttons["Projects"].tap()
        app.buttons["project:sample/brain:phone"].tap()
        app.buttons["Project session"].tap()
        app.buttons["Chat with agent"].tap()
        let found = app.buttons["discovered-session:A1000000-0000-0000-0000-000000000001:w7:w7:t9"]
        XCTAssertTrue(found.waitForExistence(timeout: 10))
        found.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"] + extra
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Agents"].tap()
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        for _ in 0..<5 {
            if host.isHittable { break }
            app.swipeUp()
        }
        host.tap()
        XCTAssertTrue(app.buttons["live-chat:w7:w7:t9"].waitForExistence(timeout: 10))
        return app
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
