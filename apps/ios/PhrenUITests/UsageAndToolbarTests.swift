import XCTest

final class UsageAndToolbarTests: XCTestCase {
    @MainActor
    func testUsageShowsBothProvidersPercentagesAndResetTimes() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--account-usage-fixture", "--usage-delayed"]
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let usage = app.buttons["all-account-usage"]
        XCTAssertTrue(usage.waitForExistence(timeout: 10)); usage.tap()
        XCTAssertTrue(app.staticTexts["Codex"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Claude"].exists)
        XCTAssertTrue(app.staticTexts["OpenCode"].exists)
        XCTAssertTrue(app.staticTexts["OpenCode Go"].exists)
        XCTAssertTrue(app.staticTexts["OpenRouter"].exists)
        XCTAssertTrue(app.staticTexts["$4.39"].exists)
        XCTAssertTrue(app.staticTexts["$1.20 · $4.80 · $9.10"].exists)
        XCTAssertTrue(app.staticTexts["$5.08"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "23.5%")).count, 1)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "41.2%")).count, 1)
        XCTAssertTrue(app.staticTexts["40%"].exists)
        XCTAssertTrue(app.staticTexts["16%"].exists)
        XCTAssertTrue(app.staticTexts["18%"].exists)
        XCTAssertTrue(app.staticTexts["7-day, all models"].exists)
        XCTAssertTrue(app.staticTexts["7-day, Fable"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "resets in ")).firstMatch.exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "5-hour")).count, 2, "Windows are one short line each")
        XCTAssertTrue(app.buttons["Refresh usage"].isHittable)
        capture(app, "Claude and Codex account usage")
        app.navigationBars["Account usage"].buttons.element(boundBy: 0).tap()
        usage.tap()
        XCTAssertTrue(app.staticTexts["Codex"].exists, "A cached report must render immediately on reopen")
        XCTAssertFalse(app.progressIndicators["Reading account limits…"].exists)
        capture(app, "Account usage reopened from cache")
    }

    @MainActor
    /// The usage rings live on the Sessions tab, one per provider in use,
    /// and open Account usage; the chat header no longer carries them.
    func testSessionsUsageRingsShowEachProviderAndPushAccountUsage() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--all-sessions-fixture", "--native-chat-fixture", "--account-usage-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8)); app.tabBars.buttons["Agents"].tap()
        let rings = app.buttons["all-account-usage"]
        XCTAssertTrue(rings.waitForExistence(timeout: 10))
        let reported = NSPredicate(format: "value CONTAINS %@", "%")
        expectation(for: reported, evaluatedWith: rings)
        waitForExpectations(timeout: 8)
        let headerPrimary = rings.value as? String
        XCTAssertEqual(headerPrimary, "Claude 40%")
        capture(app, "Sessions tab with usage rings")
        rings.tap()
        XCTAssertTrue(app.navigationBars["Account usage"].waitForExistence(timeout: 5))
        let usagePrimary = app.descendants(matching: .any)["usage-primary-window:claude"]
        XCTAssertTrue(usagePrimary.waitForExistence(timeout: 5))
        XCTAssertEqual(usagePrimary.value as? String, headerPrimary)
        app.navigationBars["Account usage"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(rings.waitForExistence(timeout: 5))
        let chat = app.buttons["overview-chat:A1000000-0000-0000-0000-000000000001:herdr:default:w1:w1:t1"]
        XCTAssertTrue(chat.waitForExistence(timeout: 10)); chat.tap()
        XCTAssertTrue(app.buttons["chat-close"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat-usage-rings"].exists)
    }

    @MainActor
    func testTerminalControlsCanBeAddedAndPersistAcrossLaunches() {
        let app = XCUIApplication()
        // The defaults fill every slot (Chat and Agents took the last two);
        // the fixture leaves one free so there is something to add.
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--toolbar-with-room"]
        app.launch()
        openToolbar(app)
        let add = app.buttons["toolbar-add:enter"]
        scrollTo(add, in: app)
        XCTAssertTrue(add.isEnabled); add.tap()
        let selected = app.descendants(matching: .any).matching(identifier: "toolbar-selected:enter").firstMatch
        XCTAssertTrue(selected.exists)
        app.terminate(); app.launch()
        openToolbar(app)
        XCTAssertTrue(selected.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "toolbar-selected:keyboard").firstMatch.exists)
        capture(app, "Custom terminal toolbar")
        restoreDefaults(app)
        XCTAssertFalse(selected.exists)
    }

    @MainActor private func openToolbar(_ app: XCUIApplication) {
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-terminal-toolbar"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.navigationBars["Terminal toolbar"].waitForExistence(timeout: 5))
    }
    @MainActor private func restoreDefaults(_ app: XCUIApplication) {
        let restore = app.buttons["toolbar-restore-defaults"]
        scrollTo(restore, in: app); restore.tap()
        for _ in 0..<5 { app.swipeDown() }
    }
    @MainActor private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<10 where !element.isHittable { app.swipeUp() }
        XCTAssertTrue(element.isHittable)
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}
