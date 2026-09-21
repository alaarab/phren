import XCTest

final class AllSessionsTests: XCTestCase {
    private let mac = "A1000000-0000-0000-0000-000000000001"
    private let linux = "A1000000-0000-0000-0000-000000000002"

    @MainActor
    func testFocusFilterFixtureScopesSessionsAndCanBeCleared() {
        let app = launch(extra: ["--focus-filter-fixture"])
        XCTAssertTrue(app.staticTexts["agents-focus-filter"].waitForExistence(timeout: 10))
        XCTAssertFalse(row(app, host: mac).exists)
        XCTAssertTrue(row(app, host: linux).exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Computers")).firstMatch.exists, "Computers must appear in the same reveal as the cards")
        app.buttons["agents-focus-clear"].tap()
        XCTAssertTrue(row(app, host: mac).waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["agents-focus-filter"].exists)
    }

    @MainActor
    func testInitialOverviewRevealsTogetherAfterTheSlowerComputerResponds() {
        let app = launch(extra: ["--all-sessions-delayed", "--overview-disk-cache", "--overview-cache-expired"])
        let loading = app.descendants(matching: .any).matching(identifier: "agents-loading").firstMatch
        XCTAssertTrue(loading.exists)
        XCTAssertFalse(row(app, host: mac).exists, "The fast host must not appear as a partial page")
        XCTAssertFalse(section(app, title: "Computers").exists, "Computer management must join the same first reveal")
        XCTAssertFalse(section(app, title: "Working").exists, "No session section may appear before the batch is ready")
        XCTAssertFalse(app.staticTexts["Connecting your sessions"].exists)
        XCTAssertFalse(app.buttons["Add computer"].exists)
        XCTAssertTrue(row(app, host: mac).waitForExistence(timeout: 8))
        XCTAssertTrue(row(app, host: linux).exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Computers")).firstMatch.exists, "Computers must appear in the same reveal as the cards")
        XCTAssertFalse(loading.exists)
        capture(app, "Complete overview after coordinated loading")
    }

    @MainActor
    func testFreshDiskCacheRevealsCardsAndComputersWhileRefreshingBehindThem() {
        let app = launch(extra: ["--all-sessions-delayed", "--overview-disk-cache", "--overview-cache-fresh"])
        XCTAssertTrue(row(app, host: mac).waitForExistence(timeout: 2))
        XCTAssertTrue(row(app, host: linux).exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Computers")).firstMatch.exists)
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "agents-loading").firstMatch.exists)
        capture(app, "Complete cached sessions screen")
    }

    @MainActor
    func testSessionCardsShowReportedRelativeTime() {
        let app = launch(extra: ["--session-relative-time-fixture"])
        let time = app.staticTexts["overview-changed:\(mac):herdr:default:w1:w1:t1"]
        XCTAssertTrue(time.waitForExistence(timeout: 10))
        XCTAssertEqual(time.label, "· 2m ago")
        capture(app, "Session activity times")
    }

    @MainActor
    func testOverviewOpensTheRightComputerWithCollidingWorkspaceAndTabIDs() {
        let app = launch(extra: ["--all-sessions-change"])
        let first = row(app, host: mac), second = row(app, host: linux)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertTrue(first.isHittable); XCTAssertTrue(second.isHittable)
        XCTAssertLessThan(first.frame.minY, second.frame.minY)
        XCTAssertLessThanOrEqual(first.frame.height, 68)
        capture(app, "Sessions across two computers")
        first.tap()
        XCTAssertTrue(app.staticTexts["chat-location"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Test Mac · Shared project"))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertEqual(app.keyboards.count, 0)
        composer.tap(); composer.typeText("Overview Mac only")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Received in codex on w1:p1: Overview Mac only"].waitForExistence(timeout: 8))
        // The next overview poll moves this row from Working to Done. The
        // conversation must remain presented even though its row moved groups.
        Thread.sleep(forTimeInterval: 11)
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Test Mac · Shared project"))
        app.buttons["chat-close"].tap()
        XCTAssertTrue(second.waitForExistence(timeout: 5))
        XCTAssertFalse(indicator(app, kind: "running", host: mac).exists, "A finished session must stop animating")
        second.tap()
        XCTAssertTrue(app.staticTexts["chat-location"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Test Linux · Shared project"))
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["Overview Mac only"].exists)
        app.buttons["chat-close"].tap()
        app.buttons["overview-detail:\(linux):herdr:default:w1:w1:t1"].tap()
        XCTAssertTrue(app.navigationBars["Session details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Review Linux deployment"].exists)
        app.navigationBars["Session details"].buttons.element(boundBy: 0).tap()
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(first.waitForExistence(timeout: 10)); XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["all-web-servers"].exists)
    }

    @MainActor
    func testCompactCardsStaySeparateAndShowOnlyReportedContextAndActiveWork() {
        let app = launch()
        let working = row(app, host: mac), waiting = row(app, host: linux)
        XCTAssertTrue(working.waitForExistence(timeout: 10))
        XCTAssertTrue(waiting.waitForExistence(timeout: 10))
        // The ring names the harness and the state; context used is its value.
        let known = indicator(app, kind: "context", host: mac)
        XCTAssertTrue(known.exists)
        XCTAssertEqual(known.label, "Codex, Working")
        XCTAssertEqual(known.value as? String, "context 37%")
        XCTAssertEqual(indicator(app, kind: "context", host: linux).value as? String, "context 62%")
        XCTAssertTrue(indicator(app, kind: "running", host: mac).exists)
        // Waiting for input gets the edge bar too: it is the one that needs you.
        XCTAssertTrue(indicator(app, kind: "running", host: linux).exists)
        XCTAssertLessThanOrEqual(working.frame.height, 76)
        XCTAssertLessThanOrEqual(waiting.frame.height, 76)

        let linuxIdle = row(app, host: linux, tab: "w1:t2")
        let macIdle = row(app, host: mac, tab: "w1:t2")
        if !macIdle.isHittable { app.collectionViews.firstMatch.swipeUp() }
        XCTAssertTrue(linuxIdle.exists); XCTAssertTrue(macIdle.exists)
        XCTAssertGreaterThanOrEqual(macIdle.frame.minY - linuxIdle.frame.maxY, 6,
                                   "Cards in the same section need visible space between them")
        for host in [mac, linux] {
            XCTAssertLessThanOrEqual(row(app, host: host, tab: "w1:t2").frame.height, 76)
            XCTAssertEqual(indicator(app, kind: "context", host: host, tab: "w1:t2").value as? String, "")
            XCTAssertFalse(indicator(app, kind: "running", host: host, tab: "w1:t2").exists)
            let pin = pin(app, host: host, tab: "w1:t2")
            XCTAssertEqual(pin.label, "Pin session")
            // Frames land on subpixel offsets; 43.99 is a 44-point target.
            XCTAssertGreaterThanOrEqual(pin.frame.height, 43.5)
            XCTAssertGreaterThanOrEqual(pin.frame.width, 43.5)
        }
        capture(app, "Separate compact cards with reported and unavailable context")
    }

    @MainActor
    func testPinningUsesTheRightComputerPersistsAndKeepsOfflineChatsDisabled() {
        var app = launch()
        XCTAssertTrue(row(app, host: linux).waitForExistence(timeout: 10))
        pin(app, host: linux).tap()
        XCTAssertTrue(section(app, title: "Pinned").waitForExistence(timeout: 5))
        XCTAssertEqual(pin(app, host: linux).label, "Unpin session")
        XCTAssertEqual(pin(app, host: mac).label, "Pin session")
        XCTAssertLessThan(row(app, host: linux).frame.minY, section(app, title: "Working").frame.minY)
        XCTAssertLessThan(section(app, title: "Working").frame.minY, row(app, host: mac).frame.minY)

        app.terminate()
        app = launch(resetPins: false)
        XCTAssertTrue(row(app, host: linux).waitForExistence(timeout: 10))
        XCTAssertTrue(section(app, title: "Pinned").exists)
        XCTAssertEqual(pin(app, host: linux).label, "Unpin session")
        pin(app, host: linux).tap()
        XCTAssertTrue(section(app, title: "Needs input").waitForExistence(timeout: 5))
        XCTAssertFalse(section(app, title: "Pinned").exists)
        XCTAssertLessThan(row(app, host: mac).frame.minY, row(app, host: linux).frame.minY)

        app.terminate()
        app = launch(extra: ["--all-sessions-offline"], resetPins: false)
        let live = row(app, host: mac), offline = row(app, host: linux)
        XCTAssertTrue(offline.waitForExistence(timeout: 10))
        XCTAssertFalse(section(app, title: "Pinned").exists, "Unpinning must persist across launches")
        XCTAssertEqual(pin(app, host: linux).label, "Pin session")
        pin(app, host: linux).tap()
        XCTAssertTrue(section(app, title: "Pinned").waitForExistence(timeout: 5))
        app.buttons["Refresh all sessions"].tap()
        let disabled = NSPredicate(format: "enabled == false")
        expectation(for: disabled, evaluatedWith: offline)
        waitForExpectations(timeout: 15)
        XCTAssertTrue(live.isEnabled)
        XCTAssertTrue(section(app, title: "Pinned").exists)
        XCTAssertEqual(pin(app, host: linux).label, "Unpin session")
        capture(app, "Pinned offline session remains unavailable for chat")
    }

    @MainActor
    func testSearchAcrossComputersAndOfflineRowsDoNotDisableTheOtherComputer() {
        let app = launch(extra: ["--all-sessions-offline"])
        let first = row(app, host: mac), second = row(app, host: linux)
        XCTAssertTrue(first.waitForExistence(timeout: 10)); XCTAssertTrue(second.waitForExistence(timeout: 10))
        let search = app.searchFields.firstMatch
        if !search.isHittable { app.collectionViews.firstMatch.swipeDown() }
        search.tap(); search.typeText("Test Linux")
        XCTAssertTrue(second.waitForExistence(timeout: 5)); XCTAssertFalse(first.exists)
        let clear = search.buttons.firstMatch
        if clear.exists { clear.tap() } else { search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 10)) }
        if app.buttons["Close"].exists { app.buttons["Close"].tap() }
        else { app.buttons["Cancel"].tap() }
        app.buttons["Refresh all sessions"].tap()
        let lastSeen = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Last seen")).firstMatch
        XCTAssertTrue(lastSeen.waitForExistence(timeout: 15))
        XCTAssertTrue(first.isEnabled); XCTAssertFalse(second.isEnabled)
        capture(app, "One offline computer leaves the other sessions live")
        first.tap()
        XCTAssertTrue(app.staticTexts["chat-location"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["chat-location"].label.contains("Test Mac · Shared project"))
    }

    @MainActor
    func testEmptyOverviewKeepsComputerAndWebControlsAvailable() {
        let app = launch(extra: ["--all-sessions-empty"])
        XCTAssertTrue(app.staticTexts["No sessions running on the connected computers"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["all-web-servers"].isHittable)
        XCTAssertTrue(app.buttons["live-host:\(mac)"].exists)
        XCTAssertTrue(app.buttons["Add computer"].exists)
    }

    /// Swipe → Close on a card closes that tab, not its neighbour, and the
    /// card leaves without a manual refresh; the other computer's identical
    /// tab ids are untouched.
    @MainActor
    func testClosingFromTheListRemovesExactlyThatCardAtOnce() {
        let app = launch()
        let target = row(app, host: mac, tab: "w1:t2"), neighbour = row(app, host: mac, tab: "w1:t1"), other = row(app, host: linux, tab: "w1:t2")
        XCTAssertTrue(target.waitForExistence(timeout: 15)); XCTAssertTrue(neighbour.exists); XCTAssertTrue(other.exists)
        target.swipeLeft()
        let close = app.buttons["overview-close:\(mac):herdr:default:w1:w1:t2"]
        XCTAssertTrue(close.waitForExistence(timeout: 5)); close.tap()
        XCTAssertTrue(target.waitForNonExistence(timeout: 3), "The closed card leaves without a refresh")
        XCTAssertTrue(neighbour.exists, "The neighbour stays"); XCTAssertTrue(other.exists, "The other computer's tab with the same id stays")
        capture(app, "Closed from the list")
    }

    /// Hold → Close tab confirms first, naming the held tab, then that card
    /// leaves at once.
    @MainActor
    func testClosingFromTheMenuConfirmsThenRemovesThatCard() {
        let app = launch()
        let target = row(app, host: mac, tab: "w1:t2"), neighbour = row(app, host: mac, tab: "w1:t1")
        XCTAssertTrue(target.waitForExistence(timeout: 15))
        target.press(forDuration: 1.2)
        let close = app.buttons["Close tab"]
        XCTAssertTrue(close.waitForExistence(timeout: 5)); close.tap()
        let confirm = app.buttons["Close tab"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Check project status")).firstMatch.exists, "The dialog names the held tab")
        confirm.tap()
        XCTAssertTrue(target.waitForNonExistence(timeout: 3))
        XCTAssertTrue(neighbour.exists, "The neighbour stays")
    }

    /// Hold → the row can be relinked to a project even when a folder already
    /// matched one (the match can be wrong), and the Herdr workspace renamed.
    @MainActor
    func testHoldMenuOffersProjectLinkAndWorkspaceRename() {
        let app = launch()
        let target = row(app, host: mac, tab: "w1:t2")
        XCTAssertTrue(target.waitForExistence(timeout: 15))
        target.press(forDuration: 1.2)
        let link = app.buttons["Link to project"].exists ? app.buttons["Link to project"] : app.buttons["Change project"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        let rename = app.buttons["Rename workspace"]
        XCTAssertTrue(rename.exists)
        rename.tap()
        XCTAssertTrue(app.alerts["Rename workspace"].waitForExistence(timeout: 5))
        let field = app.alerts["Rename workspace"].textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertFalse((field.value as? String ?? "").isEmpty, "The field starts with the current workspace name")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(field.waitForNonExistence(timeout: 3))
        target.press(forDuration: 1.2)
        XCTAssertTrue(link.waitForExistence(timeout: 5)); link.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "live-project:")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Relink a session from the hold menu")
    }

    @MainActor
    private func launch(extra: [String] = [], resetPins: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--all-sessions-fixture", "--native-chat-fixture"]
            + (resetPins ? ["--session-pins-reset"] : []) + extra
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        return app
    }
    @MainActor
    private func row(_ app: XCUIApplication, host: String, tab: String = "w1:t1") -> XCUIElement {
        app.buttons["overview-chat:\(host):herdr:default:w1:\(tab)"]
    }
    @MainActor
    private func pin(_ app: XCUIApplication, host: String, tab: String = "w1:t1") -> XCUIElement {
        app.buttons["overview-pin:\(host):herdr:default:w1:\(tab)"]
    }
    @MainActor
    private func indicator(_ app: XCUIApplication, kind: String, host: String, tab: String = "w1:t1") -> XCUIElement {
        // The ring is the details button now; its label and value describe the state and context.
        let name = kind == "context" ? "detail" : kind
        return app.descendants(matching: .any).matching(identifier: "overview-\(name):\(host):herdr:default:w1:\(tab)").firstMatch
    }
    @MainActor
    private func section(_ app: XCUIApplication, title: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@", title + " · ")).firstMatch
    }
    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}
