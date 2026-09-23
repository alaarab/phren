import XCTest

final class HookHealthTests: XCTestCase {
    @MainActor
    func testHealthShowsSyncErrorAndOneWayPeer() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--hook-health-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-health"]
        for _ in 0..<12 {
            if row.exists && !row.frame.isEmpty && row.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(row.isHittable)
        row.tap()
        XCTAssertTrue(app.navigationBars["Health"].waitForExistence(timeout: 5))
        let syncError = app.descendants(matching: .any)["health-sync-error:Desk:primary"].firstMatch
        XCTAssertTrue(syncError.waitForExistence(timeout: 5))
        XCTAssertTrue(syncError.label.contains("non-fast-forward"), syncError.label)
        let oneWay = app.descendants(matching: .any)["health-peer-one-way:Desk:Linuxbox"].firstMatch
        XCTAssertTrue(oneWay.exists)
        XCTAssertTrue(oneWay.label.contains("does not list Desk back"), oneWay.label)
        XCTAssertTrue(app.descendants(matching: .any)["health-computer:Linuxbox"].firstMatch.exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Health"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
