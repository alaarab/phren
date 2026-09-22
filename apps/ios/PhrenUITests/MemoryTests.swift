import XCTest

final class MemoryTests: XCTestCase {
    @MainActor
    func testMapSearchSelectsANodeAndOpensTheDossier() {
        let app = launch(mode: "map")
        XCTAssertTrue(app.webViews.staticTexts["PHREN"].firstMatch.waitForExistence(timeout: 30),
                      "the graph renders the store")
        capture(app, "Memory map")

        app.buttons["memory-search-toggle"].tap()
        let field = app.textFields["memory-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("idempotency\n")

        let dossier = app.webViews.otherElements
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Node details")).firstMatch
        XCTAssertTrue(dossier.waitForExistence(timeout: 10), "the dossier opens on the searched node")
        XCTAssertTrue(app.webViews.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "Idempotency keys")).firstMatch.exists)
        capture(app, "Memory map dossier")

        let next = app.webViews.buttons["memory-dossier-next"]
        XCTAssertTrue(next.waitForExistence(timeout: 5), "the dossier header exposes Next")
        XCTAssertTrue(app.webViews.buttons["memory-dossier-prev"].exists, "the dossier header exposes Previous")
        next.tap()
        XCTAssertTrue(dossier.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "Invoices are generated from the ledger")).firstMatch
            .waitForExistence(timeout: 5),
                      "Next moves the dossier to the next node in the ranked list")
    }

    @MainActor
    func testListModeRowsAndProjectFilterChangeTheCountsLine() {
        let app = launch(mode: "list")
        let counts = app.staticTexts["memory-counts"]
        XCTAssertTrue(counts.waitForExistence(timeout: 10))
        XCTAssertEqual(counts.label, "40 findings · 9 tasks · 6 topics")
        capture(app, "Memory list all projects")

        app.buttons["memory-projects"].tap()
        let ledger = app.buttons["memory-project:ledger"]
        XCTAssertTrue(ledger.waitForExistence(timeout: 5))
        ledger.tap()
        app.buttons["memory-project-done"].tap()

        expectation(for: NSPredicate(format: "label == %@", "14 findings · 3 tasks · 6 topics"), evaluatedWith: counts)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(app.buttons["memory-row:finding:1a2b3c4d"].waitForExistence(timeout: 8),
                      "the ledger finding is listed")
        capture(app, "Memory list ledger")
    }

    @MainActor
    func testKindsDropDownHidesTasks() {
        let app = launch(mode: "list")
        app.buttons["memory-kinds"].tap()
        for kind in ["findings", "notes", "topics"] { app.buttons["memory-kind:\(kind)"].tap() }
        app.buttons["memory-kind-done"].tap()

        let task = app.buttons["memory-row:task:10a1b2c3"]
        XCTAssertTrue(task.waitForExistence(timeout: 8), "only tasks are listed")
        capture(app, "Memory kinds tasks only")

        app.buttons["memory-kinds"].tap()
        app.buttons["memory-kind:findings"].tap()
        app.buttons["memory-kind:tasks"].tap()
        app.buttons["memory-kind-done"].tap()
        XCTAssertTrue(task.waitForNonExistence(timeout: 5), "tasks are hidden")
        // The list is lazy, so ask for any finding row rather than one that may sit off screen.
        let anyFinding = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "memory-row:finding:")).firstMatch
        XCTAssertTrue(anyFinding.waitForExistence(timeout: 8), "findings are listed")
        capture(app, "Memory kinds without tasks")
    }

    @MainActor
    private func launch(mode: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--memory-fixture"]
        for _ in 0..<2 {
            app.launch()
            if app.tabBars.buttons["Memory"].waitForExistence(timeout: 8) { break }
            app.terminate()
        }
        app.tabBars.buttons["Memory"].tap()
        let toggle = app.buttons["memory-mode:\(mode)"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}
