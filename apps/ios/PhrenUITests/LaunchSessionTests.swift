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

    /// Launches the fixture on Agents with the project's session listed.
    @MainActor
    private func openAgents() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"]
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
            app.tabBars.buttons["Agents"].tap()
            if app.buttons[phoneSession].waitForExistence(timeout: attempt == 0 ? 10 : 20) { break }
            if attempt == 0 { app.terminate() }
        }
        XCTAssertTrue(app.buttons[phoneSession].exists)
        return app
    }

    private let phoneSession = "overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"

    /// The launch sheet opened for a worktree: the switch on and the branch
    /// already filled, so one tap on Open starts it.
    @MainActor
    private func assertWorktreeLaunch(_ app: XCUIApplication, branch expected: String, harness: String? = nil) {
        XCTAssertTrue(app.navigationBars["Open phone"].waitForExistence(timeout: 8))
        if let harness {
            XCTAssertTrue(app.buttons["launch-harness:\(harness)"].isSelected, "The session's own harness is chosen")
        }
        XCTAssertTrue(app.buttons["launch-found:/work/phone"].waitForExistence(timeout: 5))
        let toggle = app.descendants(matching: .any)["launch-worktree"]
        for _ in 0..<8 where !(toggle.exists && toggle.isHittable) { app.swipeUp() }
        XCTAssertEqual(toggle.value as? String, "On", "The worktree switch starts on")
        let branch = app.textFields["launch-worktree-branch"]
        XCTAssertTrue(branch.waitForExistence(timeout: 3))
        let value = branch.value as? String ?? ""
        XCTAssertNotNil(value.range(of: expected, options: .regularExpression), "Branch \(value) matches \(expected)")
        attachUIScreenshot(app, "Worktree launch pre-filled")
        let open = app.buttons["launch-open"]
        for _ in 0..<6 where !open.isHittable { app.swipeUp() }
        XCTAssertTrue(open.isEnabled, "The pre-filled branch is valid")
    }

    @MainActor
    func testChatOptionsStartASessionInAWorktree() {
        let app = openAgents()
        app.buttons[phoneSession].tap()
        let options = app.buttons["chat-options"]
        XCTAssertTrue(options.waitForExistence(timeout: 8)); options.tap()
        let row = app.buttons["chat-options-worktree"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "The ••• sheet offers a new session in a worktree")
        attachUIScreenshot(app, "Chat options worktree row")
        row.tap()
        assertWorktreeLaunch(app, branch: "^phren/polish-the-phone-app$", harness: "codex")
    }

    @MainActor
    func testSessionHoldMenuStartsASessionInAWorktree() {
        let app = openAgents()
        app.buttons[phoneSession].press(forDuration: 1.2)
        let row = app.buttons["overview-session-actions:worktree"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "The hold menu offers a new session in a worktree")
        attachUIScreenshot(app, "Session hold menu worktree row")
        row.tap()
        assertWorktreeLaunch(app, branch: "^phren/polish-the-phone-app$", harness: "codex")
    }

    @MainActor
    func testProjectChoiceStartsASessionInAWorktree() {
        let app = openAgents()
        app.tabBars.buttons["Projects"].tap()
        let project = app.buttons["project:sample/brain:phone"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        project.press(forDuration: 0.5)
        let row = app.buttons["project-agent-sheet:worktree"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Next to the computers, a separate worktree choice")
        attachUIScreenshot(app, "Project agent sheet worktree row")
        row.tap()
        assertWorktreeLaunch(app, branch: #"^phren/[0-9a-f]{6}$"#)
        app.buttons["launch-cancel"].tap()

        // The project's sessions page offers it beside Open on a computer.
        project.tap()
        let computer = app.buttons["project-computer:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(computer.waitForExistence(timeout: 5)); computer.tap()
        let sessionsRow = app.buttons["sessions-open-in-worktree"]
        XCTAssertTrue(sessionsRow.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["sessions-open-on-computer"].exists)
        attachUIScreenshot(app, "Project sessions worktree row")
        sessionsRow.tap()
        assertWorktreeLaunch(app, branch: #"^phren/[0-9a-f]{6}$"#)
    }

}
