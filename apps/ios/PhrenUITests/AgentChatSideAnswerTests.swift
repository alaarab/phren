import XCTest

/// Claude's `/btw` side question: suggested, sent while the turn works, and
/// answered on a dismissible card that stays out of the conversation.
final class AgentChatSideAnswerTests: AgentChatUITestCase {
    @MainActor
    func testSideQuestionWhileWorkingShowsADismissibleSideCard() {
        let app = launch(extra: ["--chat-side-answer", "--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/b")
        let suggestion = app.buttons["chat-command:/btw"]
        XCTAssertTrue(suggestion.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ask a side question while it works"].exists)
        suggestion.tap()
        composer.typeText("what is 2+2")
        // The agent is working, yet the question goes now: Send, not the queue.
        let send = app.buttons["chat-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        let card = app.descendants(matching: .any).matching(identifier: "chat-side-answer").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 6))
        XCTAssertTrue(app.staticTexts["Not part of the conversation"].exists)
        XCTAssertEqual(app.staticTexts["chat-side-answer-question"].label, "what is 2+2")
        let copy = app.buttons["chat-side-answer-copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 6), "The answer arrives on the card")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ AND identifier != %@", "2 + 2 = 4.", "chat-fixture-copied")).firstMatch.exists)
        XCTAssertFalse(app.buttons["chat-queue"].exists)
        // Sending a side question does not hand off to the terminal.
        XCTAssertTrue(composer.exists)
        capture(app, "side-answer-card")
        copy.tap()
        let report = app.staticTexts["chat-fixture-copied"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "2 + 2 = 4."), object: report)], timeout: 5), .completed)
        app.buttons["chat-side-answer-dismiss"].tap()
        XCTAssertTrue(card.waitForNonExistence(timeout: 5))
    }
}
