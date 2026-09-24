import XCTest

final class KnobsTests: XCTestCase {
    @MainActor
    func testChangeEnumAndResetWithConfirmation() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--project-skills-fixture", "-phren-tab", "projects"]
        app.launch()
        let project = app.buttons["project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        project.tap()

        let row = app.buttons["project-knobs-row"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()

        let screen = app.descendants(matching: .any)["project-knobs"]
        XCTAssertTrue(screen.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["knobs-section:proactivity"].exists)
        XCTAssertTrue(app.staticTexts["knobs-section:appearance"].exists)

        // Enumeration: the row is a slider with one detent per value; a tap
        // at the far right lands on the last option, and the row's reset glyph
        // appears once the project overrides the global value.
        let sensitivity = app.buttons["knob:findingSensitivity"]
        reveal(sensitivity, in: app)
        sensitivity.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        waitUntil(sensitivity, hasValue: "Aggressive")
        XCTAssertTrue(app.buttons["knob-reset:findingSensitivity"].waitForExistence(timeout: 3))

        attachUIScreenshot(app, "Knobs")

        // Reset asks first; Keep would leave every value alone.
        let reset = app.buttons["knobs-reset"]
        reveal(reset, in: app)
        reset.tap()
        let keep = app.buttons["knobs-reset-dialog:keep"]
        XCTAssertTrue(keep.waitForExistence(timeout: 5))
        keep.tap()
        waitUntil(keep, exists: false)
        waitUntil(sensitivity, hasValue: "Aggressive")

        reveal(reset, in: app)
        reset.tap()
        let confirm = app.buttons["knobs-reset-dialog:reset"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        waitUntil(sensitivity, hasValue: "Inherit global")

        attachUIScreenshot(app, "Knobs reset")

        // The cleared value survives closing and reopening the screen.
        app.buttons["Done"].tap()
        XCTAssertTrue(screen.waitForNonExistence(timeout: 5))
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(screen.waitForExistence(timeout: 5))
        let reopened = app.buttons["knob:findingSensitivity"]
        XCTAssertTrue(reopened.waitForExistence(timeout: 5))
        waitUntil(reopened, hasValue: "Inherit global")
    }

    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        let scroll = app.scrollViews["knobs-scroll"]
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        for _ in 0..<12 where !element.isHittable { scroll.swipeUp(velocity: .slow) }
        if !element.isHittable { attachUIScreenshot(app, "Knobs reveal failed") }
        XCTAssertTrue(element.isHittable)
    }

    @MainActor
    private func waitUntil(_ element: XCUIElement, hasValue value: String, timeout: TimeInterval = 5) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value), object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: timeout), .completed,
                       "Expected \(value), saw \(element.value ?? "nil")")
    }

    @MainActor
    private func waitUntil(_ element: XCUIElement, exists: Bool, timeout: TimeInterval = 5) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == %d", exists), object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: timeout), .completed)
    }
}
