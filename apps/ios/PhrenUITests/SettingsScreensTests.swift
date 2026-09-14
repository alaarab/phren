import XCTest

final class SettingsScreensTests: XCTestCase {
    /// The regrouped Settings and each new screen: fonts, chat, advanced,
    /// gestures, speech — every control reachable and persisting.
    @MainActor
    func testTerminalInputAndSpeechScreens() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Settings"].tap()
        func open(_ id: String, title: String) {
            let row = app.descendants(matching: .any).matching(identifier: id).firstMatch
            for _ in 0..<4 where !row.exists || !row.isHittable { app.swipeUp() }
            XCTAssertTrue(row.waitForExistence(timeout: 5), id); row.tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), title)
        }
        // The value comes back as "1" or 1 depending on the element; poll it.
        func isOn(_ element: XCUIElement) -> Bool {
            for _ in 0..<25 { if String(describing: element.value ?? "") == "1" { return true }; Thread.sleep(forTimeInterval: 0.2) }
            return false
        }
        // A SwiftUI Toggle's centre is its label; the switch sits at the trailing
        // edge, and its value follows the animation.
        func turnOn(_ id: String) {
            let toggle = app.switches[id]
            XCTAssertTrue(toggle.waitForExistence(timeout: 3), id)
            // The row is the identified switch; the control is its inner switch.
            // The inner control usually takes the tap; when the hit lands on
            // the row instead, a second tap at the switch's edge does.
            let control = toggle.switches.firstMatch
            control.tap()
            var on = false
            for _ in 0..<10 where !on { Thread.sleep(forTimeInterval: 0.2); on = String(describing: control.value ?? "") == "1" || String(describing: toggle.value ?? "") == "1" }
            if !on { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap() }
            XCTAssertTrue(isOn(control) || isOn(toggle), id)
        }
        func back() { app.navigationBars.buttons.firstMatch.tap(); for _ in 0..<3 where !app.descendants(matching: .any)["settings-theme"].exists { app.swipeDown() } }

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
        XCTAssertTrue(app.descendants(matching: .any)["terminal-cursor-style"].waitForExistence(timeout: 3))
        app.buttons["▁ Underline"].tap()
        turnOn("terminal-keep-screen-on")
        back()

        open("settings-gestures", title: "Gestures")
        let pinch = app.switches["gesture-pinch"]
        XCTAssertTrue(pinch.waitForExistence(timeout: 3))
        XCTAssertEqual(pinch.value as? String, "1")
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
        let kept = app.switches["terminal-keep-screen-on"]
        XCTAssertTrue(kept.waitForExistence(timeout: 3))
        XCTAssertTrue(isOn(kept.switches.firstMatch))
        XCTAssertTrue(app.buttons["▁ Underline"].isSelected)
    }

    /// The Agents header's extra icons and the screens behind them, with fixture data.
    @MainActor
    func testSimulatorsAndFilesFromTheAgentsHeader() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--native-chat-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
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
