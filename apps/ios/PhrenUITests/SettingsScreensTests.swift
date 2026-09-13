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
        // A SwiftUI Toggle's centre is its label; the switch sits at the trailing
        // edge, and its value follows the animation.
        func turnOn(_ id: String) {
            let toggle = app.switches[id]
            XCTAssertTrue(toggle.waitForExistence(timeout: 3), id)
            // The row is the identified switch; the control is its inner switch.
            let control = toggle.switches.firstMatch
            control.tap()
            expectation(for: NSPredicate(format: "value == '1'"), evaluatedWith: control)
            waitForExpectations(timeout: 5)
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

        // Preferences survive a relaunch.
        app.terminate(); app.launch()
        app.tabBars.buttons["Settings"].tap()
        open("settings-terminal-advanced", title: "Advanced")
        let kept = app.switches["terminal-keep-screen-on"]
        XCTAssertTrue(kept.waitForExistence(timeout: 3))
        expectation(for: NSPredicate(format: "value == '1'"), evaluatedWith: kept.switches.firstMatch); waitForExpectations(timeout: 5)
        XCTAssertTrue(app.buttons["▁ Underline"].isSelected)
    }
}
