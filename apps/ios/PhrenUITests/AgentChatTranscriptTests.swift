import XCTest

/// The conversation itself: activity rows, history paging, opening at the end, following the latest reply, links.
final class AgentChatTranscriptTests: AgentChatUITestCase {
    @MainActor
    func testActivityCountsWhileThinkingAndCollapsesAboveTheReply() {
        let app = launch(extra: ["--chat-streaming", "--chat-activity-fixture", "--chat-clear-drafts"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Show turn activity")
        app.buttons["chat-send"].tap()
        // The header has its own compact activity indicator. This test owns
        // the timed row in the conversation, including its removal on finish.
        let live = transcript.descendants(matching: .any).matching(identifier: "chat-activity").firstMatch
        XCTAssertTrue(live.waitForExistence(timeout: 5))
        XCTAssertTrue(live.label.hasPrefix("Thinking "), live.label)
        let frame = live.frame
        let firstLabel = live.label
        let tick = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", firstLabel), object: live)
        XCTAssertEqual(XCTWaiter.wait(for: [tick], timeout: 3), .completed)
        XCTAssertEqual(live.frame.width, frame.width, accuracy: 1)
        XCTAssertEqual(live.frame.height, frame.height, accuracy: 1)
        capture(app, "Chat thinking activity")
        let done = transcript.descendants(matching: .any).matching(identifier: "chat-activity-done").firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 18))
        XCTAssertEqual(done.label, "Thought for 12s")
        XCTAssertFalse(live.exists)
        let reply = app.descendants(matching: .any).matching(identifier: "chat-message:4:0").firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(done.frame.maxY, reply.frame.minY)
        capture(app, "Chat completed activity")
        app.buttons["chat-close"].tap()
        XCTAssertTrue(app.buttons["live-chat:w7:w7:t9"].waitForExistence(timeout: 5))
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 8))
        XCTAssertEqual(done.label, "Thought for 12s")
    }

    @MainActor
    func testRemoteChatLinksRejectCustomSchemesAndConfirmWebHost() {
        let app = launch(extra: ["--chat-secure-links"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.links["Approve"].waitForExistence(timeout: 8))
        app.links["Approve"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["external-link-dialog"].firstMatch.exists)
        XCTAssertTrue(app.buttons["chat-close"].exists)
        app.links["Docs"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["external-link-dialog"].firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["example.com"].exists)
        capture(app, "Confirm a transcript website")
        app.buttons["external-link-dialog:cancel"].tap()
        XCTAssertTrue(app.links["Docs"].exists)
    }

    @MainActor
    func testHeavyTranscriptScrollingAndComposerFocus() {
        let app = launch(extra: ["--chat-heavy"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-message:59:0").firstMatch.waitForExistence(timeout: 15))
        // A plain scroll smoke test: the signpost scrolling metric waited on
        // deceleration events SwiftUI never emits and cost four minutes a run.
        let transcript = app.scrollViews["chat-transcript"]
        let started = Date()
        transcript.swipeDown(velocity: .fast)
        transcript.swipeUp(velocity: .fast)
        XCTAssertLessThan(Date().timeIntervalSince(started), 30, "a swipe each way over the heavy transcript stays quick")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-message:59:0").firstMatch.waitForExistence(timeout: 10))
        // The same launch also checks focusing the composer keeps the end on screen.
        let tail = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Heavy fixture reply 19.")).firstMatch
        XCTAssertTrue(tail.waitForExistence(timeout: 15))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap()
        Thread.sleep(forTimeInterval: 1.5)
        capture(app, "Composer focused on a long transcript")
        XCTAssertTrue(tail.isHittable, "Focusing the composer must keep the transcript's end above the keyboard, not scroll past it")
        XCTAssertFalse(app.buttons["Latest messages"].exists, "Follow should stay engaged when the keyboard appears")
        app.buttons["Return"].exists ? app.buttons["Return"].tap() : app.swipeDown()
        Thread.sleep(forTimeInterval: 1.0)
        capture(app, "Composer released on a long transcript")
        XCTAssertTrue(tail.isHittable, "Dismissing the keyboard must leave the transcript's end on screen")
    }

    @MainActor
    func testCompactionShowsAsOneSmallRow() {
        let app = launch(extra: ["--chat-compaction"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let row = app.descendants(matching: .any).matching(identifier: "chat-compaction").firstMatch
        for _ in 0..<6 where !row.isHittable { transcript.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(row.frame.height, 44, "A compaction is one small row, not a bubble")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "compaction filler")).firstMatch.exists,
                       "The summary stays behind the row, never inline in the transcript")
        capture(app, "Compaction as one small row")
    }

    @MainActor
    func testOpeningSpinnerIsCenteredInTheConversation() {
        let app = launch(extra: ["--chat-opening-slow"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let spinner = app.activityIndicators["chat-opening-spinner"]
        XCTAssertTrue(spinner.waitForExistence(timeout: 2))
        let conversation = app.scrollViews["chat-transcript"]
        XCTAssertTrue(conversation.exists)
        // Centered in the part of the conversation below the header.
        let visibleTop = app.staticTexts["chat-location"].frame.maxY
        XCTAssertEqual(spinner.frame.midY, (visibleTop + conversation.frame.maxY) / 2, accuracy: 30)
        XCTAssertEqual(spinner.frame.midX, conversation.frame.midX, accuracy: 12)
        capture(app, "Conversation loading centered above composer")
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 8))
        XCTAssertFalse(spinner.exists)
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
        XCTAssertTrue(app.descendants(matching: .any)["external-link-dialog"].firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["example.org"].exists)
        app.buttons["external-link-open"].tap()
        app.buttons["chat-close"].tap()
        let captured = app.staticTexts["chat-opened-url"]
        XCTAssertTrue(captured.waitForExistence(timeout: 5))
        XCTAssertEqual(captured.label, "https://example.org/phren-fixture")
    }

    @MainActor
    func testWaitingProgressTokenUsageAndFinishedReply() {
        let app = launch(extra: ["--chat-streaming"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Ready to stream a reply."].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Show me the reply")
        app.buttons["chat-send"].tap()
        // The header's indicator, not the transcript's activity row: the
        // transcript runs under the header, so match by the indicator's words.
        let activity = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label IN %@", "chat-activity",
            ["Waiting for agent…", "Receiving reply…", "Agent is working", "Finished", "Ready"])).firstMatch
        let header = app.descendants(matching: .any).matching(identifier: "chat-header").firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 3))
        XCTAssertEqual(activity.label, "Waiting for agent…")
        XCTAssertTrue(header.exists, "The chat header marker remains available")
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

    /// A slash command or `!` shell line typed at Claude Code's own prompt
    /// reads as one system line with its output, not a bubble of tags.
    @MainActor
    func testLocalCommandsReadAsSystemLines() {
        let app = launch(extra: ["--chat-commands"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let model = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "chat-command:", "Command: /model")).firstMatch
        XCTAssertTrue(model.waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Command output: Set model to Opus 5")).firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Command: pwd")).firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Command output: /home/sam/Projects/hub")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "<command-name>")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "<bash-stdout>")).firstMatch.exists)
        capture(app, "Slash and shell commands as inline system lines")
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
    func testLongTranscriptOpensAtTheLastMessage() {
        let app = launch(extra: ["--chat-heavy"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let tail = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Heavy fixture reply 19.")).firstMatch
        XCTAssertTrue(tail.waitForExistence(timeout: 15), "The end of a long transcript should be laid out on open")
        let visible = NSPredicate { _, _ in tail.isHittable }
        expectation(for: visible, evaluatedWith: tail)
        waitForExpectations(timeout: 5)
        XCTAssertFalse(app.buttons["Latest messages"].exists, "A long transcript should open already pinned to the bottom")
        capture(app, "Long transcript opens at the last message")
    }

    @MainActor
    func testStalledCodexHistoryOffersANewThreadWithoutWaitingState() {
        let app = launch(extra: ["--chat-history-stalled"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let notice = app.descendants(matching: .any).matching(identifier: "chat-history-stalled").firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Codex stopped recording this thread 2h ago. Start a new one to keep following it."].exists)
        XCTAssertTrue(app.buttons["New thread"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Agent is waiting")).firstMatch.exists)
    }

    @MainActor
    func testUnevenTranscriptOpensAtItsRealEnd() {
        let app = launch(extra: ["--chat-uneven"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let tail = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Uneven fixture reply 205.")).firstMatch
        XCTAssertTrue(tail.waitForExistence(timeout: 15), "The end of the transcript should be laid out on open")
        Thread.sleep(forTimeInterval: 1.5)
        capture(app, "Uneven transcript on open")
        XCTAssertTrue(tail.isHittable, "The last message must be on screen, not above a blank stretch the estimate left behind")
        XCTAssertFalse(app.buttons["Latest messages"].exists)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap()
        Thread.sleep(forTimeInterval: 1.5)
        capture(app, "Uneven transcript with the composer focused")
        XCTAssertTrue(tail.isHittable, "Focusing the composer must keep the last message above the keyboard")
    }

    @MainActor
    func testStreamingReplyStaysPinnedToTheBottom() {
        let app = launch(extra: ["--chat-streaming"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Stream a long reply")
        app.buttons["chat-send"].tap()
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "arriving word by word")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 15), "The streamed reply should arrive")
        Thread.sleep(forTimeInterval: 6)
        XCTAssertFalse(app.buttons["Latest messages"].exists, "Follow should stay engaged while the reply streams")
        capture(app, "Streaming reply stays pinned")
    }

    @MainActor
    func testUpwardDragReleasesFollowAndReturningReengages() {
        let app = launch(extra: ["--chat-heavy"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Latest messages"].exists)
        transcript.swipeDown(velocity: .fast)
        XCTAssertTrue(app.buttons["Latest messages"].waitForExistence(timeout: 5), "An upward drag should release follow")
        app.buttons["Latest messages"].tap()
        XCTAssertFalse(app.buttons["Latest messages"].waitForExistence(timeout: 2), "Returning to the bottom should re-engage follow")
    }

    /// The person's message is in the transcript the moment the live line
    /// is: a muted pending bubble above it, which the transcript row replaces.
    @MainActor
    func testSentMessageLandsBeforeTheLiveLine() {
        let app = launch(extra: ["--chat-streaming", "--chat-activity-fixture", "--chat-clear-drafts", "--chat-slow-echo"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Order check message")
        app.buttons["chat-send"].tap()
        let pending = transcript.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-pending-message:")).firstMatch
        let live = transcript.descendants(matching: .any).matching(identifier: "chat-activity").firstMatch
        XCTAssertTrue(live.waitForExistence(timeout: 5))
        XCTAssertTrue(pending.exists, "The sent message must be in the transcript by the time the live line is")
        XCTAssertTrue(pending.label.contains("Order check message"), pending.label)
        XCTAssertLessThanOrEqual(pending.frame.maxY, live.frame.minY + 1, "The message sits above the live line")
        XCTAssertFalse((app.textViews["chat-composer"].value as? String ?? "").contains("Order check message"),
                       "The bubble carries the message; the composer does not show it twice")
        capture(app, "Sent message pending above the live line")
        // The Hook's row replaces the pending bubble: one message, not two.
        let echoed = transcript.descendants(matching: .any).matching(identifier: "chat-message:1:0").firstMatch
        XCTAssertTrue(echoed.waitForExistence(timeout: 8))
        XCTAssertTrue(pending.waitForNonExistence(timeout: 3))
        XCTAssertLessThanOrEqual(echoed.frame.maxY, live.frame.minY + 1)
        capture(app, "Sent message replaced by its transcript row")
    }

    /// Sends a prompt into the spinner fixture and returns the live row.
    @MainActor private func startSpinnerTurn(_ app: XCUIApplication) -> XCUIElement {
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Show the spinner")
        app.buttons["chat-send"].tap()
        return transcript.descendants(matching: .any).matching(identifier: "chat-activity").firstMatch
    }

    @MainActor
    func testClaudeSpinnerLineShowsItsFieldsAndItsRingStopsTheTurn() {
        let app = launch(extra: ["--chat-streaming", "--chat-spinner-fixture", "--chat-clear-drafts"])
        let live = startSpinnerTurn(app)
        let spinner = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@ AND label CONTAINS %@",
                                                                       "Whirlpooling… (", "↓ 3.1k tokens", "thinking)"), object: live)
        XCTAssertEqual(XCTWaiter.wait(for: [spinner], timeout: 8), .completed, live.label)
        let ring = app.buttons["chat-activity-stop"]
        XCTAssertTrue(ring.waitForExistence(timeout: 3))
        XCTAssertGreaterThanOrEqual(ring.frame.width, 44); XCTAssertGreaterThanOrEqual(ring.frame.height, 44)
        XCTAssertLessThanOrEqual(abs(ring.frame.midY - live.frame.midY), 12, "The ring sits at the end of the activity line")
        XCTAssertGreaterThan(ring.frame.minX, live.frame.midX)
        XCTAssertTrue(app.buttons["chat-stop"].exists, "The composer keeps its own stop")
        // A line of its own text height: the ring's target lies over the
        // gaps around it instead of padding the row out to 44 points.
        let sent = app.descendants(matching: .any).matching(identifier: "chat-message:1:0").firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(live.frame.height, 30)
        XCTAssertLessThanOrEqual(live.frame.minY - sent.frame.maxY, 10, "No empty band between the last row and the live line")
        capture(app, "Activity line live with the stop ring")
        // Tapped near its top edge, outside the line's own height.
        ring.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        let done = app.descendants(matching: .any).matching(identifier: "chat-activity-done").firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 8))
        XCTAssertTrue(done.label.hasPrefix("Stopped after "), done.label)
        XCTAssertTrue(app.staticTexts["Stopped at your request."].waitForExistence(timeout: 5))
        XCTAssertFalse(live.exists)
        XCTAssertFalse(ring.exists)
    }

    @MainActor
    func testClaudeVerbFinishesTheTurnInThePastTense() {
        let app = launch(extra: ["--chat-streaming", "--chat-spinner-fixture", "--chat-clear-drafts"])
        let live = startSpinnerTurn(app)
        // The thinking ends and the count grows; the clock keeps its own time.
        let later = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@ AND NOT (label CONTAINS %@)",
                                                                     "Whirlpooling… (", "↓ 4.8k tokens", "thinking"), object: live)
        XCTAssertEqual(XCTWaiter.wait(for: [later], timeout: 12), .completed, live.label)
        let done = app.descendants(matching: .any).matching(identifier: "chat-activity-done").firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        XCTAssertEqual(done.label, "Whirlpooled for 14s")
        capture(app, "Activity line finished in the past tense")
    }
}
