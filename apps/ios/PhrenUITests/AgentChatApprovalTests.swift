import XCTest

/// Approvals, questions and terminal prompts answered from the chat.
final class AgentChatApprovalTests: AgentChatUITestCase {
    /// Plan mode: EnterPlanMode is a one-line chip, ExitPlanMode a card with
    /// the plan, and the pending review a card whose Approve plan answers the
    /// permission request.
    @MainActor
    func testPlanReviewCardApprovesFromTheChat() {
        let app = launch(extra: ["--chat-plan-mode"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let approve = app.buttons["chat-plan-approve"]
        XCTAssertTrue(approve.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["chat-plan-keep"].exists)
        XCTAssertTrue(app.staticTexts["Plan ready for review"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Parse the Task tool in PhrenKit")).firstMatch.exists)
        XCTAssertFalse(app.buttons["Approve"].exists); XCTAssertFalse(app.staticTexts["Permission needed"].exists)
        XCTAssertEqual(rawJSONTexts(app).count, 0, "No raw JSON on a card")
        let chip = app.descendants(matching: .any).matching(identifier: "chat-plan-mode:plan-enter").firstMatch
        XCTAssertTrue(chip.exists); XCTAssertTrue(chip.label.contains("Entered plan mode"))
        let timeline = app.descendants(matching: .any).matching(identifier: "chat-plan-card:plan-exit").firstMatch
        XCTAssertTrue(timeline.exists); XCTAssertTrue(timeline.label.contains("Awaiting your answer"))
        // The timeline card is folded while the review card carries the plan.
        XCTAssertFalse(app.buttons["chat-plan-full:plan-exit"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Parse the Task tool in PhrenKit")).count, 1)
        capture(app, "Plan review card")
        // The plan is cut to a screenful; the reader has the rest.
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final step marker")).firstMatch.exists)
        app.buttons["chat-plan-full:fixture-plan-action"].tap()
        XCTAssertTrue(app.buttons["chat-tool-output-wrap"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final step marker")).firstMatch.exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(approve.waitForExistence(timeout: 5))
        approve.tap()
        XCTAssertTrue(app.staticTexts["Answer received in this conversation."].waitForExistence(timeout: 8))
        XCTAssertFalse(approve.exists)
        XCTAssertFalse(app.staticTexts["Permission denied in this conversation."].exists, "Approve plan approves")
        let approved = app.descendants(matching: .any).matching(identifier: "chat-plan-card:plan-exit").firstMatch
        XCTAssertTrue(approved.waitForExistence(timeout: 5)); XCTAssertTrue(approved.label.contains("Approved"))
        // Answered, the timeline card shows the plan itself.
        XCTAssertTrue(app.buttons["chat-plan-full:plan-exit"].waitForExistence(timeout: 5))
        capture(app, "Plan approved")
    }

    @MainActor
    func testInlineApprovalAndQuestionAnswers() {
        var app = launch(extra: ["--chat-approval"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["Approve"].waitForExistence(timeout: 8))
        let approve = app.buttons["chat-approval-approve"]
        let project = app.buttons["chat-approval-allow-project"]
        let everywhere = app.buttons["chat-approval-allow-everywhere"]
        let deny = app.buttons["chat-approval-deny"]
        XCTAssertTrue(app.staticTexts["Codex asks"].exists)
        XCTAssertLessThan(approve.frame.minY, project.frame.minY)
        XCTAssertLessThan(project.frame.minY, everywhere.frame.minY)
        XCTAssertLessThan(everywhere.frame.minY, deny.frame.minY)
        XCTAssertFalse(app.staticTexts["Permission needed"].exists)
        capture(app, "Chat approval uses ordered choice rows")
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
    func testAsyncCodexQuestionIsUpfrontAfterAcknowledgementAndAnswersInChat() {
        let app = launch(extra: ["--chat-async-question"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["Send answer"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Which Codex screens are missing approvals?"].exists)
        XCTAssertFalse(app.staticTexts["Waiting for your reply — type below"].exists)
        app.buttons["Phren and lock screen"].tap()
        app.buttons["Send answer"].tap()
        XCTAssertTrue(app.staticTexts["Answer received in this conversation."].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Send answer"].exists)
    }

    @MainActor
    func testUnsupportedQuestionStillShowsActualQuestionAboveComposer() {
        let app = launch(extra: ["--chat-question-unsupported"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Question needs your answer"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Which Codex screens are missing approvals?"].exists)
        XCTAssertTrue(app.buttons["chat-question-terminal"].exists)
        XCTAssertFalse(app.staticTexts["Waiting for your reply — type below"].exists)
        XCTAssertFalse(app.buttons["Send answer"].exists)
    }

    /// Claude Code's AskUserQuestion arrives as a permission request. The phone
    /// shows the questions as phren's own choices — no raw tool JSON, no blind
    /// Approve — and sends the answers back inside the approval.
    @MainActor
    func testClaudeQuestionApprovalShowsChoicesAndSendsAnswers() {
        let app = launch(extra: ["--chat-approval-question"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Design: Which accent should the project use?"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Claude has a question"].exists)
        XCTAssertTrue(app.staticTexts["Scope: Which screens should change?"].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Keep the Phren accent")).firstMatch.exists)
        XCTAssertFalse(app.buttons["Approve"].exists)
        XCTAssertFalse(app.staticTexts["Permission needed"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "\"questions\"")).count, 0)
        XCTAssertTrue(app.buttons["chat-question-skip"].exists)
        capture(app, "Claude question card")
        let send = app.buttons["Send answer"]
        XCTAssertFalse(send.isEnabled)
        // A typed "Other" answers the single choice; the multi-select takes two.
        let other = app.descendants(matching: .any).matching(identifier: "chat-question-typed-0").firstMatch
        other.tap(); other.typeText("Warm amber")
        XCTAssertFalse(send.isEnabled)
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "The conversation")).firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "The overview")).firstMatch.tap()
        capture(app, "Claude question in Phren")
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Which accent should the project use? → Warm amber")).firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Which screens should change? → Chat, Agents")).firstMatch.exists)
        XCTAssertFalse(send.exists)
    }

    /// A real AskUserQuestion is paragraphs long: nothing may be truncated,
    /// the window above the composer says there is more, and Expand shows
    /// every question, description and preview on one scrolling sheet that
    /// keeps the draft answers.
    @MainActor
    func testLongClaudeQuestionExpandsToSheetWithoutLosingAnswers() {
        let app = launch(extra: ["--chat-approval-question", "--chat-approval-question-long"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let first = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Identity: The Hook currently resolves")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 8))
        XCTAssertTrue(first.label.hasSuffix("Herdr is not running at all?"), "The question must be shown in full, not truncated")
        XCTAssertTrue(app.staticTexts["0 of 4 answered"].exists)
        XCTAssertTrue(app.buttons["chat-question-show-all"].waitForExistence(timeout: 4), "Four questions overflow the window and must offer the rest")
        XCTAssertTrue(app.buttons["chat-question-expand"].exists)
        capture(app, "Long Claude question card")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Descriptors only")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["1 of 4 answered"].exists)
        app.buttons["chat-question-expand"].tap()
        XCTAssertTrue(app.buttons["chat-question-collapse"].waitForExistence(timeout: 4))
        let preview = app.buttons.matching(NSPredicate(format: "value CONTAINS %@", "Open a terminal instead")).firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 4), "Option previews are shown on the sheet")
        capture(app, "Long Claude question sheet")
        // The sheet carries the inline draft and keeps taking answers.
        let send = app.buttons["Send answer"].firstMatch
        XCTAssertFalse(send.isEnabled)
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Second button")).firstMatch.tap()
        app.swipeUp()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Terminal header")).firstMatch.tap()
        let notes = app.descendants(matching: .any).matching(identifier: "chat-question-typed-3").firstMatch
        XCTAssertTrue(notes.waitForExistence(timeout: 4))
        notes.tap(); notes.typeText("Keep the SSH key restricted")
        capture(app, "Long Claude question sheet answered")
        app.buttons["chat-question-collapse"].tap()
        XCTAssertTrue(app.staticTexts["4 of 4 answered"].waitForExistence(timeout: 4), "Answers given on the sheet count on the card")
        XCTAssertTrue(app.buttons["Send answer"].firstMatch.isEnabled)
        app.buttons["Send answer"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "→ Descriptors only (Recommended)")).firstMatch.waitForExistence(timeout: 8))
    }

    /// Wrapping descriptions grow their rows: each row's background holds
    /// its radio, title and description, and rows never overlap.
    @MainActor
    func testQuestionOptionRowsHoldTheirWrappedText() {
        let app = launch(extra: ["--chat-approval-question", "--chat-approval-question-single"] + contentSizeArguments)
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Identity: Which fallback should the phone prefer when Herdr is not running?"].waitForExistence(timeout: 8))
        var previous: CGRect?
        for option in 0..<3 {
            let id = "chat-question-option:0:\(option)"
            let row = app.descendants(matching: .any).matching(identifier: "\(id):row").firstMatch
            let title = app.descendants(matching: .any).matching(identifier: "\(id):title").firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 4) && title.exists, "Option \(option) has its frame markers")
            XCTAssertTrue(row.frame.insetBy(dx: -0.5, dy: -0.5).contains(title.frame), "Option \(option) title \(title.frame) lies inside its row \(row.frame)")
            XCTAssertGreaterThanOrEqual(app.buttons[id].frame.height, title.frame.height + 20, "Option \(option) is padded around its text")
            if let previous { XCTAssertLessThanOrEqual(previous.maxY, row.frame.minY + 0.5, "Option \(option) does not overlap the one above") }
            previous = row.frame
        }
        capture(app, "Claude question with wrapping options")
        app.buttons["chat-question-option:0:1"].tap()
        XCTAssertTrue(app.buttons["chat-question-option:0:1"].isSelected)
        XCTAssertTrue(app.buttons["Send answer"].isEnabled)
    }

    /// A multi-question prompt with a wide preview: the preview scrolls in its
    /// own box inside the card, and Show all is its own row below the cut.
    @MainActor
    func testMultiQuestionPreviewAndShowAllStayClearOfOptions() {
        let app = launch(extra: ["--chat-blocked", "--chat-terminal-questions"] + contentSizeArguments)
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Page header: What should the top of every integration page be?"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Claude asks"].exists)
        let window = app.windows.firstMatch.frame
        let row = app.descendants(matching: .any).matching(identifier: "chat-question-option:0:0:row").firstMatch
        let preview = app.scrollViews["chat-question-option:0:0:preview"]
        XCTAssertTrue(row.exists && preview.exists, "The first option carries its preview")
        XCTAssertLessThanOrEqual(preview.frame.maxX, row.frame.maxX + 0.5, "The preview \(preview.frame) stays inside its row \(row.frame)")
        XCTAssertLessThanOrEqual(row.frame.maxX, window.maxX - 12, "The card keeps its margin")
        let showAll = app.buttons["chat-question-show-all"]
        XCTAssertTrue(showAll.waitForExistence(timeout: 4), "Ten options overflow the card")
        let scroll = app.scrollViews["chat-question-scroll"]
        XCTAssertLessThanOrEqual(scroll.frame.maxY, showAll.frame.minY + 0.5, "Show all sits below the cut")
        let titles = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "chat-question-option:", ":title"))
        var checked = 0
        for index in 0..<titles.count {
            let title = titles.element(boundBy: index).frame
            guard title.minY < scroll.frame.maxY else { continue }
            checked += 1
            XCTAssertFalse(title.intersects(showAll.frame), "Show all \(showAll.frame) covers an option title \(title)")
        }
        XCTAssertGreaterThan(checked, 0, "Some option titles are visible above Show all")
        capture(app, "Claude asks with a wide preview")
        preview.swipeLeft()
        XCTAssertLessThanOrEqual(row.frame.maxX, window.maxX - 12, "Scrolling the preview does not widen the card")
        showAll.tap()
        XCTAssertTrue(app.buttons["chat-question-collapse"].waitForExistence(timeout: 4))
    }

    /// `PHREN_UI_TEST_CONTENT_SIZE` (passed as TEST_RUNNER_PHREN_UI_TEST_CONTENT_SIZE)
    /// renders a one-off run at another text size; ordinary runs use the default.
    private var contentSizeArguments: [String] {
        guard let size = ProcessInfo.processInfo.environment["PHREN_UI_TEST_CONTENT_SIZE"], !size.isEmpty else { return [] }
        return ["-UIPreferredContentSizeCategoryName", size]
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
    func testLiveActivityCanDenyTheExactRequest() throws {
        guard ProcessInfo.processInfo.environment["PHREN_UI_TEST_LIVE_ACTIVITY"] == "1" else {
            throw XCTSkip("Set PHREN_UI_TEST_LIVE_ACTIVITY=1 on a simulator runner with Live Activities enabled; expanded Dynamic Island presentation is controlled by SpringBoard and is not deterministic in shared simulator runs.")
        }
        let app = launch(extra: ["--chat-approval", "--approval-live-activity"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-approval-deny"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.025)).press(forDuration: 1.5)
        XCTAssertTrue(springboard.buttons["Deny"].waitForExistence(timeout: 10))
        capture(springboard, "Permission Live Activity")
        springboard.buttons["Deny"].tap()
        let notice = app.descendants(matching: .any)["approval-result-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Denial sent."].exists)
        app.buttons["approval-result-notice-dismiss"].tap()
    }

    @MainActor
    func testTerminalChoiceDescriptionsWrapBelowLabelsAndQuestionAloneExpands() {
        let app = launch(extra: ["--chat-blocked", "--chat-terminal-choices", "--chat-terminal-long-question"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let label = app.staticTexts["Yes, proceed"]
        let description = app.staticTexts["Run the tool and continue."]
        XCTAssertTrue(label.waitForExistence(timeout: 8))
        XCTAssertTrue(description.exists, "The description is its own text element")
        XCTAssertGreaterThanOrEqual(description.frame.minY, label.frame.maxY)
        let showAll = app.buttons["chat-question-show-all"]
        XCTAssertTrue(showAll.exists)
        XCTAssertLessThanOrEqual(showAll.frame.maxY, label.frame.minY, "Expansion stays above the options")
        let last = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Tell Codex what to do differently.")).firstMatch
        capture(app, "Terminal choice with a long question")
        XCTAssertTrue(last.isHittable, "The last option is outside the question fade")
        showAll.tap()
        XCTAssertTrue(app.buttons["chat-question-collapse"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Review the requested action")).firstMatch.label.hasSuffix("xcrun simctl list runtimes"))
        capture(app, "Question expands with separate option descriptions")
    }

    @MainActor
    func testMCPApprovalShowsSentenceAndFoldedArgumentsWithRealChoices() {
        let app = launch(extra: ["--chat-mcp-approval"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Allow the phren MCP server to run tool phren_admin?"].waitForExistence(timeout: 8))
        XCTAssertEqual(rawJSONTexts(app).count, 0)
        let allow = app.buttons["chat-approval-approve"]
        let allowSession = app.buttons["chat-approval-option-1"]
        let deny = app.buttons["chat-approval-option-2"]
        XCTAssertTrue(allow.label.contains("Allow"))
        XCTAssertTrue(allowSession.label.contains("Allow for this session"))
        XCTAssertTrue(deny.label.contains("Deny"))
        XCTAssertLessThan(allow.frame.minY, allowSession.frame.minY)
        XCTAssertLessThan(allowSession.frame.minY, deny.frame.minY)
        XCTAssertFalse(app.buttons["Yes"].exists)
        XCTAssertFalse(app.buttons["No"].exists)
        app.buttons["Action details"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "read_skill")).firstMatch.exists)
        allowSession.tap()
        XCTAssertTrue(app.staticTexts["Answer key received: 2"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Answer received in this conversation."].waitForExistence(timeout: 8))
        XCTAssertFalse(allowSession.exists)
    }

    @MainActor
    func testUnresolvedApprovalOffersTerminalWithoutInventedAnswers() {
        let app = launch(extra: ["--chat-unresolved-approval"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-approval-terminal"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat-approval-approve"].exists)
        XCTAssertFalse(app.buttons["chat-approval-deny"].exists)
    }

    @MainActor
    func testTerminalOnlyPromptIsAnsweredWithKeysFromTheChat() {
        let app = launch(extra: ["--chat-blocked", "--chat-terminal-choices"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        // A Codex dialog whose command and options the Hook read is asked as
        // the question card, not the bare waiting line and its key strip.
        let card = app.descendants(matching: .any).matching(identifier: "chat-question").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10), "The terminal dialog's question is shown as a card")
        XCTAssertTrue(app.staticTexts["Codex asks"].exists)
        XCTAssertFalse(app.otherElements["chat-answer-keys"].exists, "The raw key strip is gone while the card is up")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "xcrun simctl list runtimes")).firstMatch.exists)
        let proceed = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Yes, proceed")).firstMatch
        XCTAssertTrue(proceed.exists)
        XCTAssertGreaterThanOrEqual(proceed.frame.height, 44, "The card's option rows stay comfortable to tap")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "don't ask again")).firstMatch.exists)
        XCTAssertTrue(app.buttons["chat-answer-terminal"].exists, "The terminal stays one tap away")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Agent is waiting")).firstMatch.exists)
        capture(app, "Terminal question card")
        proceed.tap()
        let send = app.buttons["Send answer"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        XCTAssertTrue(card.waitForNonExistence(timeout: 10), "Once the agent stops waiting the card goes")
        XCTAssertFalse(app.staticTexts["chat-delivery-error"].exists)
    }

    @MainActor
    func testPasswordPromptIsAnsweredFromTheChat() {
        let app = launch(extra: ["--chat-password"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let prompt = app.descendants(matching: .any)["chat-password-prompt"].firstMatch
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["The terminal is asking for a password"].exists)
        let secret = app.buttons["chat-answer-secret"]
        XCTAssertEqual(secret.label, "Enter password")
        secret.tap()
        let field = app.secureTextFields["chat-secret-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "The lock opens a password field")
        field.tap(); field.typeText("hunter2")
        app.buttons["chat-secret-send"].tap()
        XCTAssertTrue(prompt.waitForNonExistence(timeout: 10), "Once the agent stops waiting the password row goes")
        XCTAssertFalse(secret.exists)
        XCTAssertFalse(app.staticTexts["chat-delivery-error"].exists)
    }

    @MainActor
    func testBlockedAgentCanBeAnsweredInChatOrTerminal() {
        let app = launch(extra: ["--chat-blocked"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-answer-terminal"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-answer-secret"].exists, "Ordinary blocked prompts do not request a password")
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep this for later")
        let pending = app.buttons["chat-queue"]
        XCTAssertTrue(pending.waitForExistence(timeout: 5))
        XCTAssertTrue(pending.isEnabled)
        pending.tap()
        XCTAssertEqual(composer.value as? String, "")
        XCTAssertTrue(app.staticTexts["Holding a prompt"].waitForExistence(timeout: 5))
        let received = app.staticTexts["Received in codex on w7:p1: Keep this for later"]
        XCTAssertFalse(received.exists, "Text must wait until the terminal prompt is answered")
        let sendPending = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-send:")).firstMatch
        XCTAssertTrue(sendPending.exists)
        XCTAssertFalse(sendPending.isEnabled)
        XCTAssertTrue(app.buttons["chat-answer-terminal"].isHittable)
        app.buttons["chat-answer-key:y"].tap()
        XCTAssertTrue(app.staticTexts["Answer received in this conversation."].waitForExistence(timeout: 8))
        XCTAssertTrue(received.waitForExistence(timeout: 8))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "Received in codex on w7:p1: Keep this for later")).count, 1)
        XCTAssertFalse(app.staticTexts["Holding a prompt"].exists)
        XCTAssertFalse(sendPending.exists)
    }
}
