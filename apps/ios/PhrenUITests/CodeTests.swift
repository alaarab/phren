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
    func testCodeOpensOnTheCheckoutAndFileNamesReachDossier() {
        let app = launch()
        app.buttons["project:sample/brain:demo"].tap()
        let codeCell = app.buttons["project-code-row"]
        XCTAssertTrue(codeCell.waitForExistence(timeout: 8))
        codeCell.tap()
        let folder = app.buttons["code-tree:typescript"]
        XCTAssertTrue(folder.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["code-tree:README.md"].exists, "Files the index never reads are listed too")
        XCTAssertTrue(app.staticTexts["code-languages"].exists)
        XCTAssertTrue(app.staticTexts["code-indexed-at"].exists)
        XCTAssertTrue(app.buttons["code-reindex"].exists)
        capture(app, "Code home tree")
        folder.tap()
        let file = app.buttons["code-tree:typescript/app.ts"]
        XCTAssertTrue(file.waitForExistence(timeout: 8))
        file.tap()
        XCTAssertTrue(app.descendants(matching: .any)["code-file:typescript/app.ts"].firstMatch.waitForExistence(timeout: 8))
        let add = app.links["add"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 8), "Names the index resolves are tappable")
        capture(app, "Code file")
        add.tap()
        XCTAssertTrue(app.descendants(matching: .any)["code-dossier"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["code-line:1"].waitForExistence(timeout: 5))
        capture(app, "Code tree dossier")
    }

    @MainActor
    func testBrowsesNestedFilesJumpsByOutlineAndFollowsDefinitionAcrossFiles() {
        let app = launch()
        app.buttons["project:sample/brain:demo"].tap()
        let codeCell = app.buttons["project-code-row"]
        XCTAssertTrue(codeCell.waitForExistence(timeout: 8))
        codeCell.tap()

        // An unindexed file two folders down opens read-only.
        tap(app.buttons["code-tree:docs"])
        tap(app.buttons["code-tree:docs/guide"])
        tap(app.buttons["code-tree:docs/guide/setup.txt"])
        XCTAssertTrue(app.descendants(matching: .any)["code-file:docs/guide/setup.txt"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Run the checks."].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["code-file-outline"].exists, "An unindexed file has no outline")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        tap(app.buttons["code-root"])

        // An indexed file: outline jump, then a name to its definition in another file.
        tap(app.buttons["code-tree:typescript"])
        tap(app.buttons["code-tree:typescript/util.ts"])
        tap(app.buttons["code-file-outline"])
        let helper = app.buttons["code-outline:11:helper"]
        XCTAssertTrue(helper.waitForExistence(timeout: 5))
        capture(app, "Code outline")
        helper.tap()
        let point = app.links["Point"].firstMatch
        XCTAssertTrue(point.waitForExistence(timeout: 8))
        XCTAssertTrue(point.isHittable, "The outline jump scrolls the symbol's line into view")
        point.tap()
        let definition = app.buttons["code-dossier-definition"]
        XCTAssertTrue(definition.waitForExistence(timeout: 8))
        capture(app, "Code symbol panel")
        definition.tap()
        XCTAssertTrue(app.descendants(matching: .any)["code-file:typescript/app.ts"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.navigationBars["app.ts"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "export class Point")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Code definition in another file")
    }

    @MainActor
    func testRecentOpensTheFileAtTheSymbolAndMediaKeepsTheFileViewer() {
        let app = launch()
        app.buttons["project:sample/brain:demo"].tap()
        let codeCell = app.buttons["project-code-row"]
        XCTAssertTrue(codeCell.waitForExistence(timeout: 8))
        codeCell.tap()
        tap(app.buttons["code-mode:recent"])
        tap(app.buttons["code-row:12"])
        XCTAssertTrue(app.descendants(matching: .any)["code-file:swift/Service.swift"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "func parse")).firstMatch.waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        tap(app.buttons["code-mode:files"])
        tap(app.buttons["code-tree:assets"])
        tap(app.buttons["code-tree:assets/logo.png"])
        let close = app.buttons["file-viewer-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 8), "A picture opens in the file viewer")
        close.tap()
    }

    @MainActor
    func testComputerFilesOpenTheProjectBrowser() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "--code-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8)); app.tabBars.buttons["Agents"].tap()
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        for _ in 0..<14 { if host.exists && host.isHittable { break }; app.swipeUp() }
        tap(host)
        tap(app.buttons["host-files"])
        tap(app.buttons["files-projects:A1000000-0000-0000-0000-000000000001"])
        tap(app.buttons["repository-project:demo"])
        XCTAssertTrue(app.buttons["code-tree:typescript"].waitForExistence(timeout: 8), "The computer's project files open in the code browser")
        tap(app.buttons["code-tree:README.md"])
        XCTAssertTrue(app.descendants(matching: .any)["code-file:README.md"].firstMatch.waitForExistence(timeout: 8))
        capture(app, "Computer project browser")
    }

    @MainActor
    private func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 8), "\(element) exists", file: file, line: line)
        element.tap()
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
