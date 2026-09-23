import XCTest

/// Tool cards: phren, web, skills, MCP servers, todos, folded reads and shell runs, long output and patches.
final class AgentChatToolCardTests: AgentChatUITestCase {
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
        // The transcript runs under the header: bring the card's top out from behind it.
        let headerBottom = app.staticTexts["chat-location"].frame.maxY + 20
        for _ in 0..<12 where card.frame.minY < headerBottom { transcript.swipeDown() }
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
        // Folded, each call is one quiet line; tapping opens it in place.
        for card in [pull, panes, merge] { XCTAssertLessThanOrEqual(card.frame.height, 44.5, card.label) }
        XCTAssertEqual(pull.value as? String, "Collapsed")
        capture(app, "Cards for other MCP servers")
        pull.tap()
        XCTAssertEqual(pull.value as? String, "Expanded")
        let open = app.buttons["chat-mcp-open:mcp-pr"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        capture(app, "MCP call expanded in place")
        for _ in 0..<4 where !open.isHittable { transcript.swipeUp() }
        open.tap()
        XCTAssertTrue(app.buttons["chat-tool-output-wrap"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "pull_number")).firstMatch.exists)
        app.navigationBars.buttons.firstMatch.tap()
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
        // The options sheet's Changes screen covers the whole tree, plus every
        // place the session's commands wrote to.
        openRepositoryChanges(in: app)
        // The Changes screen covers the pane's whole tree: the
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

    @MainActor
    func testNarrationFoldsToALineAndSameToolCallsFoldWithTheirFailure() {
        let app = launch(extra: ["--chat-narration"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let note = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-narration:")).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 8))
        XCTAssertTrue(note.label.hasPrefix("Thinking: I'll build first"), note.label)
        XCTAssertEqual(note.value as? String, "Collapsed")
        let foldedHeight = note.frame.height
        XCTAssertLessThanOrEqual(foldedHeight, 30, "A narration note folds to one line")
        // Two shell calls in a row are one pill; the failure shows at its end.
        let pill = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "chat-read-run:", "Shell ×2")).firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 5))
        XCTAssertTrue(pill.label.hasSuffix("Failed"), pill.label)
        XCTAssertLessThanOrEqual(pill.frame.height, 44.5, "One line while folded")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:")).firstMatch.exists)
        // The reply stays ordinary text.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "The offset test fails")).firstMatch.exists)
        capture(app, "Narration and a folded shell pill with a failure")
        note.tap()
        XCTAssertEqual(note.value as? String, "Expanded")
        XCTAssertGreaterThan(note.frame.height, foldedHeight + 8, "The whole note opens in place")
        pill.tap()
        XCTAssertEqual(pill.value as? String, "Expanded")
        let calls = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-group:"))
        XCTAssertTrue(calls.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(calls.count, 2)
        XCTAssertTrue(calls.element(boundBy: 1).label.hasSuffix("Failed"), calls.element(boundBy: 1).label)
        // Each call is a one-line pill that opens to its full input and output.
        let failed = calls.element(boundBy: 1)
        XCTAssertLessThanOrEqual(failed.frame.height, 44.5)
        failed.tap()
        XCTAssertEqual(failed.value as? String, "Expanded")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-input:")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Narration and shell calls expanded")
        failed.tap()
        XCTAssertEqual(failed.value as? String, "Collapsed")
        note.tap()
        XCTAssertEqual(note.value as? String, "Collapsed")
    }
}
