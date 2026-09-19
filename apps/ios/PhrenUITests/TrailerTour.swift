import XCTest

/// The product video's phone takes, recorded from the simulator while these
/// run (`xcrun simctl io <udid> recordVideo`). One test per launch-argument
/// set, in the order the film uses them; every pause is real time and every
/// gesture is slow enough to read. Nothing here asserts behaviour the feature
/// tests do not already cover — a wait that fails only ends the take.
final class TrailerTour: XCTestCase {
    private let studio = "A1000000-0000-0000-0000-000000000001"
    private let laptop = "A1000000-0000-0000-0000-000000000002"

    override func setUp() { continueAfterFailure = true }

    // MARK: Beats 4 and 5 — Agents tab, then read the chat and queue what's next

    @MainActor
    func testTour1AgentsAndChat() {
        let app = launch(extra: ["--chat-phren-tools", "--chat-claude-queue", "--chat-working"])
        let working = overviewRow(app, host: studio)
        XCTAssertTrue(working.waitForExistence(timeout: 15))
        XCTAssertTrue(overviewRow(app, host: laptop).waitForExistence(timeout: 10))
        settle(4)
        // A slow 40-point swipe up the list, and back.
        let list = app.collectionViews.firstMatch.exists ? app.collectionViews.firstMatch : app
        let from = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62))
        let to = from.withOffset(CGVector(dx: 0, dy: -40))
        from.press(forDuration: 0.2, thenDragTo: to, withVelocity: XCUIGestureVelocity(rawValue: 60), thenHoldForDuration: 0.4)
        settle(1)
        to.press(forDuration: 0.2, thenDragTo: from, withVelocity: XCUIGestureVelocity(rawValue: 60), thenHoldForDuration: 0.4)
        settle(2.5)

        working.tap()
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        let card = app.buttons["chat-phren-card:phren-finding"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        settle(2)
        // Up a screen, slowly — what it did — then back down to what it kept.
        drag(transcript, from: 0.25, to: 0.85, velocity: 260)
        settle(1.2)
        drag(transcript, from: 0.85, to: 0.2, velocity: 260)
        settle(0.5)
        app.buttons["Latest messages"].tapIfPresent()
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        settle(3)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        settle(0.8)
        for word in ["run ", "the ", "tests ", "after"] {
            composer.typeText(word)
            settle(0.25)
        }
        settle(1)
        let queue = app.buttons["chat-queue"]
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        queue.tap()
        // Claude owns the queued instruction: a muted bubble under the reply.
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-queued-tag:")).firstMatch.waitForExistence(timeout: 8))
        // Queueing puts the keyboard away; the muted row sits on the composer.
        settle(4)
    }

    // MARK: Beat 6 — a permission, answered from the Lock Screen

    @MainActor
    func testTour2Approve() {
        let app = launch(extra: ["--chat-approval", "--approval-live-activity"])
        let working = overviewRow(app, host: studio)
        XCTAssertTrue(working.waitForExistence(timeout: 15))
        settle(1)
        working.tap()
        XCTAssertTrue(app.buttons["chat-approval-deny"].waitForExistence(timeout: 10))
        settle(2.5)
        XCUIDevice.shared.press(.home)
        settle(1.5)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.025)).press(forDuration: 1.5)
        let approve = springboard.buttons["Approve"]
        XCTAssertTrue(approve.waitForExistence(timeout: 10))
        settle(2)
        approve.tap()
        settle(1.2)
        app.activate()
        let sent = app.alerts["Permission request"]
        if sent.waitForExistence(timeout: 8) {
            settle(1.5)
            sent.buttons["OK"].tap()
        }
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Answer received")).firstMatch.waitForExistence(timeout: 10))
        settle(3.5)
    }

    // MARK: Beats 7 and 8 — the memory graph, then the Projects list

    @MainActor
    func testTour3GraphAndProjects() {
        let app = launch(extra: ["--graph-reveal", "Idempotency keys", "--graph-reveal-after", "10"])
        app.tabBars.buttons["Projects"].tap()
        XCTAssertTrue(app.buttons["project:alaarab/memory:ledger"].waitForExistence(timeout: 10))
        settle(3.5)
        let graph = app.buttons["Memory graph"]
        XCTAssertTrue(graph.waitForExistence(timeout: 10))
        graph.tap()
        // The graph has content once a project label is in the page.
        XCTAssertTrue(app.webViews.staticTexts["LEDGER"].firstMatch.waitForExistence(timeout: 25))
        let canvas = app.webViews.firstMatch
        settle(2.5)
        drag(canvas, from: 0.3, to: 0.7, velocity: 260, horizontal: true)
        settle(1.2)
        canvas.pinch(withScale: 1.3, velocity: 0.5)
        // By now the rig has flown the camera to the finding; it sits at the
        // centre of the canvas. Tap it.
        settle(5)
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let finding = app.navigationBars["Finding"]
        XCTAssertTrue(finding.waitForExistence(timeout: 10))
        settle(4.5)
        // Pull the sheet down by its bar; a swipe on the canvas would only
        // turn the graph.
        finding.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.15, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)),
                   withVelocity: XCUIGestureVelocity(rawValue: 900), thenHoldForDuration: 0.1)
        _ = finding.waitForNonExistence(timeout: 5)
        settle(1)
        app.buttons["graph-back"].tap()
        XCTAssertTrue(app.navigationBars["Projects"].waitForExistence(timeout: 5))
        settle(3.5)
    }

    // MARK: Helpers

    @MainActor
    private func launch(extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--trailer-fixture", "--automatic-sessions-fixture", "--session-details-fixture",
                               "--native-chat-fixture", "--all-sessions-fixture", "--account-usage-fixture", "--session-pins-reset"] + extra
        // The first launch of a run sometimes comes up before the fixture
        // bootstrap finishes (no computers, no memory); a relaunch always lands.
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
            app.tabBars.buttons["Agents"].tap()
            let revealed = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "live-host:")).firstMatch
            if revealed.waitForExistence(timeout: attempt == 0 ? 12 : 25) { break }
            if attempt == 0 { app.terminate() }
        }
        return app
    }

    @MainActor
    private func overviewRow(_ app: XCUIApplication, host: String, tab: String = "w1:t1") -> XCUIElement {
        app.buttons["overview-chat:\(host):herdr:default:w1:\(tab)"]
    }

    /// A finger-speed drag across an element, by fractions of its height (or
    /// width), at a velocity in points per second.
    @MainActor
    private func drag(_ element: XCUIElement, from: Double, to: Double, velocity: Double, horizontal: Bool = false) {
        let start = element.coordinate(withNormalizedOffset: horizontal ? CGVector(dx: from, dy: 0.55) : CGVector(dx: 0.5, dy: from))
        let end = element.coordinate(withNormalizedOffset: horizontal ? CGVector(dx: to, dy: 0.55) : CGVector(dx: 0.5, dy: to))
        start.press(forDuration: 0.15, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: velocity), thenHoldForDuration: 0.3)
    }

    /// A deliberate pause: the takes are recorded in real time.
    private func settle(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}

private extension XCUIElement {
    /// Tap a control that may or may not be on screen — the chat's "latest"
    /// button after a scroll that did not quite reach the end.
    func tapIfPresent() { if exists && isHittable { tap() } }
}
