import XCTest

/// "Open on a computer" from a session: a stalled thread offers a new one on
/// the project's own computer, and the store already says where it lives.
final class LaunchSessionTests: XCTestCase {
    /// Launches the fixture, opens the stalled session and its New thread
    /// sheet. The first launch on a freshly booted simulator can come up
    /// before the fixture computer is installed (Agents shows only Add
    /// computer); a relaunch always lands, as in LiveSessionsTests.
    @MainActor
    private func openNewThread(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"]
            + extra + ["--chat-history-stalled"]
        let session = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"]
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
            app.tabBars.buttons["Agents"].tap()
            if session.waitForExistence(timeout: attempt == 0 ? 10 : 20) { break }
            if attempt == 0 { app.terminate() }
        }
        XCTAssertTrue(session.exists); session.tap()
        let newThread = app.buttons["New thread"]
        XCTAssertTrue(newThread.waitForExistence(timeout: 8)); newThread.tap()
        return app
    }

    @MainActor
    func testOpensAProjectOnAKnownComputerAndLandsInChat() {
        let app = openNewThread()
        let chooser = app.buttons["launch-computer"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 5))
        chooser.tap()
        let mac = app.buttons["launch-computer:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(mac.waitForExistence(timeout: 5))
        XCTAssertTrue(mac.label.contains("has phone"), "machines.yaml + the profile say this computer carries the project")
        XCTAssertTrue(mac.isSelected, "The computer that has the project is chosen up front")
        app.buttons["launch-computer-done"].tap()
        let folder = app.textFields["launch-folder"]
        XCTAssertTrue(app.buttons["launch-found:/work/phone"].waitForExistence(timeout: 5), "The computer reports where the project is")
        XCTAssertEqual(folder.value as? String, "/work/phone", "The folder is the computer's own answer")
        XCTAssertTrue(app.buttons["launch-found:/Users/fixture/Projects/phone"].exists)
        app.buttons["launch-found:/Users/fixture/Projects/phone"].tap()
        XCTAssertEqual(folder.value as? String, "/Users/fixture/Projects/phone", "A candidate fills the field")
        app.buttons["launch-found:/work/phone"].tap()
        XCTAssertEqual(folder.value as? String, "/work/phone")
        for _ in 0..<5 where !app.buttons["launch-harness:claude"].isHittable { app.swipeUp() }
        app.buttons["launch-harness:claude"].tap()
        XCTAssertTrue(app.buttons["launch-harness:claude"].isSelected)
        let open = app.buttons["launch-open"]
        for _ in 0..<6 where !open.isHittable { app.swipeUp() }
        XCTAssertTrue(open.isEnabled)
        XCTAssertTrue(open.label.contains("Claude Code"))
        open.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 10), "The new session opens straight into chat")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "chat-provider").firstMatch.label, "Claude")
        XCTAssertTrue(app.staticTexts.matching(identifier: "chat-location").firstMatch.label.contains("phone"))
        attachUIScreenshot(app, "Chat opened on the launched session")
    }

    @MainActor
    func testWorktreeIsOptionalAndTakesAnEditableBranch() {
        let app = openNewThread()
        XCTAssertTrue(app.buttons["launch-found:/work/phone"].waitForExistence(timeout: 5))

        let toggle = app.descendants(matching: .any)["launch-worktree"]
        for _ in 0..<8 where !(toggle.exists && toggle.isHittable) { app.swipeUp() }
        XCTAssertTrue(toggle.waitForExistence(timeout: 3))
        XCTAssertEqual(toggle.value as? String, "Off", "A worktree is optional and off by default")
        XCTAssertFalse(app.textFields["launch-worktree-branch"].exists)
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "On")
        let branch = app.textFields["launch-worktree-branch"]
        XCTAssertTrue(branch.waitForExistence(timeout: 3))
        let suggested = branch.value as? String ?? ""
        XCTAssertNotNil(suggested.range(of: #"^phren/[0-9a-f]{6}$"#, options: .regularExpression),
                        "Without a task the branch is phren/<short id>, got \(suggested)")

        func typeBranch(_ text: String) {
            // Bring the field well above the keyboard before focusing it.
            for _ in 0..<4 where !branch.isHittable || branch.frame.maxY > app.frame.height * 0.55 { app.swipeUp() }
            branch.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            branch.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (branch.value as? String ?? "").count + 2) + text)
        }
        let open = app.buttons["launch-open"]
        typeBranch("-bad")
        XCTAssertTrue(app.staticTexts["launch-worktree-note"].label.contains("starts with a letter or digit"))
        XCTAssertFalse(open.isEnabled, "An invalid branch name keeps Open disabled")

        // The computer refuses a branch that already exists, and the sheet stays.
        typeBranch("main")
        for _ in 0..<6 where !open.isHittable { app.swipeUp() }
        XCTAssertTrue(open.isEnabled)
        open.tap()
        XCTAssertTrue(app.staticTexts["Couldn't open session"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "already exists")).firstMatch.exists)
        app.buttons["OK"].tap()

        for _ in 0..<6 where !branch.isHittable { app.swipeDown() }
        typeBranch("phren/fix-login")
        XCTAssertEqual(branch.value as? String, "phren/fix-login")
        for _ in 0..<6 where !open.isHittable { app.swipeUp() }
        open.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 10), "The worktree session opens into chat")
    }

    @MainActor
    func testAFailedStartExplainsAndKeepsThePicker() {
        let app = openNewThread(["--launch-fails"])
        for _ in 0..<8 where !app.buttons["launch-open"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.buttons["launch-open"].waitForExistence(timeout: 5))
        app.buttons["launch-open"].tap()
        XCTAssertTrue(app.staticTexts["Couldn't open session"].waitForExistence(timeout: 8))
        // The harness is whichever was picked last (it persists), so match the verb only.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "couldn't start")).firstMatch.exists)
        app.buttons["OK"].tap()
        for _ in 0..<8 where !app.textFields["launch-folder"].isHittable { app.swipeDown() }
        XCTAssertTrue(app.textFields["launch-folder"].exists, "The picker stays so the folder or harness can be changed")
    }
}
