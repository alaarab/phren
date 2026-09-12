import XCTest
import Vision

final class AgentsLayoutTests: XCTestCase {
    @MainActor
    func testAgentsHeaderAndFirstSessionStayBelowNavigationAfterReturning() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Agents"].tap()
        let title = app.navigationBars.staticTexts["Live sessions"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(title.frame.height, 0)
        XCTAssertTrue(app.navigationBars.firstMatch.frame.contains(title.frame))
        assertRenderedTitle(app, title: "Live sessions")
        let intro = app.staticTexts["agents-introduction"]
        XCTAssertTrue(intro.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(intro.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        capture(app, name: "Agents root")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test Mac,")).firstMatch.tap()
        let first = app.staticTexts["Build phone app"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(first.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        capture(app, name: "Computer sessions")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertGreaterThanOrEqual(first.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        capture(app, name: "Computer sessions after returning")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(intro.waitForExistence(timeout: 5))
        // Larger text requires scrolling to reach the computer. Navigation
        // correctly restores that offset; return to the top before checking it.
        for _ in 0..<4 where intro.frame.minY < app.navigationBars.firstMatch.frame.maxY {
            app.collectionViews.firstMatch.swipeDown()
        }
        // Give the pop animation a moment to settle before reading the frame.
        let settled = NSPredicate { _, _ in intro.frame.minY >= app.navigationBars.firstMatch.frame.maxY }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: nil)], timeout: 5), .completed)
        assertRenderedTitle(app, title: "Live sessions")
        capture(app, name: "Agents after navigating back")
    }

    @MainActor
    func testSettingsTitleIsVisibleAboveTheForm() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        assertRenderedTitle(app, title: "Settings")
        capture(app, name: "Settings with visible title")
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Accessibility still exposes a title when the list has painted over it.
    /// Check the rendered navigation region as well as element geometry.
    @MainActor
    private func assertRenderedTitle(_ app: XCUIApplication, title: String,
                                     file: StaticString = #filePath, line: UInt = #line) {
        guard let image = app.screenshot().image.cgImage else {
            XCTFail("Missing screenshot", file: file, line: line); return
        }
        let bar = app.navigationBars.firstMatch.frame
        let screen = app.frame
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.regionOfInterest = CGRect(x: 0, y: 1 - bar.maxY / screen.height,
                                         width: 1, height: bar.height / screen.height)
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
            let rendered = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            XCTAssertTrue(rendered.localizedCaseInsensitiveContains(title),
                          "Navigation title is not rendered: \(rendered)", file: file, line: line)
        } catch { XCTFail("Couldn't inspect the header: \(error)", file: file, line: line) }
    }
}
