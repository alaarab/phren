import XCTest
@testable import PhrenKit

final class TerminalToolbarTests: XCTestCase {
    func testDefaultAndCustomOrderRoundTrip() throws {
        XCTAssertEqual(try TerminalToolbarPreferences.read(Data()), .defaults)
        XCTAssertTrue(TerminalToolbarPreferences.defaults.items.contains(.agents))
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
        XCTAssertThrowsError(try TerminalToolbarPreferences.read(Data(#"{"version":3,"items":["keyboard"]}"#.utf8)))
        XCTAssertThrowsError(try TerminalToolbarPreferences.read(Data(#"{"version":1,"items":["future"]}"#.utf8)))
    }

    func testAgentsSitsSecondToLastByDefaultAndJoinsOlderLayoutsOnce() throws {
        let defaults = TerminalToolbarPreferences.defaults.items
        XCTAssertEqual(defaults[defaults.count - 2], .agents)
        XCTAssertEqual(defaults.last, .keyboard)
        // A version-1 layout without Agents gains it before Keyboard.
        let old = Data(#"{"version":1,"items":["control","escape","paste","keyboard"]}"#.utf8)
        let migrated = try TerminalToolbarPreferences.read(old)
        XCTAssertEqual(migrated.items, [.control, .escape, .paste, .agents, .keyboard])
        XCTAssertEqual(migrated.version, 2)
        // Once offered, leaving it out is a choice that survives.
        let chosen = try TerminalToolbarPreferences.read(Data(#"{"version":2,"items":["control","escape","paste","keyboard"]}"#.utf8))
        XCTAssertEqual(chosen.items, [.control, .escape, .paste, .keyboard])
        // A full layout is left alone rather than losing a control.
        let full = Data(#"{"version":1,"items":["control","escape","tab","arrows","shortcuts","paste","attachments","keyboard"]}"#.utf8)
        XCTAssertFalse(try TerminalToolbarPreferences.read(full).items.contains(.agents))
    }
}
