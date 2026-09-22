import XCTest

final class ConductorTests: XCTestCase {
    @MainActor
    func testLaunchesPinnedConductorCardAndOpensMarkedChat() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture",
                               "--native-chat-fixture", "--chat-history-stalled", "--conductor-fixture"]
        app.launch()

        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let existing = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"]
        XCTAssertTrue(existing.waitForExistence(timeout: 10)); existing.tap()
        let newThread = app.buttons["New thread"]
        XCTAssertTrue(newThread.waitForExistence(timeout: 8)); newThread.tap()

        let role = app.buttons["launch-role"]
        for _ in 0..<4 where !role.isHittable { app.swipeUp() }
        XCTAssertTrue(role.waitForExistence(timeout: 5)); role.tap()
        let conductor = app.buttons["launch-role:conductor"]
        XCTAssertTrue(conductor.waitForExistence(timeout: 5)); conductor.tap()
        let codex = app.buttons["launch-harness:codex"]
        for _ in 0..<5 where !codex.isHittable { app.swipeUp() }
        XCTAssertTrue(codex.waitForExistence(timeout: 5)); codex.tap()
        for _ in 0..<6 where !app.buttons["launch-effort"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.buttons["launch-effort"].waitForExistence(timeout: 5))
        attachUIScreenshot(app, "Launch conductor role and effort")
        let open = app.buttons["launch-open"]
        for _ in 0..<4 where !open.isHittable { app.swipeUp() }
        XCTAssertTrue(open.waitForExistence(timeout: 5)); open.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-conductor-mark"].waitForExistence(timeout: 10))

        // The conductor chat sits on top of the chat it was launched from, so
        // two Back buttons exist; the topmost is the last in the hierarchy.
        let closes = app.buttons.matching(identifier: "chat-close")
        closes.allElementsBoundByIndex.last?.tap()
        if app.buttons["Cancel"].waitForExistence(timeout: 3) { app.buttons["Cancel"].tap() }
        XCTAssertTrue(closes.firstMatch.waitForExistence(timeout: 5))
        closes.allElementsBoundByIndex.last?.tap()

        let key = "A1000000-0000-0000-0000-000000000001:herdr:default:w9:w9:t1"
        let marker = app.descendants(matching: .any)["conductor-card:\(key)"]
        XCTAssertTrue(marker.waitForExistence(timeout: 15))
        let conductorCard = app.buttons["overview-chat:\(key)"]
        let ordinaryCard = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"]
        XCTAssertTrue(conductorCard.exists)
        XCTAssertLessThan(conductorCard.frame.minY, ordinaryCard.frame.minY, "The conductor is pinned above the activity groups")
        attachUIScreenshot(app, "Conductor pinned above session search")
        conductorCard.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-conductor-mark"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Conductor"].exists)
        attachUIScreenshot(app, "Conductor chat header")
    }
}
