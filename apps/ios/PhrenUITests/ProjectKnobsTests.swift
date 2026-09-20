import XCTest

final class ProjectKnobsTests: XCTestCase {
    @MainActor
    func testProjectKnobsRowOpensTheFivePickers() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--project-skills-fixture", "-phren-tab", "projects"]
        app.launch()
        let project = app.buttons["project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()

        let row = app.buttons["project-knobs-row"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()

        XCTAssertTrue(app.descendants(matching: .any)["project-knobs"].waitForExistence(timeout: 5))
        for key in ["findingSensitivity", "proactivity", "proactivityFindings", "proactivityTask", "taskMode"] {
            XCTAssertTrue(app.descendants(matching: .any)["knob-\(key)"].waitForExistence(timeout: 5), key)
        }

        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Project knobs"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
