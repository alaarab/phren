import XCTest

/// The composer and text selection: keyboard dismissal, slash menus, paragraph menus.
final class AgentChatComposerTests: AgentChatUITestCase {
    @MainActor
    func testDraftSelectionDragsPastVisibleLinesWithoutDismissingKeyboard() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let oneLineHeight = composer.frame.height
        composer.tap()
        composer.typeText("Alpha first line\nBravo second line\nCharlie third line")
        XCTAssertGreaterThan(composer.frame.height, oneLineHeight + 15)
        composer.typeText("\nDelta fourth line\nEcho fifth line\nFoxtrot sixth line\nGolf seventh line\nHotel eighth line\nIndia ninth line\nJuliet tenth line\nKilo eleventh line\nOmega final line")
        let cappedHeight = composer.frame.height
        XCTAssertLessThan(cappedHeight, oneLineHeight * 4)
        // Typing leaves the caret at the end. Scroll the editor itself back
        // to the first line before selecting, keeping the draft intact.
        for _ in 0..<4 {
            let start = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.2))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: cappedHeight - 20)))
        }
        composer.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 30, dy: 8)).doubleTap()
        let report = app.staticTexts["chat-fixture-copied"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.selectionReport(app)["selected"] as? String == "Alpha"
        }, object: report)], timeout: 5), .completed)
        let before = selectionReport(app)["selected"] as? String ?? ""
        let marker = app.descendants(matching: .any)["chat-paragraph:2:0:2"]
        let originalY = marker.frame.minY
        let handle = selectionEnd(app, in: composer)
        let belowEditor = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 1))
            .withOffset(CGVector(dx: 0, dy: 30))
        handle.press(forDuration: 0.15, thenDragTo: belowEditor, withVelocity: .slow, thenHoldForDuration: 3)
        let selected = selectionReport(app)["selected"] as? String ?? ""
        XCTAssertTrue(app.keyboards.firstMatch.exists, "The handle drag must keep the keyboard up")
        XCTAssertGreaterThan(selected.count, before.count, "The actual UITextView selection must grow")
        XCTAssertTrue(selected.contains("Omega final line"), "Edge autoscroll must reach beyond the four visible lines")
        XCTAssertEqual(marker.frame.minY, originalY, accuracy: 2, "The transcript must stay still while the editor scrolls")
        XCTAssertEqual(composer.frame.height, cappedHeight, accuracy: 1)
        // Collapse the selection by typing, then exercise dismissal again
        // in the same chat to catch a selection guard that never releases.
        composer.typeText("Replacement")
        dragTranscriptDown(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testPlainTranscriptDragStillDismissesKeyboardInteractively() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Keep this draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        dragTranscriptDown(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "Keep this draft")
    }

    @MainActor
    func testMessageSelectionHandleDoesNotMoveTranscriptOrDismissSelection() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let paragraph = app.descendants(matching: .any)["chat-paragraph:2:0:1"]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 8))
        paragraph.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: 5)).doubleTap()
        let selectable = app.textViews["chat-selectable:2:0:1"]
        XCTAssertTrue(selectable.waitForExistence(timeout: 5))
        let report = app.staticTexts["chat-fixture-copied"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.selectionReport(app)["selected"] as? String == "Bravo"
        }, object: report)], timeout: 5), .completed)
        let originalFrame = selectable.frame
        let keyboardWasVisible = app.keyboards.firstMatch.exists
        let bottom = selectable.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1))
            .withOffset(CGVector(dx: 0, dy: 20))
        selectionEnd(app, in: selectable).press(forDuration: 0.15, thenDragTo: bottom, withVelocity: .slow, thenHoldForDuration: 1)
        XCTAssertTrue(selectable.exists, "A handle drag must not exit Select text mode")
        XCTAssertEqual(selectable.frame.minY, originalFrame.minY, accuracy: 2)
        XCTAssertEqual(app.keyboards.firstMatch.exists, keyboardWasVisible)
        XCTAssertGreaterThan((selectionReport(app)["selected"] as? String ?? "").count, "Bravo".count)
        XCTAssertTrue(app.buttons["chat-selectable-done"].exists)
    }

    /// The box follows the draft on every change: typing, the first wrap, a
    /// paste, dictation's insert and deleting back down. One to four lines
    /// grow it; past four it keeps its height and scrolls inside.
    @MainActor
    func testComposerHeightFollowsTheDraftToFourLinesThenScrolls() {
        let app = launch(extra: ["--chat-composer-inserts", "--chat-clear-drafts"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let empty = settledHeight(composer)
        composer.tap()
        composer.typeText("One")
        let one = keepsUp(app, composer, "one line")
        XCTAssertEqual(one, empty, accuracy: 1)
        composer.typeText("\nTwo")
        let two = keepsUp(app, composer, "two lines")
        let line = two - one
        XCTAssertGreaterThan(line, 14, "A second line grows the box by a line")
        composer.typeText("\nThree")
        XCTAssertEqual(keepsUp(app, composer, "three lines"), one + 2 * line, accuracy: 1.5)
        composer.typeText("\nFour")
        let four = keepsUp(app, composer, "four lines")
        XCTAssertEqual(four, one + 3 * line, accuracy: 1.5)
        capture(app, "Composer with a four-line draft")
        composer.typeText("\nFive\nSix")
        XCTAssertEqual(keepsUp(app, composer, "six lines", cap: four), four, accuracy: 1, "Past four lines the box scrolls")
        capture(app, "Composer with a six-line draft")
        // Deleting back down shrinks it with the text.
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "\nFive\nSix".count))
        XCTAssertEqual(keepsUp(app, composer, "back to four", cap: four), four, accuracy: 1)
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "\nThree\nFour".count))
        XCTAssertEqual(keepsUp(app, composer, "back to two", cap: four), two, accuracy: 1)
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "\nTwo".count))
        XCTAssertEqual(keepsUp(app, composer, "back to one", cap: four), one, accuracy: 1)
        // The first wrap: one line typed past the width of the box.
        composer.typeText(" and then a single sentence that keeps going past the edge")
        XCTAssertGreaterThanOrEqual(keepsUp(app, composer, "first wrap", cap: four), two - 1)
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 80))
        XCTAssertEqual(keepsUp(app, composer, "cleared", cap: four), one, accuracy: 1)
        // A paste of several lines at once.
        UIPasteboard.general.string = "Pasted one\nPasted two\nPasted three"
        composer.press(forDuration: 1.1)
        let paste = app.menuItems["Paste"]
        if paste.waitForExistence(timeout: 3) {
            paste.tap()
            XCTAssertEqual(keepsUp(app, composer, "paste", cap: four), one + 2 * line, accuracy: 1.5)
            composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
            XCTAssertEqual(keepsUp(app, composer, "paste cleared", cap: four), one, accuracy: 1)
        }
        // Dictation changes the draft from outside the editor.
        composer.typeText("#dictate")
        XCTAssertEqual(keepsUp(app, composer, "dictation", cap: four), two, accuracy: 1.5)
        capture(app, "Composer after a dictated insert")
        composer.typeText("#dictate")
        XCTAssertEqual(keepsUp(app, composer, "dictation twice", cap: four), one + 2 * line, accuracy: 1.5)
    }

    /// A long typed draft (owner, September 24): the box grows with it, the
    /// editor stays inside the box and above its button row, and past four
    /// lines it scrolls there, with and without an attachment above. With the
    /// keyboard up the box keeps a gap above the keyboard's suggestion bar.
    @MainActor
    func testLongDraftStaysInsideTheBoxAboveTheButtonRow() {
        longDraftStaysInsideTheBox(attachment: false)
    }

    @MainActor
    func testLongDraftWithAnAttachmentStaysInsideTheBox() {
        longDraftStaysInsideTheBox(attachment: true)
    }

    @MainActor private func longDraftStaysInsideTheBox(attachment: Bool) {
        let app = launch(extra: ["--chat-clear-drafts"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let box = app.descendants(matching: .any).matching(identifier: "chat-message-box").firstMatch
        if attachment {
            attachImage(app)
            XCTAssertTrue(app.descendants(matching: .any)["chat-attachments"].waitForExistence(timeout: 5))
        }
        let emptyBox = settledHeight(box)
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        composer.typeText("Please look at the chat composer again, because when I type a long message the text runs out of the box and over the buttons")
        let four = keepsUp(app, composer, "long draft")
        XCTAssertGreaterThan(box.frame.height, emptyBox + 30, "The box grows with a wrapped draft")
        holdsDraft(app, composer, box, "long draft")
        composer.typeText(" and it keeps going for a few more lines so the editor has to scroll inside the box instead of spilling out of it")
        XCTAssertEqual(keepsUp(app, composer, "longer draft", cap: four), four, accuracy: 1, "Past four lines the box scrolls")
        holdsDraft(app, composer, box, "longer draft")
        capture(app, attachment ? "Long draft with an attachment, keyboard up" : "Long draft, keyboard up")
    }

    /// The editor inside the box and above the button row, the box's bottom
    /// a keyboard gap above the keyboard.
    @MainActor private func holdsDraft(_ app: XCUIApplication, _ composer: XCUIElement, _ box: XCUIElement, _ step: String) {
        let editor = composer.frame, frame = box.frame
        let buttons = app.buttons["Add attachment"].frame
        XCTAssertGreaterThanOrEqual(editor.minY, frame.minY, "\(step): the editor starts inside the box (\(editor) in \(frame))")
        XCTAssertLessThanOrEqual(editor.maxY, buttons.minY + 0.5, "\(step): the editor ends above the button row (\(editor), buttons \(buttons))")
        XCTAssertLessThanOrEqual(buttons.maxY, frame.maxY + 0.5, "\(step): the button row stays in the box")
        // XCUITest's keyboard frame starts below the suggestion bar; the app
        // reports the top UIKit gives it, suggestion bar included.
        let keyboardTop = selectionReport(app)["keyboardTop"] as? Double ?? 0
        XCTAssertGreaterThan(keyboardTop, 0, "\(step): the keyboard is up")
        let gap = keyboardTop - frame.maxY
        XCTAssertGreaterThanOrEqual(gap, 9.5, "\(step): the box keeps its gap above the suggestion bar (box \(frame), keyboard top \(keyboardTop))")
        XCTAssertLessThanOrEqual(gap, 10.5, "\(step): the gap stays modest")
    }

    /// The composer's settled height, after checking that the box holds its
    /// text: as tall as the text up to the cap, and never scrolled while the
    /// whole draft fits.
    @MainActor @discardableResult
    private func keepsUp(_ app: XCUIApplication, _ composer: XCUIElement, _ step: String, cap: CGFloat = .greatestFiniteMagnitude) -> CGFloat {
        let height = settledHeight(composer)
        var metrics: [Double] = []
        let fits = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            metrics = self.selectionReport(app)["composer"] as? [Double] ?? []
            guard metrics.count == 3 else { return false }
            let (offset, content, visible) = (metrics[0], metrics[1], metrics[2])
            let whole = content <= visible + 1
            return abs(visible - composer.frame.height) <= 1
                && (whole ? offset <= 0.5 : visible >= min(Double(cap), content) - 1)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [fits], timeout: 3), .completed,
                       "\(step): the box must hold its text (offset, text, visible) = \(metrics), frame \(composer.frame.height)")
        return height
    }

    @MainActor private func settledHeight(_ element: XCUIElement) -> CGFloat {
        var last = element.frame.height
        for _ in 0..<10 {
            usleep(250_000)
            let now = element.frame.height
            if abs(now - last) < 0.5 { return now }
            last = now
        }
        return last
    }

    @MainActor private func selectionReport(_ app: XCUIApplication) -> [String: Any] {
        let label = app.staticTexts["chat-fixture-copied"].label
        return (try? JSONSerialization.jsonObject(with: Data(label.utf8)) as? [String: Any]) ?? [:]
    }

    @MainActor private func selectionEnd(_ app: XCUIApplication, in editor: XCUIElement) -> XCUICoordinate {
        let report = selectionReport(app)
        return editor.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: report["selectionEndX"] as? Double ?? 0,
            dy: report["selectionEndY"] as? Double ?? 0))
    }

    /// Interactive dismissal follows the finger into the keyboard, as in
    /// Messages: the drag runs from the transcript down past the keyboard's
    /// top edge. A short drag that stays above it only scrolls.
    @MainActor private func dragTranscriptDown(_ app: XCUIApplication) {
        let transcript = app.scrollViews["chat-transcript"]
        let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3))
        let keyboard = app.keyboards.firstMatch
        let distance = keyboard.exists ? keyboard.frame.minY + 80 - start.screenPoint.y : 150
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance)))
    }

    @MainActor
    func testDownwardDragOnComposerAndIconsDismissesKeyboardWithoutSending() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        let draft = "Keep my draft while I swipe"
        composer.tap(); composer.typeText(draft)
        let horizontalStart = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
        horizontalStart.press(forDuration: 0.05, thenDragTo: horizontalStart.withOffset(CGVector(dx: 100, dy: 0)))
        XCTAssertTrue(app.keyboards.firstMatch.exists, "A horizontal editing gesture must not dismiss the keyboard")

        for surface in [composer, app.buttons["chat-composer-terminal"], app.buttons["chat-send"]] {
            composer.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 8, dy: 110)))
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
            XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
            XCTAssertEqual(composer.value as? String, draft)
            XCTAssertTrue(app.buttons["chat-close"].isHittable, "Swiping a terminal icon must not open it")
            XCTAssertFalse(app.staticTexts["Received in codex on w7:p1: \(draft)"].exists, "Swiping Send must not send")
        }
        capture(app, "Keyboard dismissed by dragging the message box or icons")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: \(draft)"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testCompactBottomComposerAndTapToDismissKeyboard() {
        let app = launch(extra: ["--chat-markdown"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertLessThanOrEqual(composer.frame.height, 40)
        let box = app.descendants(matching: .any).matching(identifier: "chat-message-box").firstMatch
        XCTAssertGreaterThan(box.frame.maxY, app.frame.maxY - 40)
        XCTAssertLessThanOrEqual(box.frame.height, 84)
        XCTAssertGreaterThan(composer.frame.width, app.frame.width - 55)
        let lastLine = app.staticTexts["Ready to test."]
        XCTAssertTrue(lastLine.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        composer.tap(); composer.typeText("Keep this draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready to test."].isHittable,
                      "The last transcript message stays visible when the composer gains focus")
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        capture(app, "Smaller chat text and bottom composer")
        app.staticTexts["Ready to test."].tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertTrue(app.staticTexts["Ready to test."].isHittable,
                      "The last transcript message stays visible after the keyboard is dismissed")
        XCTAssertEqual(composer.value as? String, "Keep this draft")
        XCTAssertGreaterThan(box.frame.maxY, app.frame.maxY - 50)
        XCTAssertLessThanOrEqual(box.frame.minY - lastLine.frame.maxY, 18)
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        // A code block has no title bar: tapping it (like any transcript
        // surface) still hands the keyboard away without touching the draft.
        app.descendants(matching: .any)["chat-code-block"].firstMatch.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)], timeout: 5), .completed)
        XCTAssertEqual(composer.value as? String, "Keep this draft")
        capture(app, "Chat keyboard dismissed without losing the draft")
    }

    @MainActor
    func testSlashSuggestionsAndFullMenuPreserveDraftWithoutSubmitting() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/mo")
        XCTAssertTrue(app.buttons["chat-command:/model"].label.contains("Choose the model"))
        let menu = app.descendants(matching: .any).matching(identifier: "chat-command-menu").firstMatch
        XCTAssertLessThan(menu.frame.maxY, composer.frame.minY)
        XCTAssertGreaterThan(menu.frame.width, app.frame.width - 40)
        capture(app, "Vertical slash command suggestions above the draft")
        app.buttons["chat-command:/model"].tap()
        XCTAssertEqual(composer.value as? String, "/model ")
        app.buttons["chat-all-commands"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        let report = app.staticTexts["terminal-fixture-report"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let value = try? JSONSerialization.jsonObject(with: Data(report.label.utf8)) as? [String: Any]
            return value?["input"] as? String == "/"
        }, object: report)], timeout: 5), .completed)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.buttons["herdr-terminal-back"].tap()
        XCTAssertEqual(composer.value as? String, "/model ")
    }

    @MainActor
    func testSlashMenuRowsStayVerticalAndScrollable() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/")
        let first = app.buttons["chat-command:/model"].frame
        let second = app.buttons["chat-command:/permissions"].frame
        XCTAssertEqual(first.minX, second.minX, accuracy: 1)
        XCTAssertGreaterThanOrEqual(second.minY, first.maxY)
        XCTAssertGreaterThanOrEqual(first.height, 44)
        XCTAssertLessThan(app.descendants(matching: .any).matching(identifier: "chat-command-menu").firstMatch.frame.height, 300)
        capture(app, "Compact vertical command menu")
        app.scrollViews["chat-command-list"].swipeUp()
        XCTAssertTrue(app.buttons["chat-command:/mcp"].isHittable)
        app.buttons["chat-command:/mcp"].tap()
        XCTAssertEqual(composer.value as? String, "/mcp ")
        XCTAssertFalse(app.buttons["chat-command:/model"].exists)
    }

    @MainActor
    func testSlashPermissionsDrawsTheMenuNativelyAndWalksItWithKeys() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/permissions")
        app.buttons["chat-send"].tap()
        let full = app.buttons["chat-menu:2"]
        XCTAssertTrue(full.waitForExistence(timeout: 5), "The agent's menu is drawn as native rows")
        XCTAssertTrue(full.label.contains("Full Access"))
        capture(app, "Permissions menu")
        full.tap()
        let echoed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/permissions")).firstMatch
        XCTAssertTrue(echoed.waitForExistence(timeout: 8), "The command is typed for the agent")
        XCTAssertFalse(app.otherElements["herdr-terminal-header"].exists, "The menu is walked with keys, not in the terminal")
        XCTAssertFalse(app.staticTexts["chat-delivery-error"].waitForExistence(timeout: 3))
    }

    /// Holding a paragraph offers that paragraph, not the bubble's whole
    /// message; a double-tap swaps in native selection with the word under
    /// the finger, and a tap elsewhere puts the paragraph back.
    @MainActor
    func testParagraphMenuCopiesOneParagraphAndDoubleTapSelectsItsWord() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let any = app.descendants(matching: .any)
        let first = any["chat-paragraph:2:0:0"], second = any["chat-paragraph:2:0:1"], third = any["chat-paragraph:2:0:2"]
        XCTAssertTrue(third.waitForExistence(timeout: 8), "Blank lines split the reply into paragraphs")
        XCTAssertTrue(any["chat-code-block"].firstMatch.exists, "The code block keeps its own hold-to-copy")
        let report = app.staticTexts["chat-fixture-copied"]
        func reported() -> [String: Any] {
            (try? JSONSerialization.jsonObject(with: Data(report.label.utf8)) as? [String: Any]) ?? [:]
        }
        // A few points in from a paragraph's top-left corner is its first
        // word, at every text size: where the hold and the double-tap land.
        func start(_ paragraph: XCUIElement) -> XCUICoordinate {
            paragraph.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: 5))
        }
        start(second).press(forDuration: 1.0)
        let copyParagraph = app.buttons["Copy paragraph"]
        XCTAssertTrue(copyParagraph.waitForExistence(timeout: 5), "The paragraph's menu, above the bubble's")
        XCTAssertTrue(app.buttons["Select text"].exists)
        XCTAssertTrue(app.buttons["chat-message-menu:copy-message"].exists)
        XCTAssertFalse(app.buttons["chat-message-menu:share"].exists, "Share is not a message action")
        capture(app, "Paragraph menu")
        copyParagraph.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (reported()["copied"] as? [String])?.isEmpty == false
        }, object: report)], timeout: 5), .completed)
        XCTAssertEqual(reported()["copied"] as? [String], ["Bravo paragraph explains why `ChatRichText` renders blocks, each copying on its own."],
                       "Only the held paragraph, as plain Markdown")

        start(third).doubleTap()
        let selectable = any["chat-selectable:2:0:2"]
        XCTAssertTrue(selectable.waitForExistence(timeout: 5), "The double-tapped paragraph becomes native text")
        XCTAssertFalse(any["chat-selectable:2:0:1"].exists, "Only one paragraph is selectable")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            reported()["selected"] as? String == "Charlie"
        }, object: report)], timeout: 5), .completed, "The word under the double-tap starts selected: \(reported())")
        XCTAssertTrue((selectable.value as? String ?? "").hasPrefix("Charlie paragraph"), "The native view carries the paragraph's text")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Selecting never raises the keyboard")
        XCTAssertTrue(app.buttons["chat-selectable-done"].exists)
        capture(app, "Word selected in place")
        // Holding the native text gives the system's own menu, not the
        // paragraph's.
        selectable.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).press(forDuration: 1.0)
        XCTAssertFalse(app.buttons["Copy paragraph"].waitForExistence(timeout: 1.5), "The selectable text keeps its native menu")

        start(first).tap()
        // The system menu, when it is up, takes the first tap for itself.
        if !selectable.waitForNonExistence(timeout: 2) { start(first).tap() }
        XCTAssertTrue(selectable.waitForNonExistence(timeout: 5), "A tap elsewhere puts the paragraph back")
        XCTAssertTrue(third.exists)
        XCTAssertFalse(app.buttons["chat-selectable-done"].exists)

        // The menu's "Select text" starts from the whole paragraph; Done ends it.
        start(first).press(forDuration: 1.0)
        let select = app.buttons["Select text"]
        XCTAssertTrue(select.waitForExistence(timeout: 5)); select.tap()
        let whole = any["chat-selectable:2:0:0"]
        XCTAssertTrue(whole.waitForExistence(timeout: 5))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (reported()["selected"] as? String)?.hasPrefix("Alpha paragraph opens") == true
        }, object: report)], timeout: 5), .completed, "Select text starts with the whole paragraph: \(reported())")
        let done = app.buttons["chat-selectable-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 3))
        done.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        if !whole.waitForNonExistence(timeout: 2) { done.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        XCTAssertTrue(whole.waitForNonExistence(timeout: 5), "Done puts the paragraph back")
    }

    @MainActor
    func testMessageMenuCoversComposerAndKeepsPressedMessageAboveItsBackdrop() {
        let app = launch(extra: ["--chat-paragraphs"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let any = app.descendants(matching: .any)
        let paragraph = any["chat-paragraph:2:0:1"]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 8))
        let composer = any.matching(identifier: "chat-composer").firstMatch
        let composerFrame = composer.frame
        let paragraphFrame = paragraph.frame
        paragraph.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: 5)).press(forDuration: 0.7)
        let backdrop = any["chat-message-menu-backdrop"]
        XCTAssertTrue(backdrop.waitForExistence(timeout: 5))
        XCTAssertTrue(backdrop.frame.contains(composerFrame), "The backdrop covers the entire composer")
        for id in ["copy-paragraph", "select-text", "copy-message"] {
            let action = app.buttons["chat-message-menu:" + id]
            XCTAssertTrue(action.isHittable)
            XCTAssertFalse(action.frame.intersects(paragraphFrame), "Actions never cover the pressed paragraph")
        }
        XCTAssertFalse(app.buttons["chat-message-menu:share"].exists)
        capture(app, "Message menu beside the pressed paragraph")
        // Input is blocked behind the menu: a tap where the composer sits lands
        // on the backdrop, closes the menu and starts no typing. (iOS 27 reports
        // a covered view as hittable, so the test taps instead of asking.)
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: composerFrame.midX, dy: composerFrame.midY)).tap()
        XCTAssertTrue(backdrop.waitForNonExistence(timeout: 5))
        XCTAssertFalse((composer.value(forKey: "hasKeyboardFocus") as? Bool) ?? false, "Input is blocked behind the menu")
        XCTAssertTrue(composer.isHittable)
        XCTAssertTrue(paragraph.exists)
        // The chat sits under the menu while it is open (hidden from
        // VoiceOver); opening and closing it moved nothing.
        XCTAssertEqual(paragraph.frame.minY, paragraphFrame.minY, accuracy: 1)
        XCTAssertEqual(composer.frame.minY, composerFrame.minY, accuracy: 1)
    }

    @MainActor
    func testMessageMenuKeepsTheKeyboardAndClosesOnADrag() {
        let app = launch(extra: ["--chat-paragraphs", "--chat-clear-drafts"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let any = app.descendants(matching: .any)
        let paragraph = any["chat-paragraph:2:0:1"]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 8))
        let composer = any.matching(identifier: "chat-composer").firstMatch
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(paragraph.waitForExistence(timeout: 3))
        paragraph.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: 5)).press(forDuration: 0.7)
        let backdrop = any["chat-message-menu-backdrop"]
        XCTAssertTrue(backdrop.waitForExistence(timeout: 5))
        capture(app, "Message menu open over the keyboard")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "Opening the menu leaves the keyboard up")
        let start = backdrop.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.15))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 120)))
        XCTAssertTrue(backdrop.waitForNonExistence(timeout: 5), "A drag outside the card closes it")
    }

    @MainActor
    func testTranscriptRisesAndFallsWithTheKeyboard() {
        let app = launch(extra: ["--chat-long-history", "--chat-clear-drafts"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let box = app.descendants(matching: .any).matching(identifier: "chat-message-box").firstMatch
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        let last = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Recent discussion 19.")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertTrue(last.waitForExistence(timeout: 8))
        XCTAssertTrue(app.scrollViews["chat-transcript"].waitForExistence(timeout: 5))
        // Let the opening pin settle at the end.
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in last.isHittable && last.frame.maxY <= box.frame.minY + 1 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 5), .completed)
        let resting = last.frame
        capture(app, "Transcript before the keyboard")
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        // The latest message rides up with the composer instead of going under the keyboard.
        let raised = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            box.frame.minY < resting.maxY && last.frame.maxY <= box.frame.minY + 1 && last.isHittable
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [raised], timeout: 5), .completed,
                       "Last message \(last.frame) must stay above the composer \(box.frame)")
        XCTAssertLessThanOrEqual(box.frame.minY - last.frame.maxY, 40, "It stays right above the composer")
        capture(app, "Transcript risen with the keyboard")
        // Tapping the transcript hands the keyboard away; the transcript goes back down with it.
        last.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        let lowered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            abs(last.frame.maxY - resting.maxY) <= 4 && last.frame.maxY <= box.frame.minY + 1
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [lowered], timeout: 5), .completed, "Last message \(last.frame), resting \(resting)")
        capture(app, "Transcript after the keyboard hides")
    }
}
