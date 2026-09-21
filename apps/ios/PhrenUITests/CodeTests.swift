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
        XCTAssertTrue(app.staticTexts["code-dossier-snippet"].waitForExistence(timeout: 5), "the definition snippet is shown")
        XCTAssertTrue(app.staticTexts["code-dossier-blame"].exists, "the last change line is shown")
        capture(app, "Code dossier")
    }

    @MainActor
    func testUsageShowsHotAndColdWithoutAQuery() {
        let app = launch()
        app.buttons["project:sample/brain:demo"].tap()
        let codeCell = app.buttons["project-code-row"]
        XCTAssertTrue(codeCell.waitForExistence(timeout: 8))
        codeCell.tap()
        XCTAssertTrue(app.textFields["code-search"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["code-row:typescript/app.ts:1:add"].waitForExistence(timeout: 8), "the hot section lists add")
        XCTAssertTrue(app.buttons["code-row:typescript/app.ts:21:Axis"].exists, "the cold section lists Axis")
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
