import XCTest

final class GraphInteractionTests: XCTestCase {
    @MainActor
    func testNodePanelKeepsGraphVisibleAndCloses() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["Memory graph"].waitForExistence(timeout: 15))
        app.buttons["Memory graph"].tap()
        XCTAssertTrue(app.webViews.staticTexts["DEMO"].firstMatch.waitForExistence(timeout: 20))
        app.buttons["Search graph"].tap()
        let field = app.textFields["Search findings, tasks, projects"]
        field.tap()
        field.typeText("offline")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Cache repeated requests")).firstMatch.tap()

        let panelText = app.staticTexts["graph-node-text"]
        XCTAssertTrue(panelText.waitForExistence(timeout: 5))
        XCTAssertTrue(panelText.label.contains("Cache repeated requests for offline use"))
        XCTAssertTrue(app.webViews.firstMatch.isHittable, "The graph should remain visible and interactive behind the panel")
        capture(app, name: "Graph node panel")

        app.buttons["graph-node-close"].tap()
        XCTAssertFalse(panelText.waitForExistence(timeout: 2))
    }

    @MainActor
    func testGraphDragsStayOnMapAndBackButtonExits() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["Memory graph"].waitForExistence(timeout: 15))
        capture(app, name: "Projects design")
        app.buttons["Memory graph"].tap()
        XCTAssertTrue(app.webViews.staticTexts["DEMO"].firstMatch.waitForExistence(timeout: 20))
        let canvas = app.webViews.firstMatch
        let back = app.buttons["graph-back"]
        for (start, end) in [(0.05, 0.85), (0.85, 0.15), (0.35, 0.9)] {
            canvas.coordinate(withNormalizedOffset: CGVector(dx: start, dy: 0.55))
                .press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: end, dy: 0.55)))
            XCTAssertTrue(back.exists, "Dragging the graph navigated away")
            XCTAssertTrue(canvas.exists)
        }
        // Exercise the navigation controller's edge gesture as well.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.001, dy: 0.55))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.55)))
        XCTAssertTrue(back.exists)
        capture(app, name: "Graph after canvas and edge drags")
        back.tap()
        XCTAssertTrue(app.navigationBars["Projects"].waitForExistence(timeout: 5))
        app.buttons["More"].tap()
        tapVisibleSkillsItem(app)
        XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.001, dy: 0.55))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.55)))
        XCTAssertTrue(app.navigationBars["Projects"].waitForExistence(timeout: 5),
                      "Normal back gestures must still work outside the graph")
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        capture(app, name: "Settings design")
    }

    @MainActor
    private func tapVisibleSkillsItem(_ app: XCUIApplication) {
        // iOS exposes both the menu action and the obscured list shortcut.
        let item = app.buttons.matching(NSPredicate(format: "label == %@", "Skills"))
            .allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(item)
        item?.tap()
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    @MainActor
    func testFocusSaveAndRestoreGraphView() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        let graph = app.buttons["Memory graph"]
        XCTAssertTrue(graph.waitForExistence(timeout: 15))
        graph.tap()
        // The native search is available before WKWebView has mounted its
        // graph. Wait for rendered content before issuing camera commands.
        XCTAssertTrue(app.webViews.staticTexts["DEMO"].firstMatch.waitForExistence(timeout: 20))
        let search = app.buttons["Search graph"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        let field = app.textFields["Search findings, tasks, projects"]
        field.tap()
        field.typeText("offline")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Cache repeated requests")).firstMatch.tap()
        let focus = app.buttons["Focus connections"]
        XCTAssertTrue(focus.waitForExistence(timeout: 5))
        focus.tap()
        XCTAssertTrue(app.buttons["Show full view"].waitForExistence(timeout: 5))
        app.buttons["Graph options"].tap()
        app.buttons["Save this view"].tap()
        let name = "Offline view \(UUID().uuidString.prefix(6))"
        let nameField = app.alerts.textFields.firstMatch
        nameField.tap()
        nameField.typeText(name)
        XCTAssertEqual(nameField.value as? String, name)
        app.alerts.buttons["Save"].tap()
        app.buttons["Show full view"].tap()
        app.terminate()
        app.launch()
        XCTAssertTrue(graph.waitForExistence(timeout: 15))
        graph.tap()
        app.buttons["Store: sample/brain"].tap()
        app.buttons["team/brain"].tap()
        XCTAssertTrue(app.buttons["Store: team/brain"].waitForExistence(timeout: 5))
        app.buttons["Graph options"].tap()
        app.buttons["Saved views"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.tap()
        XCTAssertTrue(app.buttons["Show full view"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Store: sample/brain"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Saved graph connections"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    @MainActor
    func testSkillAvailabilityStartsUnknownAndCanBeEnabledAndDisabled() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["More"].waitForExistence(timeout: 15))
        app.buttons["More"].tap()
        tapVisibleSkillsItem(app)
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "audit")).firstMatch.tap()
        let enable = app.buttons["Enable on linked computers"]
        XCTAssertTrue(enable.waitForExistence(timeout: 5))
        enable.tap()
        let toggle = app.switches["Enabled for agents"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "1")
        // SwiftUI exposes the whole row and the control as separate switches.
        // Target the visible control rather than the label's center.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        let disabled = NSPredicate(format: "value == '0'")
        expectation(for: disabled, evaluatedWith: toggle)
        waitForExpectations(timeout: 5)
    }
}
