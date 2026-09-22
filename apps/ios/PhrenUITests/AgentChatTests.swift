import XCTest

final class AgentChatTests: XCTestCase {
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
    func testWriteAndEditShowChangeRowsBeforeExpanding() {
        let app = launch(extra: ["--chat-write-changes"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        for path in ["Edited.swift", "Fallback.swift", "Created.swift"] {
            let row = app.buttons["chat-patch-file:" + path]
            for _ in 0..<6 where !row.isHittable { transcript.swipeDown() }
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            XCTAssertTrue(row.label.contains("collapsed"))
        }
        capture(app, "Write and Edit change rows")
    }

    @MainActor
    func testStartingSessionSendsFirstPromptAndAttachesItsTranscript() {
        let app = launch(extra: ["--starting-session-fixture"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["chat-starting"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["Choose an agent"].exists)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Create the first file")
        app.buttons["chat-send"].tap()
        // The prompt is accepted before the real session attaches: the draft
        // clears and the control shows busy, with no session to steer yet.
        let waitingComposer = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", ""), object: composer)
        XCTAssertEqual(XCTWaiter.wait(for: [waitingComposer], timeout: 3), .completed)
        XCTAssertTrue(app.staticTexts["chat-starting"].exists)
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Create the first file"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.staticTexts["chat-starting"].exists)
        capture(app, "New session transcript attached")
    }

    @MainActor
    func testPhrenToolsHaveTheirOwnCardsAndOpenFullDetails() {
        let app = launch(extra: ["--chat-phren-tools"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let card = app.buttons["chat-phren-card:phren-task"]
        for _ in 0..<12 where !card.isHittable { transcript.swipeDown() }
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertTrue(card.label.contains("Add task"))
        XCTAssertTrue(card.label.contains("Completed"))
        XCTAssertEqual(card.value as? String, "Folded")
        let foldedHeight = card.frame.height
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.15)).tap()
        XCTAssertEqual(card.value as? String, "Expanded")
        XCTAssertFalse(app.navigationBars["Task details"].exists)
        // Expanding unclamps the readable card; it never dumps raw input.
        XCTAssertGreaterThanOrEqual(card.frame.height, foldedHeight)
        XCTAssertFalse(app.staticTexts["Input"].exists)
        for _ in 0..<12 where card.frame.minY < transcript.frame.minY { transcript.swipeDown() }
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.05)).tap()
        XCTAssertEqual(card.value as? String, "Folded")
        let open = app.buttons["chat-phren-open:phren-task"]
        for _ in 0..<12 where !open.isHittable { transcript.swipeDown() }
        XCTAssertTrue(open.isHittable)
        open.tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final task check")).firstMatch.exists)
        capture(app, "Phren task detail from its chevron")
    }

    @MainActor
    func testFailedPhrenCallShowsReasonWithoutRawJSONOrChevron() {
        let app = launch(extra: ["--chat-phren-tools"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let card = app.buttons["chat-phren-card:phren-failed"]
        for _ in 0..<12 where !card.isHittable { transcript.swipeDown() }
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertTrue(card.label.contains("Failed"))
        XCTAssertTrue(card.label.contains("Store is read-only."))
        XCTAssertFalse(card.label.contains("Completed"))
        XCTAssertFalse(app.buttons["chat-phren-open:phren-failed"].exists)
        XCTAssertFalse(app.buttons["Retry"].exists)
        card.tap()
        XCTAssertEqual(card.value as? String, "Expanded")
        // The reason is already on the card; no raw JSON follows it.
        XCTAssertFalse(app.staticTexts["Raw error"].exists)
        capture(app, "Failed phren call expanded")
    }

    @MainActor
    func testPhrenSearchChevronOpensAllCapturedResultsAndMissingFindingHasNoChevron() {
        let app = launch(extra: ["--chat-phren-tools"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let search = app.buttons["chat-phren-open:phren-search"]
        for _ in 0..<12 where !search.isHittable { transcript.swipeDown() }
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        XCTAssertTrue(app.navigationBars["Search results"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Fourth match"].exists)
        app.navigationBars.buttons.firstMatch.tap()
        let finding = app.buttons["chat-phren-card:phren-finding"]
        for _ in 0..<12 where !finding.isHittable { transcript.swipeDown() }
        XCTAssertTrue(finding.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-phren-open:phren-finding"].exists)
        finding.tap()
        XCTAssertEqual(finding.value as? String, "Expanded")
    }

    @MainActor
    func testWebFetchAndSearchCardsShowWhereTheAgentWentAndOpenTheResult() {
        let app = launch(extra: ["--chat-web-tools"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let fetch = app.buttons["chat-web-card:web-fetch"], search = app.buttons["chat-web-card:web-search"], pending = app.buttons["chat-web-card:web-pending"]
        for card in [pending, search, fetch] {
            for _ in 0..<8 where !card.isHittable { transcript.swipeDown() }
            XCTAssertTrue(card.waitForExistence(timeout: 5))
        }
        XCTAssertLessThanOrEqual(fetch.frame.height, 44, "A collapsed web card stays one row tall")
        XCTAssertTrue(fetch.label.contains("developer.apple.com/documentation/swiftui/scrollview"), fetch.label)
        XCTAssertFalse(fetch.label.contains("?language="), "Host and path only while folded")
        XCTAssertTrue(search.label.contains("“SwiftUI nested ScrollView gesture”"), search.label)
        XCTAssertTrue(pending.label.contains("example.org/still/loading"), pending.label)
        for card in [fetch, search, pending] { XCTAssertFalse(card.label.contains("{"), "No raw JSON on a folded card") }
        XCTAssertEqual(fetch.value as? String, "Collapsed")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:")).firstMatch.exists, "A reply between the web calls: no run")
        XCTAssertFalse(app.staticTexts["chat-web-prompt:web-fetch"].exists)
        capture(app, "Web fetch and search cards folded")
        fetch.tap()
        XCTAssertEqual(fetch.value as? String, "Expanded")
        XCTAssertTrue(app.staticTexts["chat-web-prompt:web-fetch"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Fetched line 1:")).firstMatch.exists)
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Final fetched marker line")).firstMatch.exists, "Twelve lines, then Read all")
        capture(app, "Web fetch card expanded")
        let readAll = app.buttons["chat-web-read-all:web-fetch"]
        for _ in 0..<4 where !readAll.isHittable { transcript.swipeUp() }
        XCTAssertTrue(readAll.waitForExistence(timeout: 5)); XCTAssertEqual(readAll.label, "Read all")
        readAll.tap()
        XCTAssertTrue(app.buttons["chat-tool-output-wrap"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final fetched marker line")).firstMatch.exists)
        app.navigationBars.buttons.firstMatch.tap()
        // The search's sources read as links, not as Claude Code's JSON line.
        for _ in 0..<8 where !search.isHittable { transcript.swipeDown() }
        search.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Nested ScrollViews in SwiftUI")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Links: [")).firstMatch.exists)
        capture(app, "Web search card expanded")
    }

    @MainActor
    func testSkillCallsAreChipsBetweenRunsAndOpenWhatTheyLoaded() {
        let app = launch(extra: ["--chat-skill-chip"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let chip = app.buttons["chat-skill-chip:skill-design"]
        for _ in 0..<8 where !chip.isHittable { transcript.swipeDown() }
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertTrue(chip.label.contains("/design"), chip.label); XCTAssertTrue(chip.label.contains("the chat cards, tighter"), chip.label)
        XCTAssertFalse(chip.label.contains("{"))
        XCTAssertLessThanOrEqual(chip.frame.height, 44, "A chip, not a card")
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Design pass")).firstMatch.exists, "What the skill loaded stays behind the tap")
        // Three reads before it and three greps after it: the skill is the
        // visible event between two folded runs.
        let runs = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:"))
        XCTAssertTrue(runs.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(runs.count, 2, "A skill call ends the run")
        XCTAssertGreaterThan(chip.frame.minY, runs.element(boundBy: 0).frame.minY)
        XCTAssertLessThan(chip.frame.minY, runs.element(boundBy: 1).frame.minY)
        capture(app, "Skill chip between two read runs")
        chip.tap()
        XCTAssertTrue(app.buttons["chat-tool-output-wrap"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final skill marker line")).firstMatch.exists)
        app.navigationBars.buttons.firstMatch.tap()
    }

    @MainActor
    func testOtherMCPServersGetCardsWithServerVerbRowsAndResult() {
        let app = launch(extra: ["--chat-mcp-card"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let pull = app.buttons["chat-mcp-card:mcp-pr"], panes = app.buttons["chat-mcp-card:mcp-panes"], merge = app.buttons["chat-mcp-card:mcp-merge"]
        for card in [merge, panes, pull] {
            for _ in 0..<8 where !card.isHittable { transcript.swipeDown() }
            XCTAssertTrue(card.waitForExistence(timeout: 5))
        }
        for text in ["GitHub", "Get pull request", "alaarab", "pull number", "42", "2 items", "{2 fields}", "title: Chat: cards for web, skills and MCP", "state: open"] {
            XCTAssertTrue(pull.label.contains(text), "\(text) missing from \(pull.label)")
        }
        for text in ["Herdr", "List panes", "workspace", "3 panes in phone", "2: claude — Review the changes"] {
            XCTAssertTrue(panes.label.contains(text), "\(text) missing from \(panes.label)")
        }
        XCTAssertTrue(merge.label.contains("Merge pull request")); XCTAssertTrue(merge.label.contains("not mergeable"), merge.label)
        // Nested values read as their size, never as JSON.
        for card in [pull, panes, merge] { XCTAssertFalse(card.label.contains("{\""), card.label); XCTAssertFalse(card.label.contains("\":"), card.label) }
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:")).firstMatch.exists, "MCP calls never fold")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:")).firstMatch.exists, "Cards, not pills")
        capture(app, "Cards for other MCP servers")
        pull.tap()
        XCTAssertTrue(app.buttons["chat-tool-output-wrap"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "pull_number")).firstMatch.exists)
        app.navigationBars.buttons.firstMatch.tap()
    }

    // MARK: Tool cards — subagents, todos, plan mode

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
    func testTodoCardsFoldTheEarlierListAndShowTheLatest() {
        let app = launch(extra: ["--chat-todos"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 8))
        let latest = app.descendants(matching: .any).matching(identifier: "chat-todo-card:todo-2").firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 8))
        XCTAssertTrue(latest.label.contains("Todos, 3 of 5 done")); XCTAssertFalse(latest.label.contains("replaced"))
        XCTAssertTrue(app.staticTexts["Write the UI test"].exists)
        XCTAssertTrue(app.staticTexts["Update the changelog"].exists)
        let earlier = app.descendants(matching: .any).matching(identifier: "chat-todo-card:todo-1").firstMatch
        XCTAssertTrue(earlier.exists); XCTAssertTrue(earlier.label.contains("Todos, 0 of 3 done, replaced by a later list"))
        // The earlier list is one line until tapped: its items are not laid out.
        XCTAssertFalse(app.staticTexts["Sketch the card"].exists)
        let task = app.descendants(matching: .any).matching(identifier: "chat-todo-card:task-1").firstMatch
        XCTAssertTrue(task.exists); XCTAssertTrue(task.label.contains("Tasks, 0 of 1 done"))
        XCTAssertTrue(app.staticTexts["Verify the cards on a device"].exists)
        XCTAssertEqual(rawJSONTexts(app).count, 0, "No raw JSON on a card")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "activeForm")).firstMatch.exists)
        capture(app, "Todo cards")
        let folded = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Todos, 0 of 3 done")).firstMatch
        for _ in 0..<6 where !folded.isHittable { app.scrollViews["chat-transcript"].swipeDown() }
        XCTAssertTrue(folded.waitForExistence(timeout: 5))
        folded.tap()
        XCTAssertTrue(app.staticTexts["Sketch the card"].waitForExistence(timeout: 3))
    }

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
    func testClaudePastedImageReplacesPendingTwinAndHidesImageTokens() {
        let app = launch(extra: ["--chat-claude-image", "--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let pending = app.descendants(matching: .any)["chat-queued-tag:2:0"].firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["queued"].exists)
        XCTAssertFalse(app.buttons["View conversation image"].exists)
        capture(app, "Pending pasted image turn")
        app.buttons["chat-stop"].tap()
        XCTAssertTrue(app.buttons["View conversation image"].waitForExistence(timeout: 8))
        XCTAssertFalse(pending.exists)
        XCTAssertFalse(app.descendants(matching: .any)["chat-message:2:0"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Why does this terminal wrap?"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "[Image #1]")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Attached files on this computer:")).firstMatch.exists)
        let real = app.descendants(matching: .any)["chat-message:3:0"].firstMatch
        XCTAssertTrue(real.buttons["View conversation image"].exists)
        capture(app, "Landed pasted image in one bubble")
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
    func testChatPopsWithEdgeAndMiddleSwipeAndEscape() {
        let app = launch()
        let row = app.buttons["live-chat:w7:w7:t9"]
        row.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        // A finger rests before it drags; the instant synthetic drag never
        // registers as an edge pan over a scrollable transcript.
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
        edge.press(forDuration: 0.4, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        XCTAssertTrue(row.waitForExistence(timeout: 5), "The system edge swipe should pop the chat")

        row.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.36))
        middle.press(forDuration: 0.12, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.36)))
        XCTAssertTrue(row.waitForExistence(timeout: 5), "A held rightward pan from the middle should pop chat")

        row.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        // Escape is registered too, but XCUITest's synthesized Escape does not
        // reach UIKit key commands on the simulator; ⌘[ proves the wiring.
        // The simulator swallows the first synthesized key event while it
        // attaches the hardware keyboard; Escape (also registered) warms it up.
        // Synthesizing a key while the simulator attaches the hardware
        // keyboard can time out outright on a busy host; the retry below is
        // the same keystroke, not a weaker check.
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        sleep(1)
        for _ in 0..<2 where !row.exists {
            app.typeKey("[", modifierFlags: .command)
            sleep(1)
        }
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Escape or ⌘[ should go back")
    }

    @MainActor
    func testConsecutiveReadsFoldAndExpandToOriginalCards() {
        let app = launch(extra: ["--chat-read-run"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let run = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:")).firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 8))
        XCTAssertTrue(run.label.contains("3 read operations"))
        XCTAssertFalse(app.buttons["chat-tool-group:2:0"].exists)
        capture(app, "Read-only calls folded into one row")
        run.tap()
        let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:"))
        XCTAssertGreaterThanOrEqual(cards.count, 3)
        XCTAssertTrue(cards.firstMatch.isHittable)
    }

    /// Coming back from another app used to bring the stack's own bar back
    /// above the chat's header; the floating header is the only top bar.
    @MainActor
    func testReturningFromBackgroundKeepsTheSystemBarHidden() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 8))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 8))
        let header = app.descendants(matching: .any).matching(identifier: "chat-header").firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Agent chat"].waitForExistence(timeout: 2), "The system bar stays hidden after the app returns")
        XCTAssertLessThan(header.frame.minY, 70, "The floating header sits directly under the status bar; no system bar is above it")
        capture(app, "Chat after foreground")
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
    func testShellRunsFoldEitherSideOfTheCallThatChangedAFile() {
        let app = launch(extra: ["--chat-shell-run"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let runs = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:"))
        let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:"))
        XCTAssertTrue(runs.firstMatch.waitForExistence(timeout: 8))
        for _ in 0..<6 where !runs.firstMatch.isHittable { transcript.swipeDown() }
        XCTAssertEqual(runs.count, 2, "The command that changed a file splits the looking around")
        XCTAssertTrue(runs.element(boundBy: 0).label.contains("Shell ×3"), runs.element(boundBy: 0).label)
        XCTAssertTrue(runs.element(boundBy: 1).label.contains("Shell ×4"), runs.element(boundBy: 1).label)
        XCTAssertLessThanOrEqual(runs.firstMatch.frame.height, 44, "A folded run is one pill tall")
        // The change card sits between them with its file row already showing.
        XCTAssertEqual(cards.count, 1)
        XCTAssertEqual(cards.firstMatch.label, "Shell, 1 operation")
        XCTAssertTrue(app.buttons["chat-patch-file:Changed.swift"].waitForExistence(timeout: 5))
        capture(app, "Shell runs folded around a change")
        runs.element(boundBy: 0).tap()
        XCTAssertEqual(runs.element(boundBy: 0).value as? String, "Expanded")
        XCTAssertTrue(cards.element(boundBy: 3).waitForExistence(timeout: 5))
        XCTAssertEqual(cards.count, 4, "Expanding shows the three original cards")
        XCTAssertTrue(cards.firstMatch.isHittable)
        XCTAssertTrue(app.buttons["chat-patch-file:Changed.swift"].exists)
        capture(app, "Shell run expanded to its cards")
        runs.element(boundBy: 0).tap()
        XCTAssertEqual(runs.element(boundBy: 0).value as? String, "Collapsed")
        XCTAssertTrue(cards.element(boundBy: 3).waitForNonExistence(timeout: 5))
        XCTAssertEqual(cards.count, 1)
    }

    @MainActor
    func testDraftSelectionDragsPastVisibleLinesWithoutDismissingKeyboard() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let oneLineHeight = composer.frame.height
        composer.tap()
        composer.typeText("Alpha first line\nBravo second line\nCharlie third line")
        XCTAssertGreaterThan(composer.frame.height, oneLineHeight + 15)
        composer.typeText("\nDelta fourth line\nEcho fifth line\nFoxtrot sixth line\nGolf seventh line\nHotel eighth line\nIndia ninth line\nJuliet tenth line\nKilo eleventh line\nOmega final line")
        let cappedHeight = composer.frame.height
        XCTAssertLessThan(cappedHeight, oneLineHeight * 4)
        // Typing leaves the caret at the end. Scroll the editor itself back
        // to the first line before selecting, keeping the draft intact.
        for _ in 0..<4 {
            let start = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.2))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: cappedHeight - 20)))
        }
        composer.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 30, dy: 16)).doubleTap()
        let report = app.staticTexts["chat-fixture-copied"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.selectionReport(app)["selected"] as? String == "Alpha"
        }, object: report)], timeout: 5), .completed)
        let before = selectionReport(app)["selected"] as? String ?? ""
        let marker = app.descendants(matching: .any)["chat-paragraph:2:0:2"]
        let originalY = marker.frame.minY
        let handle = selectionEnd(app, in: composer)
        let belowEditor = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 1))
            .withOffset(CGVector(dx: 0, dy: 30))
        handle.press(forDuration: 0.15, thenDragTo: belowEditor, withVelocity: .slow, thenHoldForDuration: 3)
        let selected = selectionReport(app)["selected"] as? String ?? ""
        XCTAssertTrue(app.keyboards.firstMatch.exists, "The handle drag must keep the keyboard up")
        XCTAssertGreaterThan(selected.count, before.count, "The actual UITextView selection must grow")
        XCTAssertTrue(selected.contains("Omega final line"), "Edge autoscroll must reach beyond the four visible lines")
        XCTAssertEqual(marker.frame.minY, originalY, accuracy: 2, "The transcript must stay still while the editor scrolls")
        XCTAssertEqual(composer.frame.height, cappedHeight, accuracy: 1)
        // Collapse the selection by typing, then exercise dismissal again
        // in the same chat to catch a selection guard that never releases.
        composer.typeText("Replacement")
        dragTranscriptDown(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testPlainTranscriptDragStillDismissesKeyboardInteractively() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Keep this draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        dragTranscriptDown(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "Keep this draft")
    }

    @MainActor
    func testMessageSelectionHandleDoesNotMoveTranscriptOrDismissSelection() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let paragraph = app.descendants(matching: .any)["chat-paragraph:2:0:1"]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 8))
        paragraph.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: 5)).doubleTap()
        let selectable = app.textViews["chat-selectable:2:0:1"]
        XCTAssertTrue(selectable.waitForExistence(timeout: 5))
        let report = app.staticTexts["chat-fixture-copied"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.selectionReport(app)["selected"] as? String == "Bravo"
        }, object: report)], timeout: 5), .completed)
        let originalFrame = selectable.frame
        let keyboardWasVisible = app.keyboards.firstMatch.exists
        let bottom = selectable.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1))
            .withOffset(CGVector(dx: 0, dy: 20))
        selectionEnd(app, in: selectable).press(forDuration: 0.15, thenDragTo: bottom, withVelocity: .slow, thenHoldForDuration: 1)
        XCTAssertTrue(selectable.exists, "A handle drag must not exit Select text mode")
        XCTAssertEqual(selectable.frame.minY, originalFrame.minY, accuracy: 2)
        XCTAssertEqual(app.keyboards.firstMatch.exists, keyboardWasVisible)
        XCTAssertGreaterThan((selectionReport(app)["selected"] as? String ?? "").count, "Bravo".count)
        XCTAssertTrue(app.buttons["chat-selectable-done"].exists)
    }

    @MainActor private func selectionReport(_ app: XCUIApplication) -> [String: Any] {
        let label = app.staticTexts["chat-fixture-copied"].label
        return (try? JSONSerialization.jsonObject(with: Data(label.utf8)) as? [String: Any]) ?? [:]
    }

    @MainActor private func selectionEnd(_ app: XCUIApplication, in editor: XCUIElement) -> XCUICoordinate {
        let report = selectionReport(app)
        return editor.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: report["selectionEndX"] as? Double ?? 0,
            dy: report["selectionEndY"] as? Double ?? 0))
    }

    @MainActor private func dragTranscriptDown(_ app: XCUIApplication) {
        let transcript = app.scrollViews["chat-transcript"]
        let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 150)))
    }

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
    func testCompactBottomComposerAndTapToDismissKeyboard() {
        let app = launch(extra: ["--chat-markdown"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertLessThanOrEqual(composer.frame.height, 40)
        let box = app.descendants(matching: .any).matching(identifier: "chat-message-box").firstMatch
        XCTAssertGreaterThan(box.frame.maxY, app.frame.maxY - 40)
        XCTAssertLessThanOrEqual(box.frame.height, 84)
        XCTAssertGreaterThan(composer.frame.width, app.frame.width - 55)
        let lastLine = app.staticTexts["Ready to test."]
        XCTAssertTrue(lastLine.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        composer.tap(); composer.typeText("Keep this draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready to test."].isHittable,
                      "The last transcript message stays visible when the composer gains focus")
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        capture(app, "Smaller chat text and bottom composer")
        app.staticTexts["Ready to test."].tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertTrue(app.staticTexts["Ready to test."].isHittable,
                      "The last transcript message stays visible after the keyboard is dismissed")
        XCTAssertEqual(composer.value as? String, "Keep this draft")
        XCTAssertGreaterThan(box.frame.maxY, app.frame.maxY - 50)
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        // A code block has no title bar: tapping it (like any transcript
        // surface) still hands the keyboard away without touching the draft.
        app.descendants(matching: .any)["chat-code-block"].firstMatch.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)], timeout: 5), .completed)
        XCTAssertEqual(composer.value as? String, "Keep this draft")
        capture(app, "Chat keyboard dismissed without losing the draft")
    }

    @MainActor
    func testCopilotChatAndCustomSlashCommandOpenExactTerminal() {
        let app = launch(extra: ["--chat-copilot"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["Copilot is connected to this project. What would you like to change?"].waitForExistence(timeout: 8))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "chat-provider").firstMatch.label, "Copilot")
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
        app.buttons["herdr-terminal-back"].tap()
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
        XCTAssertLessThanOrEqual(group.frame.height, 44, "The compact tool pill stays one row tall")
        let header = app.descendants(matching: .any).matching(identifier: "chat-header").firstMatch
        let messageBox = app.descendants(matching: .any).matching(identifier: "chat-message-box").firstMatch
        XCTAssertTrue(header.exists)
        XCTAssertTrue(messageBox.exists)
        XCTAssertLessThan(header.frame.minY, 70, "The header sits directly under the status bar")
        XCTAssertGreaterThan(messageBox.frame.maxY, app.frame.maxY - 40, "The composer sits on the home indicator")
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
        app.buttons["chat-composer-terminal"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        app.buttons["herdr-terminal-back"].tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Agent chat"].exists)
        XCTAssertEqual(composer.value as? String, "Keep the Phren details")
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
        let header = app.otherElements["herdr-terminal-header"]
        XCTAssertTrue(header.waitForExistence(timeout: 8))
        XCTAssertTrue(header.staticTexts["Test Mac"].waitForExistence(timeout: 8))
        XCTAssertTrue(header.staticTexts["work"].exists)
    }
    @MainActor
    func testChatOptionsOpenTheSessionCodeIndex() {
        let app = launch(extra: ["--code-fixture"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let more = app.buttons["chat-options"]
        XCTAssertTrue(more.waitForExistence(timeout: 8)); more.tap()
        let code = app.buttons["chat-options-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 8)); code.tap()
        XCTAssertTrue(app.textFields["code-search"].waitForExistence(timeout: 8))
        capture(app, "Code from chat header actions")
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
        XCTAssertTrue(app.staticTexts["Which accent should the project use?"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Claude has a question"].exists)
        XCTAssertTrue(app.staticTexts["Design"].exists)
        XCTAssertTrue(app.staticTexts["Which screens should change?"].exists)
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
        let first = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "The Hook currently resolves")).firstMatch
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
    func testConversationImageDoubleTapZoomsAndCloses() {
        let app = launch(extra: ["--chat-historical-image", "--chat-image-zoom"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let picture = app.buttons["View conversation image"]
        XCTAssertTrue(picture.waitForExistence(timeout: 8))
        picture.tap()
        let viewer = app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 8))
        XCTAssertEqual(viewer.value as? String, "Fit")
        viewer.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)).doubleTap()
        let zoomed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", "Fit"), object: viewer)
        XCTAssertEqual(XCTWaiter.wait(for: [zoomed], timeout: 5), .completed)
        capture(app, "Conversation image zoom")
        viewer.doubleTap()
        let fitted = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Fit"), object: viewer)
        XCTAssertEqual(XCTWaiter.wait(for: [fitted], timeout: 5), .completed)
        app.buttons["image-viewer-close"].tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
        XCTAssertTrue(picture.exists)
    }

    @MainActor
    func testHistoricalImageDiffAndNativeHerdrNavigation() {
        let app = launch(extra: ["--chat-historical-image"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["View conversation image"].waitForExistence(timeout: 8))
        app.buttons["View conversation image"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch.waitForExistence(timeout: 5))
        app.buttons["image-viewer-close"].tap()
        app.buttons["chat-diff"].tap()
        // The header's Changes screen: staged, unstaged and untracked files
        // in List mode, the change itself in Diff mode.
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "changes-header").firstMatch.waitForExistence(timeout: 5))
        app.buttons["changes-mode-list"].tap()
        let listed = { (path: String) in app.staticTexts.matching(NSPredicate(format: "label == %@", path)).firstMatch }
        XCTAssertTrue(listed("Sources/App.swift").waitForExistence(timeout: 5))
        XCTAssertTrue(listed("Sources/App/Settings.swift").exists, "Staged and unstaged files are listed in their own groups")
        XCTAssertTrue(listed("Notes.md").exists, "Untracked files are listed too")
        capture(app, "Repository changes list")
        app.buttons["changes-mode-diff"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "-let accent = green")).firstMatch.exists)
        capture(app, "Native repository diff")
        // A file under a folder nests under it in the working tree, like
        // Finder or VS Code's source control view; expand the folder to reach
        // it, and the file opens its own diff with the side-by-side option.
        app.buttons["changes-tab-tree"].tap()
        let sources = app.buttons["changes-tree-entry:Sources"]
        XCTAssertTrue(sources.waitForExistence(timeout: 5)); sources.tap()
        let appFile = app.buttons["changes-tree-entry:Sources/App.swift"]
        XCTAssertTrue(appFile.waitForExistence(timeout: 5)); appFile.tap()
        let fileBar = app.navigationBars["App.swift"]
        XCTAssertTrue(fileBar.waitForExistence(timeout: 5))
        app.buttons["diff-options"].tap()
        app.buttons["Side by side"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "-let accent = green, +let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Side-by-side repository diff")
        app.buttons["diff-options"].tap()
        app.buttons["Inline"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        fileBar.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["changes-tab-tree"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["chat-composer-terminal"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Toggle terminal keyboard"].waitForExistence(timeout: 8))
        capture(app, "Native Herdr terminal")
    }

    /// The source-control sheet: the branch stat line from /v1/git/status, the
    /// five segment tabs, the GitHub pull list, and a working-tree folder that
    /// expands to its changed file. One launch covers both tabs' assertions.
    @MainActor
    func testChangesScreenTabsPullRequestsAndWorkingTree() {
        let app = launch(extra: ["--chat-diffs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 8))
        app.buttons["chat-diff"].tap()
        let status = app.descendants(matching: .any).matching(identifier: "changes-status-line").firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 8))
        XCTAssertEqual(status.label, "main · 2 unstaged · 1 untracked · 3 +12 -3")
        for identifier in ["changes-tab-changes", "changes-tab-history", "changes-tab-branches", "changes-tab-pulls", "changes-tab-tree"] {
            XCTAssertTrue(app.buttons[identifier].waitForExistence(timeout: 5), "Missing \(identifier)")
        }
        capture(app, "Changes screen")
        app.buttons["changes-tab-pulls"].tap()
        let pull = app.buttons["changes-pull:42"]
        XCTAssertTrue(pull.waitForExistence(timeout: 8))
        XCTAssertTrue(pull.label.contains("Changes: pull requests and a working tree"))
        capture(app, "Pull requests in the changes screen")
        app.buttons["changes-tab-tree"].tap()
        let folder = app.buttons["changes-tree-entry:Sources"]
        XCTAssertTrue(folder.waitForExistence(timeout: 8))
        folder.tap()
        XCTAssertTrue(app.buttons["changes-tree-entry:Sources/App.swift"].waitForExistence(timeout: 8))
        capture(app, "Working tree with change badges")
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
        // Three commands that changed nothing fold into one read run now;
        // open it to reach the three original tool rows.
        let run = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:")).firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 8))
        run.tap()
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
        app.navigationBars.buttons.firstMatch.tap()
        rows.firstMatch.tap()
        XCTAssertEqual(rows.firstMatch.value as? String, "Collapsed")
        XCTAssertTrue(app.buttons["chat-close"].isHittable)
    }

    @MainActor
    func testDenseToolOutputPagesKeepEveryLineReachable() {
        let app = launch(extra: ["--chat-dense-tools"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        // Three commands that changed nothing fold into one read run now;
        // open it to reach the three original tool rows.
        let run = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:")).firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 8))
        run.tap()
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
        app.navigationBars.buttons.firstMatch.tap()
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

    /// Words and a picture sent together stay one bubble: the image sits
    /// above the text inside it, and the path list the phone appended is gone.
    @MainActor
    func testImageAndTextOfOneTurnShareABubble() {
        let app = launch(extra: ["--chat-image-turn"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["View conversation image"].waitForExistence(timeout: 8))
        let bubbles = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "chat-message:", "Your message"))
        let bubble = bubbles.allElementsBoundByIndex.first { $0.staticTexts["Look at this header"].exists }
        XCTAssertNotNil(bubble, "The paste marker and the path list are gone")
        XCTAssertTrue(bubble?.buttons["View conversation image"].exists == true, "The picture is inside the same bubble")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Attached files on this computer")).firstMatch.exists)
        XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-message:")).count, 3, "Two fixture turns plus this one — not a fourth bubble for the image")
        capture(app, "Image and text in one bubble")
    }

    /// Every picture the agent read shows under its tool pill without opening
    /// the card, and the pictures sent from the phone — which the transcript
    /// names only by path — sit in the bubble in place of their markers.
    @MainActor
    func testReadImagesShowUnderThePillAndUploadedPicturesInTheBubble() {
        let app = launch(extra: ["--chat-read-images"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let pictures = app.buttons.matching(NSPredicate(format: "label == %@", "View conversation image"))
        XCTAssertTrue(pictures.firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Look at these"].waitForExistence(timeout: 5))
        XCTAssertEqual(pictures.count, 4, "Two frames of the read, two pictures from the phone")
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "chat-tool-group:", "Read")).firstMatch
        XCTAssertTrue(card.exists)
        XCTAssertEqual(card.value as? String, "Collapsed", "The frames show without opening the card")
        let bubble = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "chat-message:", "Your message"))
            .allElementsBoundByIndex.first { $0.staticTexts["Look at these"].exists }
        XCTAssertNotNil(bubble, "The markers are gone from the words")
        XCTAssertEqual(bubble?.buttons.matching(NSPredicate(format: "label == %@", "View conversation image")).count, 2, "Both pictures are inside the bubble")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "[Image: source:")).firstMatch.exists)
        capture(app, "Read frames under the pill, uploaded pictures in the bubble")
        pictures.firstMatch.tap()
        let viewer = app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Conversation image.jpg"].exists)
        XCTAssertEqual(viewer.value as? String, "Fit")
        app.buttons["image-viewer-close"].tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
        XCTAssertEqual(card.value as? String, "Collapsed")
        XCTAssertEqual(pictures.count, 4)
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
    func testToolPatchShowsChangesAndUnwrapsResult() {
        let app = launch(extra: ["--chat-diffs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let group = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "chat-tool-group:", "Patch")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 8))
        group.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let action = phrenPurple")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Updated Theme.swift"].exists)
        XCTAssertTrue(app.buttons["Copy patch"].exists)
        capture(app, "Phren purple actions and native tool diff")
        // A Read of an image shows the image itself in the card.
        let transcript = app.scrollViews["chat-transcript"]
        let read = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "chat-tool-group:", "Read")).firstMatch
        XCTAssertTrue(read.waitForExistence(timeout: 3)); read.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-historical-image"].firstMatch.waitForExistence(timeout: 8))
        for _ in 0..<8 where !read.isHittable { transcript.swipeDown() }
        read.tap()
        // A collapsed tool stays one fixed-height row. Opening it reveals
        // the changed-file cards; each file can then expand or push its reader.
        let shell = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "chat-tool-group:", "Shell")).firstMatch
        XCTAssertTrue(shell.waitForExistence(timeout: 3))
        XCTAssertTrue(shell.label.contains("Shell")); XCTAssertFalse(shell.label.contains("×"))
        // Without opening the card, the files it changed on disk — folded to
        // their title bars. Tap one for its preview, open it full screen, fold it again.
        let theme = app.buttons["chat-patch-file:Theme.swift"], findings = app.buttons["chat-patch-file:phone/FINDINGS.md"]
        XCTAssertTrue(theme.waitForExistence(timeout: 5)); XCTAssertTrue(findings.exists)
        let purple = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch
        XCTAssertFalse(purple.exists)
        capture(app, "Files a shell command changed, folded under the collapsed card")
        theme.tap()
        XCTAssertTrue(purple.waitForExistence(timeout: 5))
        capture(app, "One changed file unfolded to its preview")
        app.buttons["chat-patch-open"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Theme.swift"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["diff-options"].exists)
        // Long lines can wrap instead of scrolling; the switch lives in ⋯ and persists.
        app.buttons["diff-options"].tap()
        let wrap = app.buttons["diff-options-sheet:wrap"]
        XCTAssertTrue(wrap.waitForExistence(timeout: 3)); wrap.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 3))
        app.buttons["diff-options"].tap(); app.buttons["diff-options-sheet:wrap"].tap()
        app.navigationBars["Theme.swift"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(theme.waitForExistence(timeout: 5)); theme.tap()
        XCTAssertFalse(purple.waitForExistence(timeout: 1))
        // A run of removed then added lines draws as one block.
        findings.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+- Geocoder batches at 8/s")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Multi-line change drawn as one block")
        findings.tap()
        shell.tap()
        // Expanded: the command, its output, then the same folded files.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "open(p,'w').write(s)")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-patch-file:phone/FINDINGS.md"].waitForExistence(timeout: 3))
        // The header's diff screen covers the whole tree, plus every place the
        // session's commands wrote to.
        app.buttons["chat-diff"].tap()
        // The header's Changes screen covers the pane's whole tree: the
        // shell edit is an unstaged file in List mode and a diff in Diff mode.
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "changes-header").firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["changes-title"].label, "Uncommitted changes")
        app.buttons["changes-mode-list"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "Sources/App.swift")).firstMatch.waitForExistence(timeout: 5))
        app.buttons["changes-mode-diff"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Repository changes from a shell edit, syntax colored")
    }

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
        let viewer = app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Screenshot.png"].exists)
        XCTAssertEqual(viewer.value as? String, "Fit")
        app.buttons["image-viewer-close"].tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
        app.buttons["Remove Screenshot.png"].tap()
        XCTAssertFalse(app.buttons["Preview Screenshot.png"].exists)
        attachImage(app)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Review this screenshot")
        capture(app, "Image and prompt ready to send")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.buttons["View attached Screenshot.png"].waitForExistence(timeout: 8))
        app.buttons["View attached Screenshot.png"].tap()
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Screenshot.png"].exists)
        app.buttons["image-viewer-close"].tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
        capture(app, "Sent image in conversation")
        if app.buttons["Latest messages"].isHittable { app.buttons["Latest messages"].tap() }
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Review this screenshot"].waitForExistence(timeout: 8))
        // The upload note is its own paragraph, below the echoed reply.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/tmp/phren-fixture/")).firstMatch.exists)
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
        // its status snapshots deliberately keep saying working.
        app.buttons["chat-stop"].tap()
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
    func testComposerHasNoClipboardButtonWhenAnImageIsAvailable() {
        let app = launch(extra: ["--clipboard-image-fixture"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Add attachment"].exists)
        XCTAssertFalse(app.buttons["chat-paste-image"].exists)
        XCTAssertFalse(app.buttons["Paste image"].exists)
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
    func testSlashPermissionsDrawsTheMenuNativelyAndWalksItWithKeys() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/permissions")
        app.buttons["chat-send"].tap()
        let full = app.buttons["chat-menu:2"]
        XCTAssertTrue(full.waitForExistence(timeout: 5), "The agent's menu is drawn as native rows")
        XCTAssertTrue(full.label.contains("Full Access"))
        capture(app, "Permissions menu")
        full.tap()
        let echoed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/permissions")).firstMatch
        XCTAssertTrue(echoed.waitForExistence(timeout: 8), "The command is typed for the agent")
        XCTAssertFalse(app.otherElements["herdr-terminal-header"].exists, "The menu is walked with keys, not in the terminal")
        XCTAssertFalse(app.staticTexts["chat-delivery-error"].waitForExistence(timeout: 3))
    }

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
        XCTAssertTrue(app.textFields["agent-drawer-search"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Finding your agents…"].exists, "The drawer reuses the revealed overview")
        app.buttons["agent-drawer-order:recent"].tap()
        capture(app, "Recent sessions drawer")
        app.buttons["agent-drawer-order:list"].tap()
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
        let code = app.descendants(matching: .any)["chat-code-block"].firstMatch
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Copy code"].exists, "No title bar above the code")
        code.press(forDuration: 0.6)
        // Reading the app's pasteboard from the runner raises iOS's paste
        // permission alert, so the flash (held longer under UI testing) is
        // the evidence.
        XCTAssertTrue(app.descendants(matching: .any)["chat-code-copied"].waitForExistence(timeout: 4), "Holding the block copies it")
        app.buttons["chat-stop"].tap()
        XCTAssertTrue(app.staticTexts["Turn stopped in the selected pane."].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["chat-send"].exists)
        XCTAssertFalse(app.buttons["chat-stop"].exists)
        capture(app, "Native code card and stopped turn")
    }

    /// Holding a paragraph offers that paragraph, not the bubble's whole
    /// message; a double-tap swaps in native selection with the word under
    /// the finger, and a tap elsewhere puts the paragraph back.
    @MainActor
    func testParagraphMenuCopiesOneParagraphAndDoubleTapSelectsItsWord() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let any = app.descendants(matching: .any)
        let first = any["chat-paragraph:2:0:0"], second = any["chat-paragraph:2:0:1"], third = any["chat-paragraph:2:0:2"]
        XCTAssertTrue(third.waitForExistence(timeout: 8), "Blank lines split the reply into paragraphs")
        XCTAssertTrue(any["chat-code-block"].firstMatch.exists, "The code block keeps its own hold-to-copy")
        let report = app.staticTexts["chat-fixture-copied"]
        func reported() -> [String: Any] {
            (try? JSONSerialization.jsonObject(with: Data(report.label.utf8)) as? [String: Any]) ?? [:]
        }
        // A few points in from a paragraph's top-left corner is its first
        // word, at every text size: where the hold and the double-tap land.
        func start(_ paragraph: XCUIElement) -> XCUICoordinate {
            paragraph.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: 5))
        }
        start(second).press(forDuration: 1.0)
        let copyParagraph = app.buttons["Copy paragraph"]
        XCTAssertTrue(copyParagraph.waitForExistence(timeout: 5), "The paragraph's menu, above the bubble's")
        XCTAssertTrue(app.buttons["Select text"].exists)
        XCTAssertTrue(app.buttons["chat-message-menu:copy-message"].exists)
        XCTAssertTrue(app.buttons["chat-message-menu:share"].exists)
        capture(app, "Paragraph menu")
        copyParagraph.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (reported()["copied"] as? [String])?.isEmpty == false
        }, object: report)], timeout: 5), .completed)
        XCTAssertEqual(reported()["copied"] as? [String], ["Bravo paragraph explains why `ChatRichText` renders blocks, each copying on its own."],
                       "Only the held paragraph, as plain Markdown")

        start(third).doubleTap()
        let selectable = any["chat-selectable:2:0:2"]
        XCTAssertTrue(selectable.waitForExistence(timeout: 5), "The double-tapped paragraph becomes native text")
        XCTAssertFalse(any["chat-selectable:2:0:1"].exists, "Only one paragraph is selectable")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            reported()["selected"] as? String == "Charlie"
        }, object: report)], timeout: 5), .completed, "The word under the double-tap starts selected: \(reported())")
        XCTAssertTrue((selectable.value as? String ?? "").hasPrefix("Charlie paragraph"), "The native view carries the paragraph's text")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Selecting never raises the keyboard")
        XCTAssertTrue(app.buttons["chat-selectable-done"].exists)
        capture(app, "Word selected in place")
        // Holding the native text gives the system's own menu, not the
        // paragraph's.
        selectable.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).press(forDuration: 1.0)
        XCTAssertFalse(app.buttons["Copy paragraph"].waitForExistence(timeout: 1.5), "The selectable text keeps its native menu")

        start(first).tap()
        // The system menu, when it is up, takes the first tap for itself.
        if !selectable.waitForNonExistence(timeout: 2) { start(first).tap() }
        XCTAssertTrue(selectable.waitForNonExistence(timeout: 5), "A tap elsewhere puts the paragraph back")
        XCTAssertTrue(third.exists)
        XCTAssertFalse(app.buttons["chat-selectable-done"].exists)

        // The menu's "Select text" starts from the whole paragraph; Done ends it.
        start(first).press(forDuration: 1.0)
        let select = app.buttons["Select text"]
        XCTAssertTrue(select.waitForExistence(timeout: 5)); select.tap()
        let whole = any["chat-selectable:2:0:0"]
        XCTAssertTrue(whole.waitForExistence(timeout: 5))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (reported()["selected"] as? String)?.hasPrefix("Alpha paragraph opens") == true
        }, object: report)], timeout: 5), .completed, "Select text starts with the whole paragraph: \(reported())")
        let done = app.buttons["chat-selectable-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 3))
        done.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        if !whole.waitForNonExistence(timeout: 2) { done.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        XCTAssertTrue(whole.waitForNonExistence(timeout: 5), "Done puts the paragraph back")
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
    func testTabWithoutAnAgentOpensTheTerminalAndKeepsItOneTapAway() {
        let app = launch(extra: ["--chat-shell-only"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8), "A shell-only tab goes straight to its terminal")
        app.buttons["herdr-terminal-back"].tap()
        XCTAssertTrue(app.staticTexts["No agent in this tab"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 2), "The fallback happens once, not on every return")
        XCTAssertTrue(app.buttons["chat-composer-terminal"].isEnabled)
        XCTAssertFalse(app.buttons["chat-send"].isEnabled)
        capture(app, "Shell-only tab offers the terminal without an agent")
        app.buttons["chat-terminal-pane:w7:p1"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        app.buttons["herdr-terminal-back"].tap()
        XCTAssertTrue(app.staticTexts["No agent in this tab"].waitForExistence(timeout: 5))
        app.buttons["chat-composer-terminal"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
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
    func testMessageMenuCoversComposerAndKeepsPressedMessageAboveItsBackdrop() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let any = app.descendants(matching: .any)
        let paragraph = any["chat-paragraph:2:0:1"]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 8))
        let composer = any.matching(identifier: "chat-composer").firstMatch
        let composerFrame = composer.frame
        paragraph.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: 5)).press(forDuration: 0.6)
        let backdrop = any["chat-message-menu-backdrop"]
        let preview = any["chat-message-menu-preview"]
        XCTAssertTrue(backdrop.waitForExistence(timeout: 5))
        XCTAssertTrue(preview.exists)
        XCTAssertTrue(backdrop.frame.contains(composerFrame), "The dimmed backdrop covers the entire composer")
        XCTAssertFalse(composer.exists && composer.isHittable, "Input is blocked behind the menu")
        XCTAssertTrue(preview.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Bravo paragraph")).firstMatch.exists)
        for id in ["copy-paragraph", "select-text", "copy-message", "share"] {
            let action = app.buttons["chat-message-menu:" + id]
            XCTAssertTrue(action.isHittable)
            XCTAssertFalse(action.frame.intersects(preview.frame), "Actions never cover the lifted message")
        }
        capture(app, "Message lifted above composer backdrop")
        app.buttons["chat-message-menu:close"].tap()
        XCTAssertTrue(backdrop.waitForNonExistence(timeout: 5))
        XCTAssertTrue(composer.isHittable)
        XCTAssertTrue(paragraph.exists)
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
        let found = app.buttons["live-chat:w7:w7:t9"]
        XCTAssertTrue(found.waitForExistence(timeout: 10))
        found.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
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
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Continue parser checks"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["child-composer-note"].exists)
        capture(app, "Pane child full chat")
    }

    @MainActor
    private func launch(extra: [String] = [], chat: String = "live-chat:w7:w7:t9") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"] + extra
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        // The first launch of a test run sometimes comes up before the fixture
        // bootstrap finishes (no computers, no memory) and stays that way; a
        // relaunch always lands. Real launches are unaffected.
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
            app.tabBars.buttons["Agents"].tap()
            // The list's rows are lazy: the Computers section is only in the
            // tree once scrolled to, which at accessibility text sizes takes
            // many screens of session cards.
            let revealed = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "live-host:")).firstMatch
            if revealed.waitForExistence(timeout: attempt == 0 ? 12 : 25) || app.staticTexts["agents-introduction"].exists == false { break }
            if attempt == 0 { app.terminate() }
        }
        for _ in 0..<14 {
            if host.exists && host.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(host.waitForExistence(timeout: 5), "The fixture computer must appear in Agents")
        host.tap()
        XCTAssertTrue(app.buttons[chat].waitForExistence(timeout: 10))
        return app
    }
    /// Texts showing a brace — tool JSON leaking onto a card. The fixture's
    /// own 1-point report of what was copied is JSON by design.
    @MainActor private func rawJSONTexts(_ app: XCUIApplication) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND identifier != %@", "{", "chat-fixture-copied"))
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}
