import XCTest

final class AgentChatTests: XCTestCase {
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
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-tag:")).firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Create the first file"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.staticTexts["chat-starting"].exists)
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-tag:")).firstMatch.exists)
        capture(app, "New session transcript attached")
    }

    @MainActor
    func testPhrenToolsHaveTheirOwnCardsAndOpenFullDetails() {
        let app = launch(extra: ["--chat-phren-tools"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 8))
        for (id, verb) in [("search", "Recalled memories"), ("complete", "Completed a task"), ("task", "Added a task"), ("finding", "Saved a finding")] {
            let card = app.buttons["chat-phren-card:phren-" + id]
            for _ in 0..<8 where !card.isHittable { app.scrollViews["chat-transcript"].swipeDown() }
            XCTAssertTrue(card.waitForExistence(timeout: 5)); XCTAssertTrue(card.label.contains(verb))
        }
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:")).firstMatch.exists)
        capture(app, "Phren memory and task cards")
        app.buttons["chat-phren-card:phren-finding"].tap()
        XCTAssertTrue(app.buttons["chat-tool-output-done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "findingType")).firstMatch.exists)
        app.buttons["chat-tool-output-done"].tap()
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
        XCTAssertTrue(app.buttons["chat-tool-output-done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final fetched marker line")).firstMatch.exists)
        app.buttons["chat-tool-output-done"].tap()
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
        XCTAssertTrue(app.buttons["chat-tool-output-done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final skill marker line")).firstMatch.exists)
        app.buttons["chat-tool-output-done"].tap()
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
        XCTAssertTrue(app.buttons["chat-tool-output-done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "pull_number")).firstMatch.exists)
        app.buttons["chat-tool-output-done"].tap()
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
        XCTAssertEqual(rawJSONTexts(app).count, 0, "No raw JSON on a card")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "subagent_type")).firstMatch.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-read-run:")).firstMatch.exists)
        capture(app, "Subagent cards")
        // The report is cut to a screenful; the reader has the rest.
        let full = app.buttons["chat-agent-report:agent-audit"]
        XCTAssertTrue(full.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final audit marker")).firstMatch.exists)
        full.tap()
        XCTAssertTrue(app.buttons["chat-tool-output-done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final audit marker")).firstMatch.exists)
        app.buttons["chat-tool-output-done"].tap()
        // The prompt stays behind a tap.
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Read ChatTimelineModels.swift")).firstMatch.exists)
        app.buttons["chat-agent-prompt:agent-audit"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Read ChatTimelineModels.swift")).firstMatch.waitForExistence(timeout: 3))
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
        XCTAssertTrue(app.buttons["chat-tool-output-done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Final step marker")).firstMatch.exists)
        app.buttons["chat-tool-output-done"].tap()
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
        XCTAssertFalse(app.alerts["Open website?"].exists)
        XCTAssertTrue(app.buttons["chat-close"].exists)
        app.links["Docs"].tap()
        XCTAssertTrue(app.alerts["Open website?"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.alerts.staticTexts["example.com"].exists)
        capture(app, "Confirm a transcript website")
        app.alerts.buttons["Cancel"].tap()
        XCTAssertTrue(app.links["Docs"].exists)
    }

    @MainActor
    func testHeavyTranscriptScrollingPerformance() {
        let app = launch(extra: ["--chat-heavy"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-message:59:0").firstMatch.waitForExistence(timeout: 15))
        let transcript = app.scrollViews["chat-transcript"]
        let options = XCTMeasureOptions(); options.iterationCount = 3
        measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
            for _ in 0..<4 { transcript.swipeDown(velocity: .fast) }
            for _ in 0..<4 { transcript.swipeUp(velocity: .fast) }
        }
        capture(app, "Heavy transcript with fixed-height collapsed tools")
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
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        sleep(1)
        if !row.exists { app.typeKey("[", modifierFlags: .command) }
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
        XCTAssertLessThanOrEqual(runs.firstMatch.frame.height, 54, "A folded run is one pill tall")
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
        XCTAssertTrue(app.alerts["Open website?"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.alerts.staticTexts["example.org"].exists)
        app.alerts.buttons["Open website"].firstMatch.tap()
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
        // A 44pt pill whose tap shape reaches 5pt past its edges (the reported frame is the tap shape).
        XCTAssertLessThanOrEqual(group.frame.height, 54, "The compact tool pill stays one row tall")
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
    func testCustomChatWithLargeTextKeepsActionsReachable() {
        let app = launch(extra: ["--chat-design", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 8))
        for identifier in ["chat-close", "chat-diff", "Chat options", "chat-composer-terminal", "Add attachment", "Dictate message"] {
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
        let header = app.otherElements["herdr-terminal-header"]
        XCTAssertTrue(header.waitForExistence(timeout: 8))
        XCTAssertTrue(header.staticTexts["Test Mac"].waitForExistence(timeout: 8))
        XCTAssertTrue(header.staticTexts["work"].exists)
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
        app.buttons["chat-diff"].tap()
        XCTAssertTrue(app.staticTexts["Theme.swift"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Settings.swift"].exists, "Staged and unstaged files are listed in their own groups")
        XCTAssertTrue(app.staticTexts["Notes.md"].exists, "Untracked files are listed too")
        capture(app, "Repository changes list")
        app.staticTexts["Theme.swift"].tap()
        capture(app, "Native repository diff")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "-let accent = green")).firstMatch.exists)
        XCTAssertFalse(app.buttons["diff-previous-change"].isEnabled, "One change: nothing before it")
        XCTAssertFalse(app.buttons["diff-next-change"].isEnabled, "One change: nothing after it")
        app.buttons["diff-options"].tap()
        app.buttons["Side by side"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "-let accent = green, +let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Side-by-side repository diff")
        app.buttons["diff-options"].tap()
        app.buttons["Inline"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["chat-composer-terminal"].tap()
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
        XCTAssertTrue(app.navigationBars["Conversation image.jpg"].waitForExistence(timeout: 5))
        app.navigationBars["Conversation image.jpg"].buttons["Done"].tap()
        XCTAssertEqual(card.value as? String, "Collapsed")
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
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Command output: /home/alaarab/Projects/hub")).firstMatch.exists)
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
        let read = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "chat-tool-group:", "Read")).firstMatch
        XCTAssertTrue(read.waitForExistence(timeout: 3)); read.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-historical-image"].firstMatch.waitForExistence(timeout: 8))
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
        let wrap = app.buttons["Wrap long lines"]
        XCTAssertTrue(wrap.waitForExistence(timeout: 3)); wrap.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 3))
        app.buttons["diff-options"].tap(); app.buttons["Wrap long lines"].tap()
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
        XCTAssertTrue(app.navigationBars["Repository changes"].waitForExistence(timeout: 5))
        let row = app.buttons["diff-file:unstaged:Theme.swift"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Repository changes from a shell edit, syntax coloured")
        // The same command appended to the phren store, which a hook committed
        // straight away: it appears as its own repository, with the commit.
        app.navigationBars.buttons.firstMatch.tap()
        let store = app.buttons["diff-file:committed:phone/FINDINGS.md"]
        XCTAssertTrue(store.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "phren: capture finding")).firstMatch.exists)
        store.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+- Accent is purple now")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "A hook's commit in another repository, from the same command")
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
    func testStreamingReplyStaysPinnedToTheBottom() {
        let app = launch(extra: ["--chat-streaming", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
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
        XCTAssertTrue(app.textFields["agent-drawer-search"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Finding your agents…"].exists, "The drawer reuses the revealed overview")
        app.segmentedControls["agent-drawer-order"].buttons["Recent"].tap()
        capture(app, "Recent sessions drawer")
        app.segmentedControls["agent-drawer-order"].buttons["List"].tap()
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
        XCTAssertTrue(app.buttons["Copy reply"].exists)
        XCTAssertFalse(app.buttons["Copy message"].exists, "The bubble's menu does not show for a paragraph")
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
    func testRejectedSendKeepsTheMessageQueuedAndAllowsExplicitRetry() {
        let app = launch(extra: ["--chat-send-rejected", "--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep it up")
        // The agent is working: the control queues rather than interrupts.
        XCTAssertTrue(app.buttons["chat-queue"].waitForExistence(timeout: 3))
        app.buttons["chat-queue"].tap()
        let queued = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-remove:")).firstMatch
        XCTAssertTrue(queued.waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Queued · 1"].exists, "Pending bubbles have no queued caption")
        XCTAssertEqual(composer.value as? String, "", "The composer is clear once the message is queued")
        let sendNow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-send:")).firstMatch
        sendNow.tap()
        let error = app.staticTexts["chat-delivery-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(error.label.contains("The selected terminal is unavailable."))
        XCTAssertTrue(queued.exists, "A rejected message stays queued")
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertFalse(app.staticTexts["Received in codex on w7:p1: Keep it up"].exists, "Nothing retries on its own while the agent works")
        XCTAssertTrue(queued.waitForExistence(timeout: 5))
        capture(app, "Rejected message stays queued")
        sendNow.tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Keep it up"].waitForExistence(timeout: 8))
        XCTAssertFalse(queued.exists)
        XCTAssertFalse(error.exists)
    }

    @MainActor
    func testClaudeSteeringAppearsAsAQueuedBubbleAndConsumptionClearsItsTag() {
        let app = launch(extra: ["--chat-working", "--chat-claude-queue"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-stop"].waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Run the queued checks")
        app.buttons["chat-queue"].tap()
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
    func testQueuedMessagesCanBeEditedRemovedAndDeliverWhenTheTurnEnds() {
        let app = launch(extra: ["--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-stop"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("First follow-up")
        app.buttons["chat-queue"].tap()
        // One short steer is one short strip, sitting on the composer — not a
        // 190pt box with the row floating in the middle of it.
        let strip = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ AND elementType != %d", "chat-queue", XCUIElement.ElementType.button.rawValue)).firstMatch
        XCTAssertTrue(strip.waitForExistence(timeout: 3))
        XCTAssertLessThan(strip.frame.height, 90, "One queued row must not stretch to the cap")
        XCTAssertLessThan(composer.frame.minY - strip.frame.maxY, 40, "The queue strip hugs the composer")
        composer.tap(); composer.typeText("Second follow-up")
        app.buttons["chat-queue"].tap()
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-remove:"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 3))
        XCTAssertEqual(rows.count, 2)
        XCTAssertFalse(app.staticTexts["Queued · 2"].exists, "Pending bubbles have no queued caption")
        capture(app, "Two queued messages under the transcript")
        // Edit pulls the message back into the composer.
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-edit:")).element(boundBy: 1).tap()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(composer.value as? String, "Second follow-up")
        composer.tap(); composer.typeText(" (revised)")
        app.buttons["chat-queue"].tap()
        XCTAssertEqual(rows.count, 2)
        // Remove drops one without sending it.
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-remove:")).element(boundBy: 1).tap()
        XCTAssertEqual(rows.count, 1)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Second follow-up")).firstMatch.exists)
        // Stopping the turn frees the agent; the queue delivers itself.
        XCTAssertTrue(app.buttons["chat-stop"].exists, "An empty composer shows Stop while working")
        app.buttons["chat-stop"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: First follow-up"].waitForExistence(timeout: 10))
        XCTAssertEqual(rows.count, 0)
        XCTAssertFalse(app.staticTexts["Queued · 1"].exists)
        capture(app, "Queue delivered after the turn ended")
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
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() // dismiss the menu
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
    func testBlockedAgentCanBeAnsweredInChatOrTerminal() {
        let app = launch(extra: ["--chat-blocked"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["chat-answer-terminal"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep this for later")
        XCTAssertTrue(app.buttons["chat-send"].isEnabled, "A blocked agent can be answered from the composer")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Received in codex")).firstMatch.waitForExistence(timeout: 8))
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
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"] + extra
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        // The first launch of a test run sometimes comes up before the fixture
        // bootstrap finishes (no computers, no memory) and stays that way; a
        // relaunch always lands. Real launches are unaffected.
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
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
        XCTAssertTrue(app.buttons["live-chat:w7:w7:t9"].waitForExistence(timeout: 10))
        return app
    }
    /// Texts showing a brace — tool JSON leaking onto a card. The fixture's
    /// own 1-point report of what was copied is JSON by design.
    @MainActor private func rawJSONTexts(_ app: XCUIApplication) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND identifier != %@", "{", "chat-fixture-copied"))
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}


