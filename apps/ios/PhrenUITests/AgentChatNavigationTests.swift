import XCTest

/// Opening, leaving and moving around the chat: panes, terminals, options, Changes, sessions.
final class AgentChatNavigationTests: AgentChatUITestCase {
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
        for _ in 0..<2 where !row.waitForExistence(timeout: 1) {
            app.typeKey("[", modifierFlags: .command)
        }
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Escape or ⌘[ should go back")
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

    /// The source-control sheet: the branch stat line from /v1/git/status, the
    /// five segment tabs, the GitHub pull list, and a working-tree folder that
    /// expands to its changed file. One launch covers both tabs' assertions.
    @MainActor
    func testChangesScreenTabsPullRequestsAndWorkingTree() {
        let app = launch(extra: ["--chat-diffs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 8))
        openRepositoryChanges(in: app)
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
        // A session offers only native chat and terminal actions.
        XCTAssertTrue(app.buttons["Project memory"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Open in Moshi"].exists)
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
}
