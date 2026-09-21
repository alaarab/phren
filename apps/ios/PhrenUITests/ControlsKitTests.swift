import XCTest

final class ControlsKitTests: XCTestCase {
    @MainActor
    func testScreenshotsAtStandardSize() {
        captureKit(accessibility: false)
    }

    @MainActor
    func testScreenshotsAtLargestDynamicTypeWithReducedMotion() {
        captureKit(accessibility: true)
    }

    @MainActor
    func testSelectionsAndModalActions() {
        let app = launch(page: "options")
        let diff = app.buttons["controls-single:diff"]
        XCTAssertTrue(diff.waitForExistence(timeout: 5))
        diff.tap()
        XCTAssertTrue(diff.isSelected)
        XCTAssertFalse(app.buttons["controls-single:list"].isSelected)
        XCTAssertFalse(app.buttons["controls-single:unavailable"].isEnabled)
        diff.tap()
        XCTAssertTrue(diff.isSelected)
        let multiple = app.buttons["controls-multi:diff"]
        reveal(multiple, scroll: app.scrollViews["controls-scroll"])
        multiple.tap()
        XCTAssertTrue(multiple.isSelected)
        multiple.tap()
        XCTAssertFalse(multiple.isSelected)
        app.terminate()

        let modals = launch(page: "presentations")
        modals.buttons["controls-open-sheet"].tap()
        let choice = modals.buttons["controls-sheet:choice"]
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        reveal(choice, scroll: modals.scrollViews["controls-sheet:scroll"])
        choice.tap()
        XCTAssertTrue(choice.isSelected)
        XCTAssertTrue(modals.buttons["controls-sheet:close"].exists)
        XCTAssertFalse(modals.buttons["controls-sheet:disabled"].isEnabled)
        let delete = modals.buttons["controls-sheet:delete"]
        reveal(delete, scroll: modals.scrollViews["controls-sheet:scroll"])
        delete.tap()
        let keep = modals.buttons["controls-dialog:keep"]
        XCTAssertTrue(keep.waitForExistence(timeout: 5))
        keep.tap()
        XCTAssertEqual(modals.staticTexts["controls-result"].label, "Kept")
        XCTAssertTrue(modals.buttons["controls-open-sheet"].isHittable)
    }

    @MainActor
    func testSwitchAndStepperRespectStateAndBounds() {
        let switches = launch(page: "switches")
        let control = switches.descendants(matching: .any).matching(identifier: "controls-switch:live").firstMatch
        XCTAssertTrue(control.waitForExistence(timeout: 5))
        let previous = control.value as? String
        control.tap()
        XCTAssertNotEqual(control.value as? String, previous)
        XCTAssertFalse(switches.descendants(matching: .any)
            .matching(identifier: "controls-switch:disabled-off").firstMatch.isEnabled)
        switches.terminate()

        let fields = launch(page: "fields")
        let plus = fields.buttons["controls-stepper:plus"]
        XCTAssertTrue(plus.waitForExistence(timeout: 5))
        plus.tap()
        plus.tap()
        XCTAssertFalse(plus.isEnabled)
        XCTAssertEqual(fields.staticTexts["controls-stepper:value"].label, "4")
        fields.buttons["controls-stepper:minus"].tap()
        XCTAssertTrue(plus.isEnabled)
        XCTAssertEqual(fields.staticTexts["controls-stepper:value"].label, "3")
    }

    @MainActor
    func testSheetDragAndBackdropDismissWithoutAnAction() {
        let app = launch(page: "presentations")
        app.buttons["controls-open-sheet"].tap()
        let close = app.buttons["controls-sheet:close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        let title = app.staticTexts["Session actions"]
        let start = title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 180)))
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["controls-result"].label, "No action")
        app.buttons["controls-open-sheet"].tap()
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["controls-result"].label, "No action")
    }

    @MainActor
    private func captureKit(accessibility: Bool) {
        let size = accessibility ? "AX5 reduced motion" : "Large"
        for page in ["switches", "options", "segments", "fields", "navigation", "presentations"] {
            let app = launch(page: page, accessibility: accessibility)
            let end = app.staticTexts["controls-end"]
            for index in 0..<24 {
                capture(app, name: "Controls \(size) \(page) \(index)")
                if end.isHittable { break }
                app.scrollViews["controls-scroll"].swipeUp()
            }
            XCTAssertTrue(end.isHittable, "Could not reach the end of \(page)")
            app.terminate()
        }
        for presentation in ["sheet", "dialog", "long-sheet", "long-dialog"] {
            let app = launch(page: "presentations", accessibility: accessibility, presentation: presentation)
            let sheet = presentation.hasSuffix("sheet")
            let lastID = sheet ? (presentation == "long-sheet" ? "extra-19" : "delete") : "keep"
            let prefix = sheet ? "controls-sheet" : "controls-dialog"
            let last = app.buttons["\(prefix):\(lastID)"]
            XCTAssertTrue(last.waitForExistence(timeout: 5))
            for index in 0..<30 {
                capture(app, name: "Controls \(size) \(presentation) \(index)")
                if last.isHittable { break }
                app.scrollViews["\(prefix):scroll"].swipeUp()
            }
            XCTAssertTrue(last.isHittable, "Last action must remain reachable")
            app.terminate()
        }
    }

    @MainActor
    private func launch(page: String, accessibility: Bool = false, presentation: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--controls-fixture", "--controls-page", page]
        if accessibility { app.launchArguments += ["--controls-accessibility", "--controls-reduce-motion"] }
        if let presentation { app.launchArguments += ["--controls-presentation", presentation] }
        app.launch()
        // Modal fixtures deliberately hide the underlying screen from accessibility.
        let marker = presentation == nil ? "controls-next" : (presentation!.hasSuffix("sheet") ? "controls-sheet:close" : "controls-dialog:delete")
        if !app.buttons[marker].waitForExistence(timeout: 10) {
            // The first launch of a run can race the previous test's process being
            // terminated and come up without its arguments; one relaunch settles it.
            app.terminate()
            app.launch()
        }
        XCTAssertTrue(app.buttons[marker].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    private func reveal(_ element: XCUIElement, scroll: XCUIElement) {
        for _ in 0..<12 where !element.isHittable { scroll.swipeUp() }
        XCTAssertTrue(element.isHittable)
        XCTAssertGreaterThanOrEqual(element.frame.height, 44)
        XCTAssertGreaterThanOrEqual(element.frame.width, 44)
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        attachUIScreenshot(app, name)
    }
}
