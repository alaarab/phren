import XCTest

final class ProjectSkillsTests: XCTestCase {
    @MainActor
    func testProjectSkillsStayInTheirStoreAndReturnAfterEditing() {
        let app = launch()
        app.buttons["project-skills"].tap()
        let local = app.buttons["skill:sample/brain:demo/skills/audit.md"]
        XCTAssertTrue(local.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["skill:sample/brain:global/skills/review-style.md"].exists)
        XCTAssertFalse(app.buttons["skill:team/brain:demo/skills/audit.md"].exists)
        XCTAssertFalse(app.buttons["skill:sample/brain:other/skills/other-check.md"].exists)
        local.tap()
        app.buttons["Edit"].tap()
        let editor = app.textViews["Instructions"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText(" Check the phone workflow.")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.navigationBars["audit"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Check the phone workflow.")).firstMatch.exists)
        capture(app, "Skill with direct return to project")
        app.buttons["skills-return-to-project"].tap()
        XCTAssertTrue(app.navigationBars["demo · brain"].waitForExistence(timeout: 5))
        capture(app, "Project with direct Skills access")
        app.buttons["project-skills"].tap()
        local.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Check the phone workflow.")).firstMatch.waitForExistence(timeout: 5))
    }

    @MainActor
    func testCancellingSkillEditsPreservesDraftUntilDiscarded() {
        let app = launch()
        app.buttons["project-skills"].tap()
        app.buttons["skill:sample/brain:demo/skills/audit.md"].tap()
        app.buttons["Edit"].tap()
        let editor = app.textViews["Instructions"]
        editor.tap()
        editor.typeText(" Unsaved phone edit.")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Discard changes"].waitForExistence(timeout: 5))
        app.otherElements["PopoverDismissRegion"].tap()
        XCTAssertTrue((editor.value as? String)?.contains("Unsaved phone edit.") == true)
        app.buttons["Cancel"].tap()
        app.buttons["Discard changes"].tap()
        XCTAssertTrue(app.navigationBars["audit"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Edit skill"].exists)
        app.buttons["skills-return-to-project"].tap()
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.navigationBars["audit"])
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 5), .completed)
        XCTAssertTrue(app.navigationBars["demo · brain"].waitForExistence(timeout: 5))
        app.buttons["project-skills"].tap()
        XCTAssertTrue(app.buttons["skill:sample/brain:demo/skills/audit.md"].waitForExistence(timeout: 5))
        app.buttons["skill:sample/brain:demo/skills/audit.md"].tap()
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Unsaved phone edit.")).firstMatch.exists)
    }

    @MainActor
    func testMovingASkillToAnotherProjectLeavesTheCurrentProjectList() {
        let app = launch()
        app.buttons["project-skills"].tap()
        let local = app.buttons["skill:sample/brain:demo/skills/audit.md"]
        XCTAssertTrue(local.waitForExistence(timeout: 5))
        local.tap()
        XCTAssertTrue(app.navigationBars["audit"].waitForExistence(timeout: 5))
        app.buttons["More"].tap()
        let move = app.buttons["Move to…"]
        XCTAssertTrue(move.waitForExistence(timeout: 5))
        move.tap()
        let picker = app.buttons["skill-move-destination"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.tap()
        app.buttons["other"].tap()
        capture(app, "Move skill destination")
        app.buttons["skill-move-confirm"].tap()
        // The editor closes with the skill; the project list no longer holds it.
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.navigationBars["audit"])
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 5), .completed)
        XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["skill:sample/brain:demo/skills/audit.md"].exists)
        XCTAssertTrue(app.buttons["skill:sample/brain:global/skills/review-style.md"].exists)
        // The destination project now lists it next to its own skill.
        app.buttons["skills-return-to-project"].tap()
        XCTAssertTrue(app.navigationBars["demo · brain"].waitForExistence(timeout: 5))
        app.navigationBars["demo · brain"].buttons.element(boundBy: 0).tap()
        let other = app.buttons["project:sample/brain:other"]
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.tap()
        XCTAssertTrue(app.buttons["project-skills"].waitForExistence(timeout: 5))
        app.buttons["project-skills"].tap()
        XCTAssertTrue(app.buttons["skill:sample/brain:other/skills/audit.md"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["skill:sample/brain:other/skills/other-check.md"].exists)
        capture(app, "Skill moved to another project")
    }

    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--project-skills-fixture"]
        app.launch()
        let project = app.buttons["project:sample/brain:demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        XCTAssertTrue(app.buttons["project-skills"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
