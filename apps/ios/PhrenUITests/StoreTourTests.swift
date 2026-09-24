import XCTest

/// The App Store tour: one screen per test, captured as an attachment named
/// for its place in the listing, and two slower walks for the app previews.
/// Every launch carries `--store-tour-fixture`, which names the computers and
/// projects the way a real store does; nothing here asserts behaviour that
/// the feature tests do not already cover.
final class StoreTourTests: XCTestCase {
    private let mac = "A1000000-0000-0000-0000-000000000001"
    private let linux = "A1000000-0000-0000-0000-000000000002"

    override func setUpWithError() throws { try skipUnlessToursRequested() }

    // MARK: Screens

    @MainActor
    func testSessionsAcrossComputers() {
        let app = launch(extra: ["--all-sessions-fixture", "--account-usage-fixture"])
        XCTAssertTrue(overviewRow(app, host: mac).waitForExistence(timeout: 15))
        XCTAssertTrue(overviewRow(app, host: linux).waitForExistence(timeout: 10))
        let rings = app.buttons["all-account-usage"]
        expectation(for: NSPredicate(format: "value CONTAINS %@", "%"), evaluatedWith: rings)
        waitForExpectations(timeout: 10)
        settle(1.5)
        capture(app, "01 Sessions")
    }

    @MainActor
    func testChatWithToolCardsAndDiff() {
        let app = launch(extra: ["--chat-diffs"])
        openChat(app)
        // The shell command's change row (the patch card has one too).
        let theme = app.buttons.matching(identifier: "chat-patch-file:Theme.swift")
        XCTAssertTrue(theme.firstMatch.waitForExistence(timeout: 10))
        theme.allElementsBoundByIndex.last?.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        settle(1)
        capture(app, "02 Chat with diff")
    }

    @MainActor
    func testPhrenMemoryCards() {
        let app = launch(extra: ["--chat-phren-tools"])
        openChat(app)
        XCTAssertTrue(app.buttons["chat-phren-card:phren-search"].waitForExistence(timeout: 10))
        settle(1)
        capture(app, "03 Memory cards")
    }

    @MainActor
    func testInlineApproval() {
        let app = launch(extra: ["--chat-design", "--chat-approval"])
        openChat(app)
        XCTAssertTrue(app.buttons["Approve"].waitForExistence(timeout: 10))
        settle(1)
        capture(app, "04 Approval")
    }

