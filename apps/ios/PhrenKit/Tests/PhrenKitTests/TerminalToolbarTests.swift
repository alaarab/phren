import XCTest
@testable import PhrenKit

final class TerminalToolbarTests: XCTestCase {
    func testDefaultAndCustomOrderRoundTrip() throws {
        XCTAssertEqual(try TerminalToolbarPreferences.read(Data()), .defaults)
        let value = TerminalToolbarPreferences(items: [.enter, .keyboard, .interrupt, .arrows])
        XCTAssertEqual(try TerminalToolbarPreferences.read(value.encoded()), value)
        XCTAssertEqual(TerminalToolbarItem.interrupt.sequence, "\u{03}")
        XCTAssertEqual(TerminalToolbarItem.enter.sequence, "\r")
    }
    func testKeyboardCannotBeLostAndDuplicateOrOversizedBarsAreRejected() throws {
        let invalid: [[TerminalToolbarItem]] = [[.enter], [.keyboard, .keyboard], Array(TerminalToolbarItem.allCases.prefix(9))]
        for items in invalid {
            XCTAssertThrowsError(try TerminalToolbarPreferences(items: items).encoded())
        }
        XCTAssertThrowsError(try TerminalToolbarPreferences.read(Data(#"{"version":2,"items":["keyboard"]}"#.utf8)))
        XCTAssertThrowsError(try TerminalToolbarPreferences.read(Data(#"{"version":1,"items":["future"]}"#.utf8)))
    }
}
