import XCTest

extension XCTestCase {
    /// The App Store and trailer tours only produce screenshots and takes, so
    /// they run only when asked (`PHREN_RUN_TOURS=1`, passed to xcodebuild as
    /// `TEST_RUNNER_PHREN_RUN_TOURS=1`) and are skipped in an ordinary run.
    func skipUnlessToursRequested() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PHREN_RUN_TOURS"] == "1",
                          "Set PHREN_RUN_TOURS=1 to run the store and trailer tours.")
    }

    /// Attach a screenshot only when a design run asked for shots
    /// (`PHREN_UI_SHOTS=1`) or once this test has already failed, so an
    /// ordinary suite run does not pay for a capture at every step. Each test
    /// class keeps its own `capture(_:_:)` signature and delegates here.
    func attachUIScreenshot(_ app: XCUIApplication, _ name: String) {
        let wanted = ProcessInfo.processInfo.environment["PHREN_UI_SHOTS"] == "1"
        let failed = testRun?.hasSucceeded == false
        guard wanted || failed else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Memory owns the graph. Select its map even if a previous visit used
    /// the list, so callers exercise the same entry point as the tab bar.
    @MainActor
    func openMemoryGraph(from app: XCUIApplication) {
        let memory = app.tabBars.buttons["Memory"]
        XCTAssertTrue(memory.waitForExistence(timeout: 8))
        memory.tap()
        let map = app.buttons["memory-mode:map"]
        XCTAssertTrue(map.waitForExistence(timeout: 8))
        map.tap()
    }

    /// A project's always-on label in the web graph, which proves the graph
    /// rendered the store. The label draws the name and the finding count as
    /// separate text runs: iOS 26's WebKit exposes them as two static texts
    /// ("DEMO", "3"), iOS 27's merges them into one ("DEMO3"). Match the
    /// name with or without the trailing count so both read the same.
    func graphProjectLabel(_ name: String, in scope: some XCUIElementTypeQueryProvider) -> XCUIElement {
        let pattern = NSRegularExpression.escapedPattern(for: name) + "[0-9]*"
        return scope.staticTexts.matching(NSPredicate(format: "label MATCHES %@", pattern)).firstMatch
    }

    /// The Sessions screen's former ••• items, where they live now: Schedules
    /// and Connect memory in its top bar, refresh as a pull, and Skills,
    /// Agent instructions and Add computer under Settings → Agents.
    @MainActor
    func openSessionsAction(_ action: String, in app: XCUIApplication) {
        switch action {
        case "schedules", "connectMemory":
            let button = app.buttons[action == "schedules" ? "sessions-schedules" : "sessions-connect-memory"]
            XCTAssertTrue(button.waitForExistence(timeout: 5)); button.tap()
        case "refresh":
            let list = app.scrollViews.firstMatch.exists ? app.scrollViews.firstMatch : app.collectionViews.firstMatch
            XCTAssertTrue(list.waitForExistence(timeout: 5))
            list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
                .press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
        default:
            app.tabBars.buttons["Settings"].tap()
            let id = ["skills": "settings-skills", "instructions": "settings-agent-instructions", "add-computer": "settings-add-computer"][action] ?? action
            let row = app.buttons[id]
            for _ in 0..<8 where !(row.exists && row.isHittable) { app.swipeUp() }
            XCTAssertTrue(row.waitForExistence(timeout: 5), "Settings → Agents offers \(action)")
            row.tap()
        }
    }

    /// Repository changes live in the chat's options sheet, not its header.
    @MainActor
    func openRepositoryChanges(in app: XCUIApplication) {
        let options = app.buttons["chat-options"]
        XCTAssertTrue(options.waitForExistence(timeout: 8))
        options.tap()
        let changes = app.buttons["chat-diff"]
        XCTAssertTrue(changes.waitForExistence(timeout: 10))
        changes.tap()
    }

    @MainActor
    func waitForWorkflowStore(in app: XCUIApplication) {
        let projects = app.tabBars.buttons["Projects"]
        XCTAssertTrue(projects.waitForExistence(timeout: 8))
        projects.tap()
        XCTAssertTrue(app.buttons["project:sample/brain:demo"].waitForExistence(timeout: 15),
                      "The workflow store must finish bootstrapping before testing Tasks")
    }

    @MainActor
    func chooseTaskStatus(_ status: String, in app: XCUIApplication) {
        let picker = app.descendants(matching: .any).matching(identifier: "tasks-status").firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.tap()
        let option = app.buttons["tasks-status:\(status)"]
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        option.tap()
        XCTAssertTrue(option.waitForNonExistence(timeout: 5))
    }
}
