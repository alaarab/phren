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
        let stepper = app.steppers["font-size-stepper"]
        XCTAssertTrue(stepper.waitForExistence(timeout: 3))
        stepper.buttons.element(boundBy: 1).tap()
        XCTAssertTrue(app.staticTexts["font-sample"].exists)
        XCTAssertTrue(app.buttons["font-choice:system"].exists)
        XCTAssertTrue(app.buttons["font-download:JetBrainsMono-Regular.ttf"].exists)
        XCTAssertTrue(app.buttons["font-import"].exists)
        back()

        open("settings-chat", title: "Chat")
        XCTAssertTrue(app.descendants(matching: .any)["chat-open-in"].waitForExistence(timeout: 3))
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

        open("settings-speech", title: "Speech")
        XCTAssertTrue(app.descendants(matching: .any)["speech-language"].waitForExistence(timeout: 3))
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
        app.navigationBars.buttons.firstMatch.tap(); app.navigationBars.buttons.firstMatch.tap()
        let files = app.buttons["all-files"]
        XCTAssertTrue(files.waitForExistence(timeout: 5)); files.tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["files-row:design.pdf"].waitForExistence(timeout: 5))
    }
}
