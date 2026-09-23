import XCTest

/// Workers edit in their own worktrees, which the pane's diff never shows.
/// The Changes screen lists them under Workers and opens each bound to its
/// worktree; the agent tree opens a worker's changes directly; and the working
/// tree can show git-ignored folders on request.
final class ChangesWorkersTests: AgentChatUITestCase {
    private let parser = "changes-worktree:0123456789abcdef0123456789abcdef"

    @MainActor
    func testWorkersSectionListsWorktreesAndOpensOneBoundToIt() {
        let app = launch(extra: ["--chat-diffs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        openRepositoryChanges(in: app)
        let workers = app.buttons["changes-tab-workers"]
        XCTAssertTrue(workers.waitForExistence(timeout: 10), "The pane's own Changes offers its workers")
        workers.tap()
        let row = app.buttons[parser]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        XCTAssertTrue(row.label.contains("Fix the parser"), row.label)
        XCTAssertTrue(row.label.contains("3 files"), row.label)
        XCTAssertTrue(app.buttons["changes-worktree:fedcba9876543210fedcba9876543210"].exists, "A fan-out worktree is named by its task")
        XCTAssertTrue(app.buttons["changes-worktree:00112233445566778899aabbccddeeff"].exists, "An unclaimed worktree still lists")
        XCTAssertTrue(app.descendants(matching: .any)["changes-workers-section:other"].exists)
        XCTAssertGreaterThanOrEqual(row.frame.height, 44)
        capture(app, "Workers section")
        row.tap()
        let title = app.staticTexts["changes-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        XCTAssertEqual(title.label, "Fix the parser")
        app.buttons["changes-mode-list"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes-file:Sources/Parser.swift"].waitForExistence(timeout: 8),
                      "The worker's own edits, not the pane's")
        XCTAssertFalse(app.descendants(matching: .any)["changes-file:Sources/App.swift"].exists)
        XCTAssertFalse(app.buttons["changes-tab-workers"].exists, "A worker's view does not list workers again")
        capture(app, "Worker changes")
        app.buttons["changes-tab-history"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes-history"].waitForExistence(timeout: 8)
                      || app.staticTexts["Wire the checkout flow to the new ledger"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testAgentTreeWorkerWithAWorktreeOpensItsChanges() {
        let app = launch(extra: ["--chat-agent-card", "--chat-worker-worktree"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let tree = app.buttons["chat-agent-tree"]
        XCTAssertTrue(tree.waitForExistence(timeout: 8)); tree.tap()
        let changes = app.buttons["child-agent-changes:b" + String(repeating: "2", count: 31)]
        XCTAssertTrue(changes.waitForExistence(timeout: 5), "A worker in its own worktree offers Changes on its row")
        XCTAssertGreaterThanOrEqual(changes.frame.width, 44)
        capture(app, "Agent tree worker Changes")
        changes.tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes-header"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["changes-tab-workers"].exists)
    }

    @MainActor
    func testShowIgnoredListsIgnoredFoldersDimmedAndOpensTheirFiles() {
        let app = launch(extra: ["--chat-diffs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        openRepositoryChanges(in: app)
        let treeTab = app.buttons["changes-tab-tree"]
        XCTAssertTrue(treeTab.waitForExistence(timeout: 10)); treeTab.tap()
        let toggle = app.descendants(matching: .any)["changes-tree-switch:ignored"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 8))
        if toggle.value as? String == "On" { toggle.tap() }
        XCTAssertTrue(app.buttons["changes-tree-entry:Sources"].waitForExistence(timeout: 8))
        let video = app.buttons["changes-tree-entry:video"]
        XCTAssertFalse(video.exists, "Ignored folders stay hidden by default")
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "On")
        XCTAssertTrue(video.waitForExistence(timeout: 8))
        XCTAssertEqual(video.value as? String, "Ignored")
        XCTAssertTrue(app.buttons["changes-tree-entry:debug.log"].exists)
        XCTAssertNotEqual(app.buttons["changes-tree-entry:Sources"].value as? String, "Ignored")
        video.tap()
        let clip = app.buttons["changes-tree-entry:video/intro.mp4"]
        XCTAssertTrue(clip.waitForExistence(timeout: 8), "An ignored folder opens like any other")
        capture(app, "Working tree showing ignored")
        app.buttons["changes-tab-history"].tap(); treeTab.tap()
        XCTAssertEqual(app.descendants(matching: .any)["changes-tree-switch:ignored"].value as? String, "On", "The choice is remembered")
        XCTAssertTrue(clip.waitForExistence(timeout: 8))
        clip.tap()
        XCTAssertTrue(app.buttons["file-viewer-close"].waitForExistence(timeout: 10), "An ignored file opens in the viewer")
        capture(app, "Ignored file in the viewer")
        app.buttons["file-viewer-close"].tap()
        let off = app.descendants(matching: .any)["changes-tree-switch:ignored"]
        if off.waitForExistence(timeout: 5), off.value as? String == "On" { off.tap() }
    }
}
