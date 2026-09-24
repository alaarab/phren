import XCTest

final class SettingsScreensTests: XCTestCase {
    /// The regrouped Settings and each new screen: fonts, chat, advanced,
    /// gestures, speech — every control reachable and persisting.
    @MainActor
    func testTerminalInputAndSpeechScreens() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Settings"].tap()
        func visible(_ row: XCUIElement) -> Bool {
            // Lazy form rows can exist before they have a frame. Asking those
            // rows for hittability raises an XCTest hit-point failure.
            row.exists && !row.frame.isEmpty && row.isHittable
        }
        func open(_ id: String, title: String) {
            let row = app.buttons[id]
            for _ in 0..<12 {
                if visible(row) { break }
                app.swipeUp()
            }
            guard visible(row) else { XCTFail("Settings row is not visible: \(id)"); return }
            row.tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), title)
        }
        func isOn(_ element: XCUIElement) -> Bool {
            XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "value == 'On'"), object: element
            )], timeout: 5) == .completed
        }
        func turnOn(_ id: String) {
            let control = app.descendants(matching: .any)[id].firstMatch
            XCTAssertTrue(control.waitForExistence(timeout: 3), id)
            if control.value as? String != "On" { control.tap() }
            XCTAssertTrue(isOn(control), id)
        }
        func back() {
            app.navigationBars.buttons.firstMatch.tap()
            let theme = app.buttons["settings-theme"]
            for _ in 0..<12 {
                if visible(theme) { break }
                app.swipeDown()
            }
            XCTAssertTrue(visible(theme), "Back returns to the top of Settings")
        }

        open("settings-fonts", title: "Fonts & Size")
        let plus = app.buttons["font-size-stepper:plus"]
        XCTAssertTrue(plus.waitForExistence(timeout: 3))
        let sizeValue = app.staticTexts["font-size-stepper:value"]
        let before = Int(sizeValue.label) ?? 0
        plus.tap()
        XCTAssertEqual(Int(sizeValue.label), min(24, before + 1), "The phren stepper raises the size by one point")
        XCTAssertTrue(app.buttons["font-size-stepper:minus"].isEnabled)
        attachUIScreenshot(app, "Fonts and size")
        XCTAssertTrue(app.staticTexts["font-sample"].exists)
        XCTAssertTrue(app.buttons["font-choice:system"].exists)
        XCTAssertTrue(app.buttons["font-download:JetBrainsMono-Regular.ttf"].exists)
        XCTAssertTrue(app.buttons["font-import"].exists)
        back()

        open("settings-chat", title: "Chat")
        let openIn = app.descendants(matching: .any)["chat-open-in"].firstMatch
        XCTAssertTrue(openIn.waitForExistence(timeout: 3))
        openIn.tap()
        let terminal = app.buttons["chat-open-in:terminal"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 3))
        terminal.tap()
        XCTAssertTrue(terminal.waitForNonExistence(timeout: 3))
        XCTAssertEqual(openIn.value as? String, "Herdr terminal")
        turnOn("chat-auto-send")
        XCTAssertTrue(app.staticTexts["phren-agent"].exists)
        back()

        open("settings-terminal-advanced", title: "Advanced")
        let cursor = app.descendants(matching: .any)["terminal-cursor-style"].firstMatch
        XCTAssertTrue(cursor.waitForExistence(timeout: 3))
        cursor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
        turnOn("terminal-keep-screen-on")
        back()

        open("settings-gestures", title: "Gestures")
        let pinch = app.descendants(matching: .any)["gesture-pinch"].firstMatch
        XCTAssertTrue(pinch.waitForExistence(timeout: 3))
        XCTAssertEqual(pinch.value as? String, "On")
        back()

        open("settings-speech", title: "Voice")
        XCTAssertTrue(app.descendants(matching: .any)["voice-mic-button"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["voice-pause"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["voice-reply"].exists)
        // Whisper is opt-in: choosing it offers the download (never starts it)
        // and says Apple is used meanwhile.
        XCTAssertFalse(app.buttons["voice-whisper-download"].exists, "Nothing to download while Apple is the input")
        app.descendants(matching: .any)["voice-input"].firstMatch.tap()
        let whisperOption = app.buttons["voice-input:whisper"]
        XCTAssertTrue(whisperOption.waitForExistence(timeout: 3)); whisperOption.tap()
        let download = app.buttons["voice-whisper-download"]
        XCTAssertTrue(download.waitForExistence(timeout: 3))
        XCTAssertTrue(download.label.contains("632 MB") && download.label.contains("Wi-Fi"), download.label)
        XCTAssertTrue(app.staticTexts["voice-fallback-note"].exists)
        attachUIScreenshot(app, "Voice settings with Whisper chosen")
        app.descendants(matching: .any)["voice-input"].firstMatch.tap()
        let appleOption = app.buttons["voice-input:apple"]
        XCTAssertTrue(appleOption.waitForExistence(timeout: 3)); appleOption.tap()
        XCTAssertTrue(download.waitForNonExistence(timeout: 3))
        let from = app.textFields["speech-replacement-from"]
        for _ in 0..<5 where !(from.exists && from.isHittable) { app.swipeUp() }
        XCTAssertTrue(app.descendants(matching: .any)["speech-language"].exists)
        app.textFields["speech-replacement-from"].tap(); app.textFields["speech-replacement-from"].typeText("fren")
        app.textFields["speech-replacement-to"].tap(); app.textFields["speech-replacement-to"].typeText("phren")
        app.buttons["speech-replacement-add"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["speech-replacement:0"].waitForExistence(timeout: 3))
        back()

        for (id, title) in [("settings-keyboard", "Keyboard"), ("settings-hook", "Phren Hook"), ("settings-notifications", "Notifications"), ("settings-show-on-agents", "Show on Agents")] {
            open(id, title: title); back()
        }

        // Preferences survive a relaunch.
        app.terminate(); app.launch()
        app.tabBars.buttons["Settings"].tap()
        open("settings-terminal-advanced", title: "Advanced")
        let kept = app.descendants(matching: .any)["terminal-keep-screen-on"].firstMatch
        XCTAssertTrue(kept.waitForExistence(timeout: 3))
        XCTAssertTrue(isOn(kept))
        XCTAssertEqual(app.descendants(matching: .any)["terminal-cursor-style"].firstMatch.value as? String, "▁ Underline")
        back()
        open("settings-chat", title: "Chat")
        XCTAssertEqual(app.descendants(matching: .any)["chat-open-in"].firstMatch.value as? String, "Herdr terminal")
        app.buttons["chat-open-in"].tap()
        let chat = app.buttons["chat-open-in:chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 3))
        chat.tap()
    }

    /// The Agents header's extra icons and the screens behind them, with fixture data.
    @MainActor
    func testSimulatorsAndFilesFromTheAgentsHeader() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--native-chat-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let simulators = app.buttons["all-simulators"]
        XCTAssertTrue(simulators.waitForExistence(timeout: 10)); simulators.tap()
        XCTAssertTrue(app.navigationBars["Simulators"].waitForExistence(timeout: 5))
        let row = app.buttons["simulator:11111111-2222-3333-4444-555555555555"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.navigationBars["iPhone 17 Pro"].waitForExistence(timeout: 5))
        // The screen takes touches; the toolbar sends keys and launches apps.
        let screen = app.descendants(matching: .any)["simulator-screen"].firstMatch
        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        screen.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        app.buttons["simulator-home"].tap()
        app.buttons["simulator-apps"].tap()
        XCTAssertTrue(app.buttons["Phren"].waitForExistence(timeout: 3)); app.buttons["Phren"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["simulator-message"].exists)
        // Replacing alerts with sheets requires explicit dismissal for both
        // cancellation and submission. Reopening also starts with empty input.
        for submit in [false, true] {
            app.buttons["simulator-type"].tap()
            let field = app.textFields["simulator-type-field"]
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            XCTAssertEqual(field.value as? String, "Text")
            field.tap(); field.typeText("hello")
            app.navigationBars["Type into the simulator"].buttons[submit ? "Type" : "Cancel"].tap()
            XCTAssertTrue(field.waitForNonExistence(timeout: 5))

            app.buttons["simulator-apps"].tap()
            let openURL = app.buttons["simulator-apps-sheet:open-url"]
            XCTAssertTrue(openURL.waitForExistence(timeout: 5)); openURL.tap()
            let url = app.textFields["simulator-url-field"]
            XCTAssertTrue(url.waitForExistence(timeout: 5))
            XCTAssertEqual(url.value as? String, "https://")
            url.tap(); url.typeText("https://example.com")
            app.navigationBars["Open a URL in the simulator"].buttons[submit ? "Open" : "Cancel"].tap()
            XCTAssertTrue(url.waitForNonExistence(timeout: 5))
        }
        app.navigationBars.buttons.firstMatch.tap(); app.navigationBars.buttons.firstMatch.tap()
        let files = app.buttons["all-files"]
        XCTAssertTrue(files.waitForExistence(timeout: 5)); files.tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["files-row:design.pdf"].waitForExistence(timeout: 5))
    }
}
