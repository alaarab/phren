import XCTest
@testable import PhrenKit

final class TerminalShortcutTests: XCTestCase {
    func testDefaultsAndLegacyFavoritesSurviveRoundTrip() throws {
        let value = TerminalShortcutPreferences.defaults(favorites: "claude:/compact,codex:/model,claude:/compact,unknown:/help")
        XCTAssertEqual(value.panels[0].shortcuts.map(\.id), ["favorite:claude:/compact", "favorite:codex:/model"])
        XCTAssertEqual(try TerminalShortcutPreferences.read(value.encoded()), value)
        XCTAssertEqual(value.visiblePanels.count, 7)
        XCTAssertEqual(value.selectedPanel(preferred: "", source: "codex").id, .codex)
        var changed = value
        changed.panels[2].enabled = false
        XCTAssertEqual(changed.selectedPanel(preferred: "codex", source: "codex").id, .keys)
        changed.panels.reverse()
        changed.panels[0].shortcuts.append(TerminalShortcut(label: "Test", symbol: "bolt", kind: .binding, value: "C-b, S-t", enabled: false))
        XCTAssertEqual(try TerminalShortcutPreferences.read(changed.encoded()), changed)
    }
    func testSimpleChordsAndLiteralTextDoNotSubmitUnlessRequested() throws {
        XCTAssertEqual(try TerminalShortcut(kind: .text, value: "b1", modifiers: 1).steps(), ["\u{02}", "1"])
        XCTAssertEqual(try TerminalShortcut(kind: .text, value: "a,b", modifiers: 1).steps(), ["\u{01}", "\u{02}"])
        XCTAssertEqual(try TerminalShortcut(kind: .text, value: "a,,b", modifiers: 2).steps(), ["\u{1B}a", ",b"])
        XCTAssertEqual(try TerminalShortcut(kind: .text, value: "git status, echo done").steps(), ["git status, echo done"])
        XCTAssertEqual(try TerminalShortcut(kind: .text, value: "/help ", appendEnter: true).steps(), ["/help ", "\r"])
        XCTAssertThrowsError(try TerminalShortcut(kind: .text, value: "echo test\n").steps())
        XCTAssertThrowsError(try TerminalShortcut(kind: .text, value: "a,", modifiers: 1).steps())
    }
    func testAdvancedBindingsUseDistinctTerminalSequences() throws {
        let esc = "\u{1B}"
        XCTAssertEqual(try TerminalKeyBinding.parse("C-b, S-t"), ["\u{02}", "T"])
        XCTAssertEqual(try TerminalKeyBinding.parse("F12 h"), [esc + "[24~", "h"])
        XCTAssertEqual(try TerminalKeyBinding.parse("Ctrl+Opt+Right, Shift+Tab"), [esc + "[1;7C", esc + "[Z"])
        XCTAssertEqual(try TerminalKeyBinding.parse("Opt+Tab, Shift+Enter"), [esc + "\t", esc + "[13;2u"])
        XCTAssertEqual(try TerminalKeyBinding.parse("Ctrl+PageDown, Opt+F1"), [esc + "[6;5~", esc + "[1;3P"])
        XCTAssertEqual(try TerminalKeyBinding.parse("C-dash, plus, comma, Space"), ["\u{1F}", "+", ",", " "])
        XCTAssertEqual(try TerminalKeyBinding.parse("Shift+1, Shift+Comma, Shift+dash"), ["!", "<", "_"])
        XCTAssertEqual(try TerminalKeyBinding.parse("text:/clear"), ["/clear"])
        for input in ["F13", "Contrl-b", "Ctrl+Ctrl+b", "C-b, Unknown", "C-", "", "text:\u{1B}", String(repeating: "a,", count: 33)] {
            XCTAssertThrowsError(try TerminalKeyBinding.parse(input), input)
        }
    }
    func testMalformedPreferencesCannotDropOrMultiplyControls() throws {
        var value = TerminalShortcutPreferences.defaults()
        for i in value.panels.indices { value.panels[i].enabled = false }
        XCTAssertThrowsError(try value.encoded())
        value = .defaults(); value.panels[0].shortcuts.append(value.panels[0].shortcuts[0])
        XCTAssertThrowsError(try value.encoded())
        value = .defaults(); value.panels.removeLast()
        XCTAssertThrowsError(try value.encoded())
        value = .defaults(); value.panels[0].shortcuts[0].value = "\u{1B}[A"
        XCTAssertThrowsError(try value.encoded())
        let data = try TerminalShortcutPreferences.defaults().encoded()
        let future = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\"version\":1", with: "\"version\":2")
        XCTAssertThrowsError(try TerminalShortcutPreferences.read(Data(future.utf8)))
        XCTAssertThrowsError(try TerminalShortcutPreferences.read(Data("garbled".utf8)))
        value = .defaults()
        for index in value.panels.indices {
            value.panels[index].shortcuts = (0..<64).map { TerminalShortcut(id: String($0), kind: .text, value: String(repeating: "a", count: 4096)) }
        }
        XCTAssertThrowsError(try value.encoded(), "A saved document must fit the reader's bound")
    }
}
