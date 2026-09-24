import UIKit
import XCTest
@testable import Phren

/// A chat pushed over Agents (or opened from the terminal) makes the screen
/// under it disappear; that must not switch auto-lock back on.
@MainActor
final class ScreenAwakeTests: XCTestCase {
    override func tearDown() { ScreenAwake.hold("agents", false); ScreenAwake.hold("chat", false); super.tearDown() }

    func testTheScreenStaysAwakeWhileAnyScreenStillHoldsIt() {
        ScreenAwake.hold("agents", true)
        ScreenAwake.hold("chat", true)
        ScreenAwake.hold("agents", false)   // Agents goes under the chat
        XCTAssertTrue(UIApplication.shared.isIdleTimerDisabled, "The chat still holds it")
        ScreenAwake.hold("chat", false)
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
    }
}
