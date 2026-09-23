import XCTest

extension XCTestCase {
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

    @MainActor
    func openSessionsAction(_ action: String, in app: XCUIApplication) {
        let more = app.buttons["sessions-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        more.tap()
        let item = app.buttons["sessions-more-sheet:\(action)"]
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.tap()
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
