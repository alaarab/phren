import XCTest

/// Talk mode in an agent chat, with a scripted recogniser and voice in place
/// of the microphone and speaker: listen, send, speak, barge in, listen.
final class TalkModeTests: AgentChatUITestCase {
    @MainActor
    func testListenSendSpeakBargeInAndListenAgain() {
        let app = launch(extra: ["--talk-fixture", "--chat-clear-drafts"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 8))
        app.buttons["chat-talk"].tap()

        let status = app.staticTexts["talk-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        let log = app.descendants(matching: .any)["talk-fixture-log"]
        var seen: [String] = []
        func record() { if seen.last != status.label, status.exists { seen.append(status.label) } }
        func waitForLog(_ fragment: String, timeout: TimeInterval) -> Bool {
            let deadline = Date.now.addingTimeInterval(timeout)
            while Date.now < deadline {
                record()
                if log.exists, log.label.contains(fragment) { return true }
                usleep(100_000)
            }
            return false
        }

        XCTAssertTrue(waitForLog("sent: What changed in atlas today", timeout: 12), log.label)
        XCTAssertTrue(waitForLog("speaking: Two commits landed in atlas today. Both fix the parser.", timeout: 12), log.label)
        capture(app, "Talk mode speaking")
        XCTAssertTrue(waitForLog("interrupted", timeout: 8), log.label)
        XCTAssertTrue(waitForLog("sent: wait stop and run the tests", timeout: 12), log.label)
        XCTAssertTrue(waitForLog("spoke", timeout: 16), log.label)
        let listening = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Listening'"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [listening], timeout: 5), .completed)
        record()

        // The code block was never read aloud; both replies are in the chat.
        XCTAssertFalse(log.label.contains("let parser"))
        XCTAssertEqual(log.label.components(separatedBy: " | "), [
            "sent: What changed in atlas today",
            "speaking: Two commits landed in atlas today. Both fix the parser.",
            "interrupted",
            "sent: wait stop and run the tests",
            "speaking: Running the tests now. I'll tell you when they finish.",
            "spoke",
        ])
        // Each pause shows its countdown before the send.
        let countdown = "Sending when you pause · tap to hold", speaking = "Speaking · talk to interrupt"
        XCTAssertEqual(seen, ["Listening", countdown, "Thinking", speaking, "Listening", countdown, "Thinking", speaking, "Listening"])

        app.buttons["talk-stop"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["talk-bar"].waitForNonExistence(timeout: 5))
    }
}
