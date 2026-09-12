import XCTest

final class TerminalInteractionTests: XCTestCase {
    @MainActor
    func testArrowPadEditingAndCtrlHoldShortcutsDoNotSubmitCommands() throws {
        let app = launch("--terminal-controls-fixture")
        app.buttons["Arrow keys"].tap()
        for title in ["Backspace", "Up", "Clear line", "Left", "Enter", "Right", "Down"] {
            XCTAssertTrue(app.buttons[title].isHittable)
        }
        let enter = app.buttons["Enter"].frame
        XCTAssertGreaterThan(enter.midX, app.buttons["Left"].frame.midX)
        XCTAssertLessThan(enter.midX, app.buttons["Right"].frame.midX)
        app.buttons["Backspace"].tap()
        app.buttons["Clear line"].tap()
        app.buttons["Enter"].tap()
        capture(app, "Arrow pad with Enter and Clear Line")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3)).tap()
        XCTAssertEqual(try state(app).input, "\u{7F}\u{05}\u{15}\r")
        let before = try state(app).input
        app.buttons["Ctrl"].press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Close shortcuts"].waitForExistence(timeout: 3))
        XCTAssertEqual(try state(app).input, before, "Holding Ctrl must not send a key")
        app.buttons["Codex shortcuts"].tap()
        app.buttons["terminal-command:codex:/model"].tap()
        XCTAssertEqual(try state(app).input, before + "/model ", "A command waits for explicit Enter")
        capture(app, "Tabbed terminal command palette")
        app.buttons["Claude shortcuts"].tap()
        XCTAssertTrue(app.buttons["terminal-command:claude:/help"].isHittable)
        app.buttons["Terminal gestures"].tap()
        XCTAssertTrue(app.switches["Two-finger gestures"].isHittable)
        capture(app, "Terminal gesture settings")
        app.buttons["Close shortcuts"].tap()
        XCTAssertEqual(app.buttons["Ctrl"].value as? String, "Off", "A hold must not also latch Ctrl")
        app.buttons["Ctrl"].tap()
        XCTAssertEqual(app.buttons["Ctrl"].value as? String, "On")
        app.buttons["Ctrl"].tap()
        XCTAssertEqual(app.buttons["Ctrl"].value as? String, "Off")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.buttons["Terminal shortcuts"].tap()
        app.buttons["Herdr shortcuts"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Workspaces & panes")).firstMatch.tap()
        XCTAssertTrue(app.buttons["Open Herdr terminal"].waitForExistence(timeout: 5), "Herdr shortcuts open native controls on this computer")
        XCTAssertTrue(app.buttons["Open Herdr terminal"].isEnabled)
        XCTAssertTrue(app.buttons["Open Herdr terminal"].isHittable)
    }

    @MainActor
    func testSwitchActivatesOnFirstTapWithoutRaisingKeyboard() throws {
        let app = launch("--terminal-controls-fixture")
        let before = try state(app)
        try tapCell(app, column: before.columns - 3, row: 1)
        XCTAssertTrue(try state(app).switchOpen, "Switch must actually open, not just emit some mouse bytes")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        XCTAssertEqual(try state(app).rows, before.rows, "A control tap must not resize Herdr")
        try tapCell(app, column: before.columns - 3, row: 1)
        XCTAssertFalse(try state(app).switchOpen)
        XCTAssertFalse(app.keyboards.firstMatch.exists)

        app.buttons["Toggle terminal keyboard"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        try tapCell(app, column: try state(app).columns - 3, row: 1)
        XCTAssertTrue(try state(app).switchOpen)
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        app.buttons["Toggle terminal keyboard"].tap()
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        try tapCell(app, column: try state(app).columns - 3, row: 1)
        XCTAssertFalse(try state(app).switchOpen)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture(app, "Switch works with keyboard hidden")
    }

    @MainActor
    func testShellLinksOpenOnFirstTapAndBlankTapsKeepKeyboardHidden() throws {
        let app = launch("--terminal-links-fixture")
        try tapCell(app, column: 4, row: 1)
        XCTAssertEqual(try state(app).links, ["https://example.com/explicit"])
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        try tapCell(app, column: 10, row: 2)
        XCTAssertEqual(try state(app).links, ["https://example.com/explicit", "https://example.com/plain"])
        try tapCell(app, column: 10, row: 8)
        XCTAssertEqual(try state(app).input, "")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.buttons["Toggle terminal keyboard"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    }

    @MainActor
    func testCtrlHoldUploadsImageToTheCurrentTerminalAgent() throws {
        let app = launch("--terminal-uploads-fixture")
        app.buttons["Ctrl"].press(forDuration: 0.7)
        XCTAssertTrue(app.buttons["Uploads shortcuts"].waitForExistence(timeout: 5))
        app.buttons["Uploads shortcuts"].tap()
        app.buttons["Attach from Photos"].tap()
        XCTAssertTrue(app.buttons["Add test image"].waitForExistence(timeout: 5))
        app.buttons["Add test image"].tap()
        XCTAssertTrue(app.buttons["Preview Screenshot.png"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Other work"), "Resolve current focus, not the first workspace or original terminal tab")
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Test Mac"))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Received in codex")).firstMatch.exists)
        capture(app, "Image draft opened from Herdr on the current agent")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.buttons["View attached Screenshot.png"].waitForExistence(timeout: 8))
        app.buttons["chat-close"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }

    @MainActor
    func testPinchReflowsHerdrAndKeepsLinksAndSwitchAccurate() throws {
        let app = launch("--terminal-controls-fixture")
        let terminal = app.descendants(matching: .any).matching(identifier: "herdr-terminal").firstMatch
        let header = app.otherElements["herdr-terminal-header"]
        XCTAssertLessThanOrEqual(header.frame.height, 50)
        XCTAssertLessThanOrEqual(terminal.frame.minY - header.frame.maxY, 20, "Accessibility bounds include the first terminal cell inset")
        XCTAssertFalse(app.navigationBars["Herdr terminal"].exists)
        let before = try state(app)
        terminal.pinch(withScale: 0.5, velocity: -1)
        let zoomedOut = try state(app)
        XCTAssertLessThan(zoomedOut.fontSize, before.fontSize)
        XCTAssertGreaterThan(zoomedOut.columns, before.columns)
        XCTAssertGreaterThanOrEqual(zoomedOut.columns, 100, "Zoom out must fit a sidebar-sized grid")
        XCTAssertEqual(zoomedOut.selected, "")
        XCTAssertEqual(zoomedOut.input, "", "Pinching must not click or drag anything remotely")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        try tapCell(app, column: zoomedOut.columns - 3, row: 1)
        XCTAssertTrue(try state(app).switchOpen)
        let clicked = try state(app).input
        try tapCell(app, column: 4, row: 5)
        XCTAssertEqual(try state(app).links, ["https://example.com/herdr"])
        XCTAssertEqual(try state(app).input, clicked, "A link tap must not also click through to Herdr")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture(app, "Pinch out to fit Herdr sidebar")

        terminal.pinch(withScale: 2, velocity: 1)
        let zoomedIn = try state(app)
        XCTAssertGreaterThan(zoomedIn.fontSize, zoomedOut.fontSize)
        XCTAssertLessThan(zoomedIn.columns, zoomedOut.columns)
        try tapCell(app, column: zoomedIn.columns - 3, row: 1)
        XCTAssertFalse(try state(app).switchOpen, "Switch coordinates must follow zoom in too")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }

    @MainActor
    func testDownwardToolbarDragDismissesKeyboardWithoutSendingKeys() throws {
        let app = launch("--terminal-mouse-fixture")
        app.buttons["Toggle terminal keyboard"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let before = try state(app).input
        let start = app.buttons["Tab"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 8, dy: 100)))
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertEqual(try state(app).input, before, "A drag must not send the toolbar key")
        app.buttons["Toggle terminal keyboard"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.buttons["Tab"].tap()
        XCTAssertEqual(try state(app).input, before + "\t", "Normal key taps must still work")
    }

    @MainActor
    func testOneCompactToolbarWithKeyboardAndArrowPad() throws {
        let app = launch("--terminal-mouse-fixture")
        app.buttons["Toggle terminal keyboard"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let toolbar = app.descendants(matching: .any).matching(identifier: "terminal-toolbar").firstMatch
        XCTAssertLessThanOrEqual(toolbar.frame.height, 48)
        for item in ["escape", "tab", "control"] {
            let keys = app.buttons.matching(NSPredicate(format: "identifier == %@", "terminal-control:\(item)"))
            XCTAssertEqual(keys.count, 1,
                           "The terminal must not install a second key row")
            XCTAssertGreaterThanOrEqual(keys.firstMatch.frame.height, 44)
        }
        // iOS exposes keycaps below the rounded keyboard's own top inset.
        let inset = app.keyboards.firstMatch.frame.minY - toolbar.frame.maxY
        XCTAssertGreaterThanOrEqual(inset, 0)
        XCTAssertLessThanOrEqual(inset, 36)
        app.buttons["Arrow keys"].tap()
        app.buttons["Up"].tap(); app.buttons["Right"].tap()
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3)).tap()
        XCTAssertTrue(try state(app).input.contains("\u{1B}[A\u{1B}[C"))
        capture(app, "One compact terminal toolbar with keyboard")
        app.buttons["herdr-terminal-back"].tap()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["Agents"].isHittable, "Leaving terminal restores app navigation")
    }

    @MainActor
    func testHerdrSwipeSendsOnlyWheelEventsAndHoldSelectsLocally() throws {
        let app = launch("--terminal-mouse-fixture")
        let terminal = app.descendants(matching: .any).matching(identifier: "herdr-terminal").firstMatch
        XCTAssertTrue(terminal.waitForExistence(timeout: 5))
        let upper = terminal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        let lower = terminal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
        lower.press(forDuration: 0.05, thenDragTo: upper)
        upper.press(forDuration: 0.05, thenDragTo: lower)
        let scrolled = try state(app)
        XCTAssertTrue(scrolled.input.contains("\u{1B}[<64;"))
        XCTAssertTrue(scrolled.input.contains("\u{1B}[<65;"))
        let nonWheel = scrolled.input.replacingOccurrences(of: "\u{1B}\\[<6[45];[0-9]+;[0-9]+M",
                                                          with: "", options: .regularExpression)
        XCTAssertEqual(nonWheel, "", "A swipe must not send mouse presses, releases, drags, or arrow keys")
        XCTAssertEqual(scrolled.selected, "")
        XCTAssertEqual(scrolled.copyActions, 0)

        let origin = terminal.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: 45, dy: 8))
        let end = origin.withOffset(CGVector(dx: 240, dy: 40))
        start.press(forDuration: 0.7, thenDragTo: end)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Copy")).firstMatch.waitForExistence(timeout: 5))
        let selected = try state(app)
        XCTAssertTrue(selected.selected.hasPrefix("Selectable terminal text · line 1"),
                      "Selection must track the word under the finger: \(selected.selected)")
        XCTAssertTrue(selected.selected.contains("line 2"))
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Selecting text must not summon the keyboard")
        XCTAssertEqual(selected.input, scrolled.input, "Selection stays on the phone")
        XCTAssertEqual(selected.copyActions, 0, "Selection alone must not copy")
        capture(app, "Hold to select with explicit copy and paste")
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Copy")).firstMatch.tap()
        XCTAssertEqual(try state(app).copyActions, 1)
        app.buttons["Paste into terminal"].tap()
        XCTAssertEqual(try state(app).input, scrolled.input + selected.selected,
                       "Paste sends the copied text without adding Enter")
        app.buttons["Toggle terminal keyboard"].tap()
        terminal.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.25)).tap()
        let clicked = try state(app).input
        XCTAssertTrue(clicked.contains("\u{1B}[<0;"), "Taps must still reach Herdr controls")
        XCTAssertTrue(clicked.hasSuffix("m"), "A tap must release its mouse button")
        app.buttons["Toggle terminal keyboard"].tap()
        terminal.swipeUp()
        let resumed = try state(app).input
        XCTAssertTrue(resumed.hasPrefix(clicked))
        XCTAssertTrue(String(resumed.dropFirst(clicked.count)).contains("\u{1B}[<65;"),
                      "Scrolling must resume after selection and paste")
    }

    @MainActor
    func testSelectAllKeepsCopyAvailableWithoutOpeningKeyboard() throws {
        let app = launch("--terminal-mouse-fixture")
        let terminal = app.descendants(matching: .any).matching(identifier: "herdr-terminal").firstMatch
        terminal.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 45, dy: 8)).press(forDuration: 0.7)
        let selectAll = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
        // The native edit menu paginates at accessibility text sizes.
        if !selectAll.waitForExistence(timeout: 2), app.buttons["Forward"].exists { app.buttons["Forward"].tap() }
        XCTAssertTrue(selectAll.waitForExistence(timeout: 5))
        XCTAssertEqual(try state(app).selected, "Selectable")
        selectAll.tap()
        let copy = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Copy")).firstMatch
        if !copy.exists, app.buttons["Back"].exists { app.buttons["Back"].tap() }
        XCTAssertTrue(copy.isHittable)
        let selected = try state(app)
        XCTAssertTrue(selected.selected.contains("line 1"))
        XCTAssertTrue(selected.selected.contains("line 18"))
        XCTAssertEqual(selected.copyActions, 0)
        XCTAssertEqual(selected.input, "")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        copy.tap()
        XCTAssertEqual(try state(app).copyActions, 1)
    }

    @MainActor
    func testShellScrollbackStaysLocal() throws {
        let app = launch("--terminal-scrollback-fixture")
        let terminal = app.descendants(matching: .any).matching(identifier: "herdr-terminal").firstMatch
        XCTAssertTrue(terminal.waitForExistence(timeout: 5))
        let before = try state(app)
        XCTAssertGreaterThan(before.topRow, 0)
        terminal.swipeDown()
        let after = try state(app)
        XCTAssertLessThan(after.topRow, before.topRow)
        XCTAssertEqual(after.input, "", "Local history scrolling must not send keys to the shell")
        XCTAssertEqual(after.copyActions, 0)
        capture(app, "Local terminal scrollback")
    }

    @MainActor
    private func launch(_ fixture: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", fixture]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Agents"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test Mac,")).firstMatch.tap()
        XCTAssertTrue(app.buttons["Herdr workspaces & terminal"].waitForExistence(timeout: 5))
        app.buttons["Herdr workspaces & terminal"].tap()
        app.buttons["Open Herdr terminal"].tap()
        XCTAssertTrue(app.staticTexts["terminal-fixture-report"].waitForExistence(timeout: 8))
        return app
    }

    private struct State: Decodable {
        let input: String
        let selected: String
        let topRow: Int
        let copyActions: Int
        let links: [String]
        let switchOpen: Bool
        let fontSize: Double
        let columns: Int
        let rows: Int
        let cellWidth: Double
        let cellHeight: Double
    }

    @MainActor
    private func tapCell(_ app: XCUIApplication, column: Int, row: Int) throws {
        let geometry = try state(app)
        let terminal = app.descendants(matching: .any).matching(identifier: "herdr-terminal").firstMatch
        terminal.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: (Double(column) - 0.5) * geometry.cellWidth,
                                 dy: (Double(row) - 0.5) * geometry.cellHeight)).tap()
    }

    @MainActor
    private func state(_ app: XCUIApplication) throws -> State {
        // Reading AX waits for the gesture/animation to settle; the fixture reports at 10 Hz.
        try JSONDecoder().decode(State.self, from: Data(app.staticTexts["terminal-fixture-report"].label.utf8))
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
