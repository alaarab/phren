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
        let invalid: [[TerminalToolbarItem]] = [[.enter], [.keyboard, .keyboard], Array(TerminalToolbarItem.allCases.prefix(10))]
        for items in invalid {
            XCTAssertThrowsError(try TerminalToolbarPreferences(items: items).encoded())
        }
        XCTAssertThrowsError(try TerminalToolbarPreferences.read(Data(#"{"version":4,"items":["keyboard"]}"#.utf8)))
        XCTAssertThrowsError(try TerminalToolbarPreferences.read(Data(#"{"version":1,"items":["future"]}"#.utf8)))
    }

    func testAgentsSitsSecondToLastByDefaultAndJoinsOlderLayoutsOnce() throws {
        let defaults = TerminalToolbarPreferences.defaults.items
        XCTAssertEqual(defaults[defaults.count - 2], .agents)
        XCTAssertEqual(defaults.last, .keyboard)
        // A version-1 layout without Agents gains it before Keyboard (and
        // Chat, offered in the same read, lands in front of it).
        let old = Data(#"{"version":1,"items":["control","escape","paste","keyboard"]}"#.utf8)
        let migrated = try TerminalToolbarPreferences.read(old)
        XCTAssertEqual(migrated.items, [.control, .escape, .paste, .chat, .agents, .keyboard])
        XCTAssertEqual(migrated.version, 3)
        // Once offered, leaving Agents out is a choice that survives.
        let chosen = try TerminalToolbarPreferences.read(Data(#"{"version":2,"items":["control","escape","paste","keyboard"]}"#.utf8))
        XCTAssertFalse(chosen.items.contains(.agents))
        // A full layout is left alone rather than losing a control.
        let full = Data(#"{"version":1,"items":["control","escape","tab","arrows","shortcuts","paste","attachments","workspaces","keyboard"]}"#.utf8)
        XCTAssertFalse(try TerminalToolbarPreferences.read(full).items.contains(.agents))
    }

    func testChatSitsBeforeAgentsByDefaultAndJoinsOlderLayoutsOnce() throws {
        let defaults = TerminalToolbarPreferences.defaults.items
        XCTAssertEqual(defaults.firstIndex(of: .chat), defaults.firstIndex(of: .agents).map { $0 - 1 })
        // A version-2 layout gains Chat just before Agents when there is room.
        let withAgents = Data(#"{"version":2,"items":["control","escape","agents","keyboard"]}"#.utf8)
        let migrated = try TerminalToolbarPreferences.read(withAgents)
        XCTAssertEqual(migrated.items, [.control, .escape, .chat, .agents, .keyboard])
        XCTAssertEqual(migrated.version, 3)
        // Without Agents it takes the defaults' place before Keyboard, and
        // Agents is not offered again.
        let withoutAgents = try TerminalToolbarPreferences.read(Data(#"{"version":2,"items":["control","escape","paste","keyboard"]}"#.utf8))
        XCTAssertEqual(withoutAgents.items, [.control, .escape, .paste, .chat, .keyboard])
        // The old eight-slot defaults, saved as a choice, gain Chat in the
        // ninth slot; a bar already at nine is left alone.
        let eight = Data(#"{"version":2,"items":["control","escape","tab","arrows","shortcuts","paste","agents","keyboard"]}"#.utf8)
        XCTAssertEqual(try TerminalToolbarPreferences.read(eight).items, TerminalToolbarPreferences.defaults.items)
        let full = Data(#"{"version":2,"items":["control","escape","tab","arrows","shortcuts","paste","attachments","agents","keyboard"]}"#.utf8)
        XCTAssertFalse(try TerminalToolbarPreferences.read(full).items.contains(.chat))
        // Once offered, leaving Chat out is a choice that survives a re-read.
        let chosen = try TerminalToolbarPreferences.read(Data(#"{"version":3,"items":["control","escape","agents","keyboard"]}"#.utf8))
        XCTAssertEqual(chosen.items, [.control, .escape, .agents, .keyboard])
        XCTAssertEqual(try TerminalToolbarPreferences.read(chosen.encoded()), chosen)
    }
}