    @MainActor
    func testClaudeQuestionCard() {
        let app = launch(extra: ["--chat-approval-question"])
        openChat(app)
        XCTAssertTrue(app.staticTexts["Design: Which accent should the project use?"].waitForExistence(timeout: 10))
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "A softer accent")).firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "The conversation")).firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "The overview")).firstMatch.tap()
        // Tapping scrolled the card's question list; back to its top.
        let list = app.scrollViews.containing(NSPredicate(format: "label == %@", "Scope: Which screens should change?")).firstMatch
        list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            .press(forDuration: 0.1, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        settle(2.5)
        capture(app, "05 Question")
    }

    @MainActor
    func testSubagentCards() {
        let app = launch(extra: ["--chat-agent-card"])
        openChat(app)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-agent-card:agent-tests").firstMatch.waitForExistence(timeout: 10))
        settle(1)
        capture(app, "06 Subagents")
    }

    @MainActor
    func testTodoCards() {
        let app = launch(extra: ["--chat-todos"])
        openChat(app)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-todo-card:todo-2").firstMatch.waitForExistence(timeout: 10))
        settle(1)
        capture(app, "06b Todos")
    }

    @MainActor
    func testPicturesUnderARead() {
        let app = launch(extra: ["--chat-read-images"])
        openChat(app)
        let pictures = app.buttons.matching(NSPredicate(format: "label == %@", "View conversation image"))
        XCTAssertTrue(pictures.firstMatch.waitForExistence(timeout: 10))
        settle(1)
        // Show the Read pill above its frames.
        drag(app, from: 0.3, to: 0.42)
        settle(1)
        capture(app, "07 Pictures")
    }

    @MainActor
    func testTerminalWithToolbar() {
        let app = launch(extra: ["--chat-todos", "--terminal-tour-fixture"])
        openChat(app)
        let terminal = app.buttons["chat-composer-terminal"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: terminal)
        waitForExpectations(timeout: 8)
        terminal.tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["terminal-fixture-report"].waitForExistence(timeout: 8))
        settle(1.5)
        capture(app, "08 Terminal")
    }

    @MainActor
    func testProjectsFindingsAndGraph() {
        let app = launch(extra: [])
        app.tabBars.buttons["Projects"].tap()
        let project = app.buttons["project:sample/brain:phren"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        settle(1)
        capture(app, "09 Projects")
        project.tap()
        XCTAssertTrue(app.buttons["project-skills"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "XCUITest")).firstMatch.waitForExistence(timeout: 10))
        settle(1)
        capture(app, "10 Findings")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        openMemoryGraph(from: app)
        XCTAssertTrue(graphProjectLabel("PHREN", in: app.webViews).waitForExistence(timeout: 25))
        settle(5)
        capture(app, "11 Graph")
    }

    @MainActor
    func testAccountUsage() {
        let app = launch(extra: ["--all-sessions-fixture", "--account-usage-fixture"])
        let usage = app.buttons["all-account-usage"]
        XCTAssertTrue(usage.waitForExistence(timeout: 15))
        usage.tap()
        XCTAssertTrue(app.staticTexts["Claude"].waitForExistence(timeout: 10))
        settle(1)
        capture(app, "12 Usage")
    }

    // MARK: Previews (recorded from the simulator while these run)

    @MainActor
    func testPreviewSessionsChatApprove() {
        let app = launch(extra: ["--all-sessions-fixture", "--account-usage-fixture", "--chat-design", "--chat-approval"])
        let working = overviewRow(app, host: mac), waiting = overviewRow(app, host: linux)
        XCTAssertTrue(working.waitForExistence(timeout: 15)); XCTAssertTrue(waiting.waitForExistence(timeout: 10))
        settle(3)
        waiting.tap()
        XCTAssertTrue(app.buttons["Approve"].waitForExistence(timeout: 10))
        settle(3)
        app.buttons["Approve"].tap()
        XCTAssertTrue(app.staticTexts["Answer received in this conversation."].waitForExistence(timeout: 10))
        settle(2.5)
        app.buttons["chat-close"].tap()
        XCTAssertTrue(working.waitForExistence(timeout: 10))
        settle(1.5)
        working.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch.waitForExistence(timeout: 10))
        settle(3)
    }

    @MainActor
    func testPreviewMemoryGraphCapture() {
        let app = launch(extra: ["--chat-phren-tools"])
        app.tabBars.buttons["Projects"].tap()
        let project = app.buttons["project:sample/brain:phren"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        settle(2.5)
        project.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "XCUITest")).firstMatch.waitForExistence(timeout: 10))
        settle(3)
        app.swipeUp(velocity: .slow)
        settle(2)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        settle(1)
        openMemoryGraph(from: app)
        XCTAssertTrue(graphProjectLabel("PHREN", in: app.webViews).waitForExistence(timeout: 25))
        settle(6)
        app.tabBars.buttons["Projects"].tap()
        XCTAssertTrue(app.navigationBars["Projects"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Agents"].tap()
        openChat(app)
        XCTAssertTrue(app.buttons["chat-phren-card:phren-search"].waitForExistence(timeout: 10))
        settle(3)
        app.scrollViews["chat-transcript"].swipeDown(velocity: .slow)
        settle(3)
    }

    @MainActor
    func testPreviewPicturesAndTerminal() {
        let app = launch(extra: ["--chat-read-images", "--terminal-tour-fixture"])
        openChat(app)
        let pictures = app.buttons.matching(NSPredicate(format: "label == %@", "View conversation image"))
        XCTAssertTrue(pictures.firstMatch.waitForExistence(timeout: 10))
        settle(1.5)
        drag(app, from: 0.3, to: 0.42)
        settle(2.5)
        pictures.firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch.waitForExistence(timeout: 5))
        settle(2.5)
        app.buttons["file-viewer-close"].tap()
        settle(1.5)
        let terminal = app.buttons["chat-composer-terminal"]
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: terminal)
        waitForExpectations(timeout: 8)
        terminal.tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["terminal-fixture-report"].waitForExistence(timeout: 8))
        settle(3.5)
        app.buttons["Toggle terminal keyboard"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        settle(3)
        app.buttons["Toggle terminal keyboard"].tap()
        settle(1.5)
        let chat = app.buttons.matching(NSPredicate(format: "identifier == %@", "terminal-control:chat")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 5))
        chat.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch.waitForExistence(timeout: 8))
        settle(3)
    }

    // MARK: Helpers

    @MainActor
    private func launch(extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture",
                               "--store-tour-fixture", "--session-pins-reset"] + extra
        // The first launch of a run sometimes comes up before the fixture
        // bootstrap finishes (no computers, no memory); a relaunch always lands.
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
            app.tabBars.buttons["Agents"].tap()
            let revealed = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "live-host:")).firstMatch
            if revealed.waitForExistence(timeout: attempt == 0 ? 12 : 25) { break }
            if attempt == 0 { app.terminate() }
        }
        return app
    }

    /// The Claude session on the Mac mini, from the computer's own page.
    @MainActor
    private func openChat(_ app: XCUIApplication) {
        let host = app.buttons["live-host:\(mac)"]
        for _ in 0..<14 where !(host.exists && host.isHittable) { app.swipeUp() }
        XCTAssertTrue(host.waitForExistence(timeout: 5))
        host.tap()
        let row = app.buttons["live-chat:w7:w7:t9"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func overviewRow(_ app: XCUIApplication, host: String, tab: String = "w1:t1") -> XCUIElement {
        app.buttons["overview-chat:\(host):herdr:default:w1:\(tab)"]
    }

    /// A controlled scroll of the transcript: press near the middle and drag
    /// down the screen by a fraction of its height.
    @MainActor
    private func drag(_ app: XCUIApplication, from: Double, to: Double) {
        let transcript = app.scrollViews["chat-transcript"]
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
            .press(forDuration: 0.1, thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to)))
    }

    /// A deliberate pause: the previews are recorded in real time.
    private func settle(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}
