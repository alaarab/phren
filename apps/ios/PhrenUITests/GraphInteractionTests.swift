import XCTest

final class GraphInteractionTests: XCTestCase {
    @MainActor
    func testSelectedNodeCentersAboveDossierAtDifferentZooms() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        _ = openDossier(in: app)
        let dossier = nodeDetails(in: app)
        // The page's DOM id is not a native accessibility identifier.
        // WebKit exposes this projection marker as an image with its aria-label.
        let projectedNode = app.webViews.images.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Selected finding: ")
        ).firstMatch
        XCTAssertTrue(dossier.waitForExistence(timeout: 5))
        XCTAssertTrue(projectedNode.waitForExistence(timeout: 5), "selected sprite exposes its projected frame")
        let canvas = app.webViews.firstMatch
        let firstFinding = "Cache repeated requests for offline use"
        let actions: [(String?, String)] = [
            (nil, firstFinding),
            ("Zoom in", firstFinding),
            ("Zoom out", firstFinding),
            ("Next node", "Retry sync after reconnecting"),
            ("Next node", "Connect the phone graph to desktop memory")
        ]
        for (action, finding) in actions {
            if let action { app.buttons[action].tap() }
            let centered = NSPredicate { _, _ in
                guard projectedNode.exists, dossier.exists,
                      projectedNode.label == "Selected finding: \(finding)" else { return false }
                let freeCenter = (canvas.frame.minY + dossier.frame.minY - 24) / 2
                return abs(projectedNode.frame.midY - freeCenter) < 6
                    && abs(projectedNode.frame.midX - canvas.frame.midX) < 6
                    && projectedNode.frame.maxY <= dossier.frame.minY - 24
            }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: centered, object: nil)], timeout: 5), .completed,
                           "selected node centers in the free space with a gap above the dossier")
            XCTAssertLessThanOrEqual(dossier.frame.maxY, app.tabBars.firstMatch.frame.minY + 1)
        }
        capture(app, name: "Selected node above dossier")
    }

    /// Focus narrows the map to the node's neighbourhood, which lays the graph
    /// out again. The camera must end on the focused node, so a tap at the
    /// middle of the canvas selects that node and not a neighbour or nothing.
    @MainActor
    func testFocusLandsOnTheFocusedNode() {
        let app = XCUIApplication()
        // Three projects, so the one-project neighbourhood lays out elsewhere.
        app.launchArguments = ["--ui-testing", "--memory-fixture"]
        app.launch()
        openMemoryGraph(from: app)
        let canvas = app.webViews.firstMatch
        XCTAssertTrue(canvas.staticTexts["LEDGER"].firstMatch.waitForExistence(timeout: 20))
        app.buttons["memory-search-toggle"].tap()
        let field = app.textFields["memory-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Webhook signatures\n")
        let dossier = nodeDetails(in: app)
        XCTAssertTrue(dossier.waitForExistence(timeout: 5))
        let focus = app.webViews.buttons["Focus"]
        XCTAssertTrue(focus.waitForExistence(timeout: 5))
        focus.tap()
        XCTAssertTrue(dossier.waitForNonExistence(timeout: 5), "Focus closes the dossier")
        // Let the reveal flight and the neighbourhood's relayout finish.
        Thread.sleep(forTimeInterval: 2)
        capture(app, name: "Focused node")

        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let projectedNode = app.webViews.images.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Selected finding: ")
        ).firstMatch
        XCTAssertTrue(dossier.waitForExistence(timeout: 5), "tapping the middle of the map selects the focused node")
        XCTAssertTrue(projectedNode.waitForExistence(timeout: 5))
        XCTAssertTrue(projectedNode.label.contains("Webhook signatures"), "selected \(projectedNode.label)")
        let centered = NSPredicate { _, _ in
            guard projectedNode.exists, dossier.exists else { return false }
            let freeCenter = (canvas.frame.minY + dossier.frame.minY - 24) / 2
            return abs(projectedNode.frame.midY - freeCenter) < 6 && abs(projectedNode.frame.midX - canvas.frame.midX) < 6
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: centered, object: nil)], timeout: 5), .completed,
                       "the reselected node centers in the free space above the dossier")
        capture(app, name: "Focused node selected")
    }

    @MainActor
    func testNodeDossierKeepsGraphVisibleAndCloses() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        let panelText = openDossier(in: app)

        XCTAssertTrue(panelText.waitForExistence(timeout: 5), "dossier text appears")
        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.exists, "web view stays hittable: web view exists")
        XCTAssertGreaterThanOrEqual(
            webView.frame.height,
            app.frame.height * 0.5,
            "web view stays hittable: graph occupies at least half of the screen"
        )
        let zoomIn = app.buttons["Zoom in"]
        XCTAssertTrue(zoomIn.waitForExistence(timeout: 5), "zoom in exists")
        XCTAssertTrue(zoomIn.isHittable, "zoom in hittable")
        XCTAssertLessThan(
            zoomIn.frame.minY,
            panelText.frame.minY,
            "zoom cluster sits above the dossier"
        )
        capture(app, name: "Graph node panel")

        let closeButton = app.webViews.buttons["Close"]
        if closeButton.waitForExistence(timeout: 2) {
            closeButton.tap()
        } else {
            let closeGlyph = app.webViews.staticTexts["×"]
            _ = closeGlyph.waitForExistence(timeout: 2)
            closeGlyph.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        XCTAssertTrue(
            closeButton.waitForNonExistence(timeout: 4),
            "dossier closes: close button disappears"
        )
        // The graph's own node label carries the same words, so ask for the
        // dialog rather than the text.
        XCTAssertTrue(
            nodeDetails(in: app).waitForNonExistence(timeout: 2),
            "dossier closes: dialog disappears"
        )
    }

    @MainActor
    func testFindingDossierOffersControlsAndSteps() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        _ = openDossier(in: app)

        let webView = app.webViews.firstMatch
        for label in ["Edit", "Delete", "Close", "Next node", "Previous node"] {
            XCTAssertTrue(webView.buttons[label].waitForExistence(timeout: 5), "finding offers \(label)")
        }
        XCTAssertTrue(webView.staticTexts["1 of 3"].waitForExistence(timeout: 5), "finding shows its position in the ranked list")

        webView.buttons["Next node"].tap()
        XCTAssertTrue(
            webView.staticTexts["Retry sync after reconnecting"].waitForExistence(timeout: 5),
            "Next selects the following finding"
        )
        XCTAssertTrue(webView.staticTexts["2 of 3"].waitForExistence(timeout: 5), "counter follows the selection")

        webView.buttons["Edit"].tap()
        XCTAssertTrue(app.navigationBars["Edit finding"].waitForExistence(timeout: 5),
                      "Edit finding sheet appears")
    }

    @MainActor
    func testFindingDossierOffersDeleteWithConfirmation() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        _ = openDossier(in: app)

        let delete = app.webViews.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "finding offers Delete")
        delete.tap()
        // The confirmation is phren's own dialog, not a system sheet.
        XCTAssertTrue(app.buttons["memory-delete:delete"].waitForExistence(timeout: 5),
                      "delete confirmation appears")
    }

    @MainActor
    func testProjectDossierOmitsLeafControls() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        let dossier = openProjectDossier(in: app)

        XCTAssertTrue(dossier.waitForExistence(timeout: 5), "project dossier appears")
        XCTAssertFalse(app.webViews.buttons["Edit"].exists, "project omits Edit")
        XCTAssertFalse(app.webViews.buttons["Delete"].exists, "project omits Delete")
        XCTAssertFalse(app.webViews.buttons["Next node"].exists, "project omits stepping")
    }

    @MainActor
    func testGraphDragsStayOnMemoryAndOtherTabsKeepBackGestures() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Projects"].tap()
        XCTAssertFalse(app.buttons["More"].exists)
        capture(app, name: "Projects design")
        openMemoryGraph(from: app)
        XCTAssertTrue(app.webViews.staticTexts["DEMO"].firstMatch.waitForExistence(timeout: 20))
        let canvas = app.webViews.firstMatch
        let memory = app.navigationBars["Memory"]
        for (start, end) in [(0.05, 0.85), (0.85, 0.15), (0.35, 0.9)] {
            canvas.coordinate(withNormalizedOffset: CGVector(dx: start, dy: 0.55))
                .press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: end, dy: 0.55)))
            XCTAssertTrue(memory.exists, "Dragging the graph navigated away")
            XCTAssertTrue(app.tabBars.buttons["Memory"].isSelected)
            XCTAssertTrue(canvas.exists)
        }
        // Exercise the navigation controller's edge gesture as well.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.001, dy: 0.55))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.55)))
        XCTAssertTrue(memory.exists)
        XCTAssertTrue(app.tabBars.buttons["Memory"].isSelected)
        capture(app, name: "Graph after canvas and edge drags")
        app.tabBars.buttons["Projects"].tap()
        XCTAssertTrue(app.navigationBars["Projects"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Agents"].tap()
        openSessionsAction("skills", in: app)
        XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 5))
        // The synthesized edge drag occasionally lands before the push has
        // settled and is swallowed; a second one is still the same gesture.
        for _ in 0..<2 where !app.navigationBars["Settings"].exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.001, dy: 0.55))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.55)))
            _ = app.navigationBars["Settings"].waitForExistence(timeout: 4)
        }
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5),
                      "Normal back gestures must still work outside the graph")
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        capture(app, name: "Settings design")
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        attachUIScreenshot(app, name)
    }

    @MainActor
    private func openDossier(in app: XCUIApplication) -> XCUIElement {
        openMemoryGraph(from: app)
        _ = app.webViews.staticTexts["DEMO"].firstMatch.waitForExistence(timeout: 20)
        app.buttons["memory-search-toggle"].tap()
        let field = app.textFields["memory-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("offline\n")
        return app.webViews.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Cache repeated requests for offline use")
        ).firstMatch
    }

    @MainActor
    private func openProjectDossier(in app: XCUIApplication) -> XCUIElement {
        openMemoryGraph(from: app)
        _ = app.webViews.staticTexts["DEMO"].firstMatch.waitForExistence(timeout: 20)
        app.buttons["memory-search-toggle"].tap()
        let field = app.textFields["memory-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("demo\n")
        return nodeDetails(in: app)
    }

    /// The dossier is a dialog, which WebKit reports as "Node details, web dialog".
    private func nodeDetails(in app: XCUIApplication) -> XCUIElement {
        app.webViews.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "Node details")).firstMatch
    }

    @MainActor
    func testFocusSaveAndRestoreGraphView() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture"]
        app.launch()
        openSessionProjectGraph(in: app)
        // The native search is available before WKWebView has mounted its
        // graph. Wait for rendered content before issuing camera commands.
        XCTAssertTrue(app.webViews.staticTexts["DEMO"].firstMatch.waitForExistence(timeout: 20))
        let search = app.buttons["Search graph"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        let field = app.textFields["graph-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "The graph search is the phren search field")
        field.tap()
        field.typeText("offline")
        XCTAssertTrue(app.buttons["graph-search:clear"].exists, "The search field offers its own clear button")
        capture(app, name: "Graph search field")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Cache repeated requests")).firstMatch.tap()
        let focus = app.webViews.buttons["Focus"]
        XCTAssertTrue(focus.waitForExistence(timeout: 5))
        focus.tap()
        XCTAssertTrue(app.buttons["Show full view"].waitForExistence(timeout: 5))
        app.buttons["Graph options"].tap()
        app.buttons["Save this view"].tap()
        let name = "Offline view \(UUID().uuidString.prefix(6))"
        let nameField = app.textFields["graph-view-name"]
        nameField.tap()
        nameField.typeText(name)
        XCTAssertEqual(nameField.value as? String, name)
        app.buttons["Save"].tap()
        app.buttons["Show full view"].tap()
        app.terminate()
        app.launch()
        openSessionProjectGraph(in: app)
        // Right after the relaunch the graph screen is still settling; a tap
        // that lands during the push does not present the store chooser.
        let storeButton = app.buttons["graph-store"]
        XCTAssertTrue(storeButton.waitForExistence(timeout: 5))
        let team = app.descendants(matching: .any)["graph-store:team/brain"]
        for _ in 0..<3 where !team.exists {
            storeButton.tap()
            _ = team.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(team.waitForExistence(timeout: 5))
        team.tap()
        XCTAssertTrue(app.buttons["Store: team/brain"].waitForExistence(timeout: 5))
        app.buttons["Graph options"].tap()
        app.buttons["Saved views"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.tap()
        XCTAssertTrue(app.buttons["Show full view"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Store: sample/brain"].exists)
        attachUIScreenshot(app, "Saved graph connections")
    }

    @MainActor
    func testSkillAvailabilityStartsUnknownAndCanBeEnabledAndDisabled() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        openSessionsAction("skills", in: app)
        // The list is pushed; tap the row by its identifier once it exists and
        // wait for the detail before looking for its controls.
        let audit = app.buttons["skill:sample/brain:demo/skills/audit.md"]
        XCTAssertTrue(audit.waitForExistence(timeout: 8))
        audit.tap()
        XCTAssertTrue(app.navigationBars["audit"].waitForExistence(timeout: 8))
        let enable = app.buttons["Enable on linked computers"]
        let toggle = app.descendants(matching: .any)["skill-enabled"].firstMatch
        // Fresh state offers the enable button; a run where an earlier test
        // already set the skill's availability lands on the switch directly.
        if enable.waitForExistence(timeout: 5) {
            enable.tap()
        } else {
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "an availability control is shown")
            if toggle.value as? String != "On" { toggle.tap() }
        }
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "On")
        toggle.tap()
        let disabled = NSPredicate(format: "value == 'Off'")
        expectation(for: disabled, evaluatedWith: toggle)
        waitForExpectations(timeout: 5)
    }

    /// Named views belong to the contextual project graph. Keep their full
    /// save/restore coverage through the session's existing Explore graph link.
    @MainActor
    private func openSessionProjectGraph(in app: XCUIApplication) {
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        let computer = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        XCTAssertTrue(computer.waitForExistence(timeout: 10))
        for _ in 0..<4 where !computer.isHittable { app.scrollViews["sessions-scroll"].swipeUp() }
        computer.tap()
        let details = app.buttons["live-detail:w7:w7:t9"]
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        details.tap()
        if app.buttons["Change project link"].exists { app.buttons["Change project link"].tap() }
        else { app.buttons["Link to project"].tap() }
        let project = app.buttons["live-project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        project.tap()
        let graph = app.buttons["Explore graph"]
        XCTAssertTrue(graph.waitForExistence(timeout: 5))
        graph.tap()
    }
}
