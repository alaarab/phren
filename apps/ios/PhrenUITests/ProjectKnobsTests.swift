import XCTest

final class ProjectKnobsTests: XCTestCase {
    @MainActor
    func testProjectKnobsRowsSaveAndRoundTrip() {
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
        let selections = [
            ("findingSensitivity", "aggressive"),
            ("proactivity", "high"),
            ("proactivityFindings", "medium"),
            ("proactivityTask", "low"),
            ("taskMode", "suggest")
        ]

        func reveal(_ element: XCUIElement, key: String) {
            for _ in 0..<12 where !element.isHittable { app.swipeUp() }
            XCTAssertTrue(element.waitForExistence(timeout: 5), key)
            XCTAssertTrue(element.isHittable, key)
        }

        for (key, value) in selections {
            let option = app.buttons["knob-\(key):\(value)"]
            reveal(option, key: key)
            XCTAssertTrue(app.descendants(matching: .any)["knob-\(key)"].exists, key)
            option.tap()
            XCTAssertTrue(option.isSelected, key)
        }

        app.buttons["Done"].tap()
        XCTAssertTrue(screen.waitForNonExistence(timeout: 5))
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(screen.waitForExistence(timeout: 5))

        for (key, value) in selections {
            let option = app.buttons["knob-\(key):\(value)"]
            reveal(option, key: key)
            XCTAssertTrue(option.isSelected, "\(key) did not round-trip")
        }

        attachUIScreenshot(app, "Project knobs")
    }
}
