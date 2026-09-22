import XCTest
import Vision

final class AgentsLayoutTests: XCTestCase {
    @MainActor
    func testAgentsHeaderAndFirstSessionStayBelowNavigationAfterReturning() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        // The screen's title is the navigation bar's own identifier; the bar
        // itself is the header the session list must stay below.
        let title = app.navigationBars["Live sessions"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(title.frame.height, 0)
        XCTAssertTrue(app.navigationBars.firstMatch.frame.contains(title.frame))
        // No caption above the sessions once a computer is connected; the
        // first section label sits directly under the search field.
        let firstHeader = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "(?i)^(working|needs input|done|idle|other sessions|last seen) · \\d+$")).firstMatch
        XCTAssertTrue(firstHeader.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["agents-introduction"].exists)
        XCTAssertGreaterThanOrEqual(firstHeader.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        capture(app, name: "Agents root")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test Mac,")).firstMatch.tap()
        let first = app.staticTexts["Build phone app"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(first.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        capture(app, name: "Computer sessions")
        XCUIDevice.shared.press(.home)
        app.activate()
        // The bar settles a beat after activation; the end state is what counts.
        let belowBar = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            first.frame.minY >= app.navigationBars.firstMatch.frame.maxY
        }, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [belowBar], timeout: 5), .completed,
                       "first \(first.frame.minY) bar \(app.navigationBars.firstMatch.frame.maxY)")
        capture(app, name: "Computer sessions after returning")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(firstHeader.waitForExistence(timeout: 5))
        // Larger text requires scrolling to reach the computer. Navigation
        // correctly restores that offset; return to the top before checking it.
        for _ in 0..<4 where firstHeader.frame.minY < app.navigationBars.firstMatch.frame.maxY {
            app.scrollViews["sessions-scroll"].swipeDown()
        }
        // Give the pop animation a moment to settle before reading the frame.
        let settled = NSPredicate { _, _ in firstHeader.frame.minY >= app.navigationBars.firstMatch.frame.maxY }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: nil)], timeout: 5), .completed)
        capture(app, name: "Agents after navigating back")
    }

    @MainActor
    func testSettingsTitleIsVisibleAboveTheForm() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        assertRenderedTitle(app, title: "Settings")
        capture(app, name: "Settings with visible title")
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        attachUIScreenshot(app, name)
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
