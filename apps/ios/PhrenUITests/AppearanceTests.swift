import XCTest

final class AppearanceTests: XCTestCase {
    @MainActor
    func testThemesApplyAndPersistWithoutLosingChatDraft() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "--chat-design"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let session = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w7:w7:t9"]
        XCTAssertTrue(session.waitForExistence(timeout: 8)); session.tap()
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Keep my draft across themes")
        app.buttons["chat-close"].tap()
        openThemes(app)
        for style in ["graphite", "slate", "amethyst", "midnight"] {
            let choice = app.buttons["theme-\(style)"]
            for _ in 0..<4 where !choice.isHittable { app.scrollViews.firstMatch.swipeUp() }
            if !choice.isHittable { app.scrollViews.firstMatch.swipeDown(velocity: .fast) }
            XCTAssertTrue(choice.isHittable)
            choice.tap()
            XCTAssertEqual(choice.value as? String, "Selected")
            attachUIScreenshot(app, "Theme \(style)")
        }
        app.tabBars.buttons["Agents"].tap()
        session.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertEqual(composer.value as? String, "Keep my draft across themes")
        attachUIScreenshot(app, "Charcoal chat")
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        openThemes(app)
        XCTAssertEqual(app.buttons["theme-midnight"].value as? String, "Selected")
    }

    @MainActor
    func testCustomColorsPreviewSaveEditAndSurviveRelaunch() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        openThemes(app)
        app.buttons["theme-create"].tap()
        let name = app.textFields["theme-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        let swatch = app.buttons["theme-color-swatch-background"]
        XCTAssertTrue(swatch.waitForExistence(timeout: 3))
        for _ in 0..<4 where !swatch.isHittable { app.swipeUp() }
        let background = app.textFields["theme-color-background"]
        let originalHex = background.value as? String ?? ""
        guard let originalValue = UInt32(originalHex, radix: 16) else {
            XCTFail("The color field should contain a valid hex value"); return
        }
        swatch.tap()
        let decreaseRed = app.buttons["theme-color-editor:red:minus"]
        let increaseRed = app.buttons["theme-color-editor:red:plus"]
        XCTAssertTrue(increaseRed.waitForExistence(timeout: 3))
        let increase = increaseRed.isEnabled
        (increase ? increaseRed : decreaseRed).tap()
        let closeColor = app.buttons["theme-color-editor-done"]
        closeColor.tap()
        XCTAssertTrue(closeColor.waitForNonExistence(timeout: 3))
        let expectedValue = increase ? originalValue + 0x010000 : originalValue - 0x010000
        XCTAssertEqual(background.value as? String, String(format: "%06X", expectedValue))
        for _ in 0..<4 where !name.isHittable { app.swipeDown() }
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (name.value as? String ?? "").count) + "Ocean test")
        app.swipeUp()
        background.tap()
        background.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + "24303B")
        XCTAssertEqual(background.value as? String, "24303B")
        app.buttons["theme-save"].tap()
        let saved = app.buttons.matching(NSPredicate(format: "label == %@", "Ocean test. Custom palette")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        XCTAssertEqual(saved.value as? String, "Selected")
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        openThemes(app)
        XCTAssertEqual(saved.value as? String, "Selected")
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "theme-edit-")).firstMatch.tap()
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        app.swipeUp()
        XCTAssertEqual(background.value as? String, "24303B")
        attachUIScreenshot(app, "Custom theme colors")
        app.buttons["Cancel"].tap()
        saved.press(forDuration: 1)
        app.buttons["Delete theme"].tap()
        XCTAssertFalse(saved.exists)
    }

    @MainActor private func openThemes(_ app: XCUIApplication) {
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-theme"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.buttons["theme-midnight"].waitForExistence(timeout: 5))
    }
}
