import XCTest

extension XCTestCase {
    /// Attach a screenshot only when a design run asked for shots
    /// (`PHREN_UI_SHOTS=1`) or once this test has already failed, so an
    /// ordinary suite run does not pay for a capture at every step. Each test
    /// class keeps its own `capture(_:_:)` signature and delegates here.
    func attachUIScreenshot(_ app: XCUIApplication, _ name: String) {
        let wanted = ProcessInfo.processInfo.environment["PHREN_UI_SHOTS"] == "1"
        let failed = testRun?.hasSucceeded == false
        guard wanted || failed else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
