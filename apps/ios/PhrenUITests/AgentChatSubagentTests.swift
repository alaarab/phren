import XCTest

/// Sub-agents and workers: their cards, transcripts, composer and the running-agents badge.
final class AgentChatSubagentTests: AgentChatUITestCase {
    @MainActor
    func testSubagentCardShowsReportStateAndPrompt() {
        let app = launch(extra: ["--chat-agent-card"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let audit = app.descendants(matching: .any).matching(identifier: "chat-agent-card:agent-audit").firstMatch
        XCTAssertTrue(audit.waitForExistence(timeout: 8))
        XCTAssertTrue(audit.label.contains("Explore")); XCTAssertTrue(audit.label.contains("Audit the chat timeline")); XCTAssertTrue(audit.label.contains("done"))
        XCTAssertTrue(app.staticTexts["haiku"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Reads, greps and lists fold")).firstMatch.exists)
        let tests = app.descendants(matching: .any).matching(identifier: "chat-agent-card:agent-tests").firstMatch
        XCTAssertTrue(tests.exists); XCTAssertTrue(tests.label.contains("tester")); XCTAssertTrue(tests.label.contains("running"))
        XCTAssertTrue(app.staticTexts["background"].exists)
        let describedJob = app.buttons["chat-background-job:background-tests"]
        XCTAssertTrue(describedJob.waitForExistence(timeout: 5))
        XCTAssertTrue(describedJob.label.contains("Run the full test suite"), describedJob.label)
        XCTAssertFalse(describedJob.label.contains("cd "), "The command stays in the expanded details, not the title")
        let workerJob = app.buttons["chat-background-job:background-worker"]
        XCTAssertTrue(workerJob.waitForExistence(timeout: 5))
        XCTAssertTrue(workerJob.label.contains("Worker: Per-computer color for session cards"), workerJob.label)
        capture(app, "Background jobs by description")
        XCTAssertEqual(rawJSONTexts(app).count, 0, "No raw JSON on a card")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "subagent_type")).firstMatch.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:")).firstMatch.exists)
        capture(app, "Subagent cards")
        // The report is cut to a screenful; the reader has the rest.
        let full = app.buttons["chat-agent-report:agent-audit"]
        XCTAssertTrue(full.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final audit marker")).firstMatch.exists)
        full.tap()
        XCTAssertTrue(app.buttons["chat-tool-output-wrap"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final audit marker")).firstMatch.exists)
        app.navigationBars.buttons.firstMatch.tap()
        // The prompt stays behind a tap.
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Read ChatTimelineModels.swift")).firstMatch.exists)
        app.buttons["chat-agent-prompt:agent-audit"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Read ChatTimelineModels.swift")).firstMatch.waitForExistence(timeout: 3))
    }

    /// A long child transcript loads its earlier page on scrolling up, with no button to tap.
    @MainActor
    func testChildTranscriptLoadsEarlierActivityOnScrollingUp() {
        let app = launch(extra: ["--chat-agent-card", "--child-history"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let open = app.buttons["chat-agent-transcript:agent-audit"]
        XCTAssertTrue(open.waitForExistence(timeout: 8)); open.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Child later step 29")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["child-agent-older"].exists, "No Show earlier activity button")
        let earlier = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Child earlier marker")).firstMatch
        XCTAssertFalse(earlier.exists, "The earlier page waits until the reader scrolls up")
        for _ in 0..<10 where !(earlier.exists && earlier.isHittable) { app.swipeDown(velocity: .fast) }
        XCTAssertTrue(earlier.waitForExistence(timeout: 5))
        capture(app, "Child transcript after scrolling up")
    }

    @MainActor
    func testSubagentCardOpensItsOwnTranscriptAndTheComposerBadgeCountsRunningAgents() {
        let app = launch(extra: ["--chat-agent-card"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 8))
        let tree = app.buttons["chat-agent-tree"]
        XCTAssertTrue(tree.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["1 agent running"].exists, "The old agent label no longer takes a composer row")
        XCTAssertEqual(tree.label, "1 running agent", "The composer badge counts only running agents")
        capture(app, "Agent tree in the composer")
        tree.tap()
        XCTAssertTrue(app.buttons["chat-subagents-back"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Agent work"].exists)
        let completedID = "a" + String(repeating: "1", count: 31)
        XCTAssertFalse(app.buttons["child-agent:\(completedID)"].exists, "Finished agents are out of scope in Agent work")
        XCTAssertFalse(app.buttons["chat-subagents-show-completed"].exists, "Nothing brings finished agents back")
        XCTAssertTrue(app.staticTexts["1 running"].waitForExistence(timeout: 5))
        let runningAgent = app.buttons["child-agent:b" + String(repeating: "2", count: 31)]
        XCTAssertTrue(runningAgent.waitForExistence(timeout: 5))
        XCTAssertTrue(runningAgent.label.contains("Claude"), "The provider or model appears above the task name")
        XCTAssertFalse(app.staticTexts["Running"].exists, "The avatar's dot already says the agent is running")
        capture(app, "Agent work cards")
        app.buttons["chat-subagents-back"].tap()
        app.buttons["chat-switch-agent"].tap()
        let fixtureChildID = "b2222222222222222222222222222222"
        let drawerChild = app.buttons["drawer-child-agent:\(fixtureChildID)"]
        XCTAssertTrue(drawerChild.waitForExistence(timeout: 5))
        drawerChild.tap()
        let drawerTranscriptHeader = app.descendants(matching: .any).matching(identifier: "child-agent-header").firstMatch
        XCTAssertTrue(drawerTranscriptHeader.waitForExistence(timeout: 5))
        capture(app, "Subagents nested in the drawer")
        app.buttons["child-agent-back"].tap()
        let open = app.buttons["chat-agent-transcript:agent-audit"]
        XCTAssertTrue(open.waitForExistence(timeout: 8))
        XCTAssertEqual(open.label, "Open conversation")
        XCTAssertEqual(app.buttons["chat-agent-transcript:agent-tests"].label, "Open conversation")
        open.tap()
        // The child's rows are all sidechain rows; they read as its conversation.
        let header = app.descendants(matching: .any).matching(identifier: "child-agent-header").firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertTrue(header.label.contains("Claude")); XCTAssertTrue(header.label.contains("gpt-5-codex")); XCTAssertTrue(header.label.contains("Completed"))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Child audit marker")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["This agent recorded no conversation."].exists)
        XCTAssertEqual(rawJSONTexts(app).count, 0, "No raw JSON in a child transcript")
        app.buttons["chat-subagent-diff"].tap()
        // The child's changes are the Changes screen scoped to its checkout:
        // its branch up top, its diff in Diff mode.
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "changes-header").firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["changes-title"].label, "deepseek/compact-phone")
        app.buttons["changes-mode-diff"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Subagent changes")
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    @MainActor
    func testRemoteAgentWorkKeepsComputerIdentityAndBackgroundReturnVisible() {
        let app = launch(extra: ["--chat-agent-card", "--all-sessions-fixture", "--all-sessions-offline",
                                 "--agent-work-navigation", "--agent-work-unknown", "--chat-question"],
                         chat: "live-chat:w1:w1:t1")
        app.buttons["live-chat:w1:w1:t1"].tap()
        XCTAssertTrue(app.buttons["chat-background-job:background-tests"].waitForExistence(timeout: 8),
                      "Background work remains a Background row in the conductor chat")

        app.buttons["chat-switch-agent"].tap()
        let drawerLead = app.buttons["drawer-child-agent:c1000000-0000-0000-0000-000000000002/remote-parser-lead/lead"]
        XCTAssertTrue(drawerLead.waitForExistence(timeout: 8))
        XCTAssertTrue(drawerLead.label.contains("Linuxbox"), drawerLead.label)
        drawerLead.tap()
        let remoteLocation = app.staticTexts["chat-location"]
        XCTAssertTrue(remoteLocation.waitForExistence(timeout: 8))
        XCTAssertTrue(remoteLocation.label.contains("Test Linux"), remoteLocation.label)
        XCTAssertTrue(app.buttons["Send answer"].waitForExistence(timeout: 8),
                      "A remote lead reuses the ordinary chat answer UI")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Keep the Phren accent")).firstMatch.tap()
        app.buttons["Send answer"].tap()
        XCTAssertTrue(app.staticTexts["Answer received in this conversation."].waitForExistence(timeout: 8))
        app.buttons["chat-close"].tap()

        app.buttons["chat-agent-tree"].tap()
        XCTAssertTrue(app.buttons["chat-subagents-back"].waitForExistence(timeout: 5))
        let remoteLead = app.buttons["child-agent:c1000000-0000-0000-0000-000000000002/remote-parser-lead/lead"]
        XCTAssertTrue(remoteLead.waitForExistence(timeout: 5))
        XCTAssertTrue(remoteLead.label.contains("Linuxbox"), remoteLead.label)
        let unavailable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "unavailable"),
                                                     object: remoteLead)
        XCTAssertEqual(XCTWaiter.wait(for: [unavailable], timeout: 15), .completed,
                       "The row stays visible when its enrolled computer goes offline")
        let unknown = app.buttons["child-agent:c1000000-0000-0000-0000-000000000099/remote-unknown-lead/lead"]
        XCTAssertTrue(unknown.waitForExistence(timeout: 5))
        XCTAssertTrue(unknown.label.contains("Bench")); XCTAssertTrue(unknown.label.contains("add computer"))
        let nested = app.buttons["child-agent:c1000000-0000-0000-0000-000000000002/remote-parser-fixtures/cccccccccccccccccccccccccccccccc"]
        unknown.tap()
        let addComputer = app.buttons["agent-computer-add"]
        XCTAssertTrue(addComputer.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(addComputer.frame.height, 44)
        app.buttons["agent-work-back"].tap()
        XCTAssertTrue(remoteLead.waitForExistence(timeout: 5))

        XCTAssertTrue(nested.waitForExistence(timeout: 5))
        nested.tap()
        let header = app.descendants(matching: .any).matching(identifier: "child-agent-header").firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertTrue(header.label.contains("Linuxbox"), "VoiceOver names the remote computer")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Remote parser fixture marker")).firstMatch.waitForExistence(timeout: 5))
        app.buttons["chat-subagent-diff"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "changes-header").firstMatch.waitForExistence(timeout: 5))
    }

    @MainActor
    func testAgentWorkHidesOldFailureAndDismissesRecentFailureAcrossReopening() {
        let app = launch(extra: ["--chat-agent-card", "--agent-work-failures"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let tree = app.buttons["chat-agent-tree"]
        XCTAssertTrue(tree.waitForExistence(timeout: 8)); tree.tap()
        let recent = app.buttons["child-agent:recent-refusal"]
        let running = app.buttons["child-agent:b" + String(repeating: "2", count: 31)]
        XCTAssertTrue(recent.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["child-agent:old-refusal"].exists)
        XCTAssertTrue(recent.label.contains("2m ago"))
        XCTAssertLessThan(running.frame.minY, recent.frame.minY)
        XCTAssertTrue(app.staticTexts["1 running · 1 refused"].exists)
        app.buttons["dismiss-child-agent:recent-refusal"].tap()
        XCTAssertFalse(recent.exists)
        XCTAssertTrue(app.staticTexts["1 running"].exists)
        app.buttons["chat-subagents-back"].tap(); tree.tap()
        XCTAssertTrue(app.buttons["chat-subagents-back"].waitForExistence(timeout: 5))
        XCTAssertFalse(recent.exists, "A refreshed worker tree does not undo dismissal")
    }

    @MainActor
    func testInProcessChildComposerLabelsAndSendsToParent() {
        let app = launch(extra: ["--chat-agent-card"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-agent-tree"].waitForExistence(timeout: 8))
        app.buttons["chat-agent-tree"].tap()
        let child = app.buttons["child-agent:b" + String(repeating: "2", count: 31)]
        XCTAssertTrue(child.waitForExistence(timeout: 5)); child.tap()
        let note = app.staticTexts["child-composer-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        XCTAssertTrue(note.label.contains("goes to its parent"))
        let field = app.descendants(matching: .any).matching(identifier: "child-composer-field").firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("Check the parser too")
        app.buttons["child-composer-send"].tap()
        let expected = "About the Run the full test suite sub-agent: Check the parser too"
        let receipt = app.staticTexts["child-message-delivery"]
        XCTAssertTrue(receipt.waitForExistence(timeout: 5))
        XCTAssertTrue(receipt.label.contains(expected))
        app.buttons["child-agent-back"].tap(); app.buttons["chat-subagents-back"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", expected)).firstMatch.waitForExistence(timeout: 8))
        capture(app, "Child message delivered to parent")
    }

    @MainActor
    func testFinishedWorkerComposerContinuesItsOwnSession() {
        assertWorkerComposer(running: false)
    }

    @MainActor
    func testRunningWorkerComposerShowsQueuedMessage() {
        assertWorkerComposer(running: true)
    }

    @MainActor
    private func assertWorkerComposer(running: Bool) {
        let app = launch(extra: ["--chat-agent-card", "--chat-child-workers"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-agent-tree"].waitForExistence(timeout: 8)); app.buttons["chat-agent-tree"].tap()
        let id = running ? "b" + String(repeating: "2", count: 31) : "a" + String(repeating: "1", count: 31)
        // A finished worker sits inside the folded finished row.
        if !running {
            let finished = app.buttons["child-agents-finished"]
            XCTAssertTrue(finished.waitForExistence(timeout: 5)); finished.tap()
        }
        let child = app.buttons["child-agent:" + id]
        XCTAssertTrue(child.waitForExistence(timeout: 5)); child.tap()
        let note = app.staticTexts["child-composer-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 5)); XCTAssertTrue(note.label.contains("worker's own session"))
        let field = app.descendants(matching: .any).matching(identifier: "child-composer-field").firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("Review the follow-up")
        app.buttons["child-composer-send"].tap()
        let delivery = app.staticTexts["child-message-delivery"]
        XCTAssertTrue(delivery.waitForExistence(timeout: 5))
        XCTAssertEqual(delivery.label, running ? "Queued for this worker" : "Continuing this worker")
        let route = app.staticTexts["child-fixture-delivery"].label
        XCTAssertTrue(route.hasPrefix("worker|")); XCTAssertTrue(route.hasSuffix("|" + id + "|Review the follow-up"))
        if running { XCTAssertTrue(app.staticTexts["Queued until this worker finishes"].exists) }
        capture(app, running ? "Child worker queued" : "Child worker continued")
    }

    @MainActor
    func testFinishedWorkersFoldIntoOneRowAndClear() {
        let app = launch(extra: ["--chat-agent-card", "--chat-child-workers"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-agent-tree"].waitForExistence(timeout: 8)); app.buttons["chat-agent-tree"].tap()
        let finishedID = "child-agent:a" + String(repeating: "1", count: 31)
        let runningID = "child-agent:b" + String(repeating: "2", count: 31)
        XCTAssertTrue(app.buttons[runningID].waitForExistence(timeout: 5))
        let finished = app.buttons["child-agents-finished"]
        XCTAssertTrue(finished.waitForExistence(timeout: 5))
        XCTAssertEqual(finished.label, "1 finished worker")
        XCTAssertFalse(app.buttons[finishedID].exists, "a finished worker starts folded")
        finished.tap()
        XCTAssertTrue(app.buttons[finishedID].waitForExistence(timeout: 5))
        capture(app, "Finished workers expanded")
        finished.tap()
        XCTAssertTrue(app.buttons[finishedID].waitForNonExistence(timeout: 5))
        app.buttons["child-agents-clear-finished"].tap()
        XCTAssertTrue(finished.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons[runningID].exists, "clearing leaves running workers")
        let route = app.staticTexts["child-agents-fixture-delivery"]
        XCTAssertTrue(route.waitForExistence(timeout: 5))
        XCTAssertTrue(route.label.hasPrefix("archive|"))
        capture(app, "Finished workers cleared")
    }

    @MainActor
    func testPaneChildOpensFullChatAndSendsToThatSession() {
        let app = launch(extra: ["--chat-agent-card", "--all-sessions-fixture", "--agent-work-navigation"], chat: "live-chat:w1:w1:t1")
        app.buttons["live-chat:w1:w1:t1"].tap()
        XCTAssertTrue(app.buttons["chat-agent-tree"].waitForExistence(timeout: 8)); app.buttons["chat-agent-tree"].tap()
        let lead = app.buttons["child-agent:c1000000-0000-0000-0000-000000000002/remote-parser-lead/lead"]
        XCTAssertTrue(lead.waitForExistence(timeout: 5)); lead.tap()
        XCTAssertTrue(app.staticTexts["child-session-note"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["child-session-note"].label, "Messages go directly to this agent session.")
        let field = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 8)); field.tap(); field.typeText("Continue parser checks")
        // The parent chat stays in the tree under the agents sheet with its
        // own (empty, disabled) composer; the child session's Send is the
        // one the draft enabled.
        let send = app.buttons.matching(NSPredicate(format: "identifier == %@ AND enabled == true", "chat-send"))
        XCTAssertEqual(send.count, 1)
        send.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Continue parser checks"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["child-composer-note"].exists)
        capture(app, "Pane child full chat")
    }
}
