import XCTest

/// The Code screen from the project page: search a fixed index, open a
/// symbol's dossier. Runs against `--code-fixture`, so no Hook is needed.
final class CodeTests: XCTestCase {
    @MainActor
    func testSearchShowsRowsAndOpensTheDossier() {
        let app = launch()
        let project = app.buttons["project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        project.tap()

        let codeCell = app.buttons["project-code-row"]
        XCTAssertTrue(codeCell.waitForExistence(timeout: 5))
        codeCell.tap()

        let field = app.textFields["code-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 8))
        field.tap()
        field.typeText("po")

        let row = app.buttons["code-row:2"]
        XCTAssertTrue(row.waitForExistence(timeout: 8), "the Point symbol is listed")
        capture(app, "Code search")

        row.tap()
        let dossier = app.descendants(matching: .any).matching(identifier: "code-dossier").firstMatch
        XCTAssertTrue(dossier.waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any)["code-dossier-snippet"].firstMatch.waitForExistence(timeout: 5), "the definition snippet is shown")
        let definition = app.buttons["code-line:5"]
        XCTAssertTrue(definition.exists)
        XCTAssertTrue(definition.label.contains("export class Point"), "The snippet contains the selected symbol's definition")
        XCTAssertTrue(app.staticTexts["code-dossier-blame"].exists, "the last change line is shown")
        capture(app, "Code dossier")
    }

    @MainActor
    func testCodeOpensOnIndexedTreeAndFileSymbolsReachDossier() {
        let app = launch()
        app.buttons["project:sample/brain:demo"].tap()
        let codeCell = app.buttons["project-code-row"]
        XCTAssertTrue(codeCell.waitForExistence(timeout: 8))
        codeCell.tap()
        let folder = app.buttons["code-tree:typescript"]
        XCTAssertTrue(folder.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["code-languages"].exists)
        XCTAssertTrue(app.staticTexts["code-indexed-at"].exists)
        XCTAssertTrue(app.buttons["code-reindex"].exists)
        capture(app, "Code home tree")
        folder.tap()
        let file = app.buttons["code-tree:typescript/app.ts"]
        XCTAssertTrue(file.waitForExistence(timeout: 8))
        file.tap()
        let symbol = app.buttons["code-file-symbol:5:Point"]
        XCTAssertTrue(symbol.waitForExistence(timeout: 8))
        symbol.tap()
        XCTAssertTrue(app.descendants(matching: .any)["code-dossier"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["code-line:5"].waitForExistence(timeout: 5))
        capture(app, "Code tree dossier")
    }

    @MainActor
    func testUsagePagesThroughMiddleAndHotColdJumpWithinRanking() {
        let app = launch()
        app.buttons["project:sample/brain:demo"].tap()
        let codeCell = app.buttons["project-code-row"]
        XCTAssertTrue(codeCell.waitForExistence(timeout: 8))
        codeCell.tap()
        let usage = app.buttons["code-mode:usage"]
        XCTAssertTrue(usage.waitForExistence(timeout: 8))
        usage.tap()
        let hot = app.buttons["code-row:1"]
        XCTAssertTrue(hot.waitForExistence(timeout: 8))
        let next = app.buttons["code-usage-next"]
        reveal(next, in: app, upward: true)
        XCTAssertTrue(next.waitForExistence(timeout: 8))
        next.tap()
        XCTAssertTrue(app.staticTexts["code-usage-range"].waitForExistence(timeout: 8))
        waitForRange("6–10", in: app)
        capture(app, "Code middle usage")
        let cold = app.buttons["code-cold"]
        reveal(cold, in: app, upward: false)
        XCTAssertTrue(cold.waitForExistence(timeout: 5))
        cold.tap()
        let previous = app.buttons["code-usage-previous"]
        XCTAssertTrue(previous.waitForExistence(timeout: 8))
        reveal(app.buttons["code-hot"], in: app, upward: false)
        waitForRange("8–12", in: app)
        app.buttons["code-hot"].tap()
        XCTAssertTrue(hot.waitForExistence(timeout: 8))
        reveal(app.buttons["code-kind-filter"], in: app, upward: false)
        app.buttons["code-kind-filter"].tap()
        app.buttons["code-kind:types"].tap()
        XCTAssertTrue(app.buttons["code-row:2"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["code-row:1"].exists)
    }

    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, upward: Bool) {
        for _ in 0..<6 {
            if element.exists && element.isHittable { return }
            if upward { app.swipeUp() } else { app.swipeDown() }
        }
    }

    @MainActor
    private func waitForRange(_ ranks: String, in app: XCUIApplication) {
        let changed = expectation(for: NSPredicate(format: "label CONTAINS %@", ranks), evaluatedWith: app.staticTexts["code-usage-range"])
        wait(for: [changed], timeout: 8)
    }

    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--code-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Projects"].tap()
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        attachUIScreenshot(app, name)
    }
}
