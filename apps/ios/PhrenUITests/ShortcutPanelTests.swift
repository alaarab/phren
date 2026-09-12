import XCTest

final class ShortcutPanelTests: XCTestCase {
    @MainActor
    func testPanelSettingsAndCustomBindingPersistAndDriveCtrlHoldPanel() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "--terminal-controls-fixture"]
        app.launch()
        openSettings(app)
        reset(app)
        app.buttons["panel-toggle:codex"].tap()
        XCTAssertEqual(app.buttons["panel-toggle:codex"].label, "Enable Codex")
        app.buttons["panel-edit:favorites"].tap()
        app.buttons["shortcut-add"].tap()
        XCTAssertTrue(app.navigationBars["New Shortcut"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["shortcut-save"].isEnabled)
        app.buttons["shortcut-advanced"].tap()
        let binding = app.textFields["shortcut-binding"]
        binding.tap(); binding.typeText("C-b, S-t")
        let label = app.textFields["shortcut-label"]
        label.tap(); label.typeText("Window test")
        let icon = app.buttons["shortcut-icon:bolt"]
        scrollTo(icon, app); icon.tap()
        capture(app, "Custom key binding with icon")
        app.buttons["shortcut-save"].tap()
        XCTAssertTrue(app.navigationBars["Favorites"].waitForExistence(timeout: 5))
        let edit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "shortcut-edit:", "Window test")).firstMatch
        XCTAssertTrue(edit.exists)
        app.buttons["Disable Window test"].tap()
        XCTAssertTrue(app.buttons["Enable Window test"].exists)
        app.buttons["Enable Window test"].tap()
        capture(app, "Editable Favorites shortcuts")
        app.terminate(); app.launch()
        openSettings(app)
        XCTAssertEqual(app.buttons["panel-toggle:codex"].label, "Enable Codex")
        app.buttons["panel-edit:favorites"].tap()
        XCTAssertTrue(edit.waitForExistence(timeout: 5)); edit.tap()
        XCTAssertEqual(app.textFields["shortcut-binding"].value as? String, "C-b, S-t")
        XCTAssertEqual(app.textFields["shortcut-label"].value as? String, "Window test")
        app.buttons["Cancel"].tap()
        app.tabBars.buttons["Agents"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test Mac,")).firstMatch.tap()
        app.buttons["Herdr workspaces & terminal"].tap()
        app.buttons["Open Herdr terminal"].tap()
        XCTAssertTrue(app.staticTexts["terminal-fixture-report"].waitForExistence(timeout: 8))
        app.buttons["Ctrl"].press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Favorites shortcuts"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Codex shortcuts"].exists)
        app.buttons["Favorites shortcuts"].tap()
        let custom = app.buttons.matching(NSPredicate(format: "label == %@", "Window test")).firstMatch
        XCTAssertTrue(custom.waitForExistence(timeout: 5)); custom.tap()
        struct Report: Decodable { let input: String }
        let report = try JSONDecoder().decode(Report.self, from: Data(app.staticTexts["terminal-fixture-report"].label.utf8))
        XCTAssertEqual(report.input, "\u{02}T", "The two-step binding sends exact bytes without Enter")
        capture(app, "Customized Ctrl hold panel")
        app.buttons["Terminal gestures"].tap()
        app.buttons["terminal-customize-shortcuts"].tap()
        XCTAssertTrue(app.navigationBars["Shortcuts"].waitForExistence(timeout: 5))
        reset(app)
        app.buttons["Done"].tap()
        app.buttons["Close shortcuts"].tap()
        XCTAssertEqual(app.buttons["Ctrl"].value as? String, "Off")
    }

    @MainActor
    func testNamedKeyBuilderCombinesModifiersAndCanCancelWithoutSaving() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture"]
        app.launch(); openSettings(app); reset(app)
        app.buttons["panel-edit:favorites"].tap()
        app.buttons["shortcut-add"].tap()
        app.buttons["shortcut-modifier:Ctrl"].tap()
        app.buttons["shortcut-modifier:Opt"].tap()
        app.buttons["shortcut-key:Right"].tap()
        XCTAssertEqual(app.staticTexts["shortcut-preview"].label, "Ctrl+Opt+Right")
        XCTAssertTrue(app.buttons["shortcut-save"].isEnabled)
        capture(app, "Modifiers and named key editor")
        app.buttons["Cancel"].tap()
        XCTAssertFalse(app.staticTexts["Ctrl+Opt+Right"].exists)
    }

    @MainActor private func openSettings(_ app: XCUIApplication) {
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-terminal-shortcuts"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.navigationBars["Shortcuts"].waitForExistence(timeout: 5))
    }
    @MainActor private func reset(_ app: XCUIApplication) {
        let button = app.buttons["shortcuts-reset-all"]
        scrollTo(button, app); button.tap()
        for _ in 0..<5 { app.swipeDown() }
    }
    @MainActor private func scrollTo(_ element: XCUIElement, _ app: XCUIApplication) {
        for _ in 0..<10 where !element.isHittable { app.swipeUp() }
        XCTAssertTrue(element.isHittable)
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
