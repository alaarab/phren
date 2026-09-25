import XCTest

/// The row at the end of a finished turn that changed files, and the turn's
/// combined diff behind it.
final class AgentChatTurnChangesTests: AgentChatUITestCase {
    @MainActor
    func testCodexTurnEndsWithItsDiffRowAndOpensEachFile() {
        checkTurnChanges(flag: "--chat-turn-changes", name: "Codex")
    }

    @MainActor
    private func checkTurnChanges(flag: String, name: String) {
        let app = launch(extra: [flag])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-turn-changes:"))
        let row = rows.firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        XCTAssertEqual(rows.count, 1, "Only the turn that changed files has a row")
        for _ in 0..<6 where !row.isHittable { transcript.swipeUp() }
        XCTAssertEqual(row.label, "3 files changed, 6 added, 3 removed")
        XCTAssertEqual(row.frame.height, 44, accuracy: 1, "One quiet pill tall")
        capture(app, "\(name) turn diff row")
        row.tap()
        XCTAssertTrue(app.otherElements["chat-turn-diff-summary"].waitForExistence(timeout: 5)
                      || app.staticTexts["chat-turn-diff-summary"].exists)
        for path in ["Sources/Button.swift", "Sources/Theme.swift", "Docs/Colors.md"] {
            XCTAssertTrue(app.buttons["chat-patch-file:" + path].waitForExistence(timeout: 5), path)
        }
        capture(app, "\(name) turn combined diff")
        app.buttons.matching(identifier: "chat-patch-open").firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["diff-editor"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["Button.swift"].exists)
        capture(app, "\(name) turn file diff")
    }
}
