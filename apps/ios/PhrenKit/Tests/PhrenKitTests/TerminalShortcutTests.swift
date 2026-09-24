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
        // Only a version-1 layout is migrated; an unknown future version is
        // rejected rather than silently rewritten.
        let data = try TerminalShortcutPreferences.defaults().encoded()
        let future = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\"version\":2", with: "\"version\":99")
        XCTAssertThrowsError(try TerminalShortcutPreferences.read(Data(future.utf8)))
        XCTAssertThrowsError(try TerminalShortcutPreferences.read(Data("garbled".utf8)))
        value = .defaults()
        for index in value.panels.indices {
            value.panels[index].shortcuts = (0..<64).map { TerminalShortcut(id: String($0), kind: .text, value: String(repeating: "a", count: 4096)) }
        }
        XCTAssertThrowsError(try value.encoded(), "A saved document must fit the reader's bound")
    }
    func testDefaultsAppendPermissionModeShortcutOnlyToClaudePanel() throws {
        let value = TerminalShortcutPreferences.defaults()
        let shortcutID = TerminalShortcutPreferences.permissionModeShortcut.id
        let claude = value.panels.first { $0.id == .claude }!
        XCTAssertEqual(claude.shortcuts.last?.id, shortcutID)
        for id: TerminalShortcutPanelID in [.codex, .copilot] {
            let panel = value.panels.first { $0.id == id }!
            XCTAssertFalse(panel.shortcuts.contains { $0.id == shortcutID }, "\(id) should not carry the Claude-only shortcut")
        }
        let keysPanel = value.panels.first { $0.id == .keys }!
        let shiftTabKey = keysPanel.shortcuts.first { $0.label == "⇧ Tab" }!
        XCTAssertEqual(try TerminalShortcutPreferences.permissionModeShortcut.steps(), try shiftTabKey.steps())
        XCTAssertEqual(try TerminalKeyBinding.parse("Shift+Tab"), try shiftTabKey.steps())
    }
    /// Builds a version-1 payload by decoding the current defaults() into a
    /// JSON object, forcing "version" to 1, then editing the Claude panel's
    /// shortcuts array directly (version is private(set), so this is the only
    /// way to produce a legacy document).
    private func legacyV1Payload(mutatingClaudeShortcuts mutate: (inout [[String: Any]]) -> Void) throws -> Data {
        let data = try TerminalShortcutPreferences.defaults().encoded()
        var json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        json["version"] = 1
        var panels = json["panels"] as! [[String: Any]]
        let claudeIndex = panels.firstIndex { ($0["id"] as? String) == TerminalShortcutPanelID.claude.rawValue }!
        var claudePanel = panels[claudeIndex]
        var shortcuts = claudePanel["shortcuts"] as! [[String: Any]]
        mutate(&shortcuts)
        claudePanel["shortcuts"] = shortcuts
        panels[claudeIndex] = claudePanel
        json["panels"] = panels
        return try JSONSerialization.data(withJSONObject: json)
    }
    func testVersion1LayoutMigratesPermissionModeShortcutOnce() throws {
        let shortcutID = TerminalShortcutPreferences.permissionModeShortcut.id
        let v1Data = try legacyV1Payload { shortcuts in
            shortcuts.removeAll { ($0["id"] as? String) == shortcutID }
        }
        let migrated = try TerminalShortcutPreferences.read(v1Data)
        XCTAssertEqual(migrated.version, 2)
        let claude = migrated.panels.first { $0.id == .claude }!
        XCTAssertEqual(claude.shortcuts.filter { $0.id == shortcutID }.count, 1)
        XCTAssertEqual(claude.shortcuts.last?.id, shortcutID)
        try migrated.validate()
        // Folded from testVersion1LayoutAlreadyCarryingShortcutIsNotDuplicated.
        do {
            let shortcutID = TerminalShortcutPreferences.permissionModeShortcut.id
            let v1Data = try legacyV1Payload { _ in } // Claude panel already has the shortcut, as in defaults().
            let migrated = try TerminalShortcutPreferences.read(v1Data)
            XCTAssertEqual(migrated.version, 2)
            let claude = migrated.panels.first { $0.id == .claude }!
            XCTAssertEqual(claude.shortcuts.filter { $0.id == shortcutID }.count, 1)
            XCTAssertEqual(Set(claude.shortcuts.map(\.id)).count, claude.shortcuts.count)
        }
    }
    func testVersion2LayoutWithoutShortcutStaysRemovedAfterRead() throws {
        var value = TerminalShortcutPreferences.defaults()
        let shortcutID = TerminalShortcutPreferences.permissionModeShortcut.id
        let claudeIndex = value.panels.firstIndex { $0.id == .claude }!
        value.panels[claudeIndex].shortcuts.removeAll { $0.id == shortcutID }
        let data = try value.encoded()
        let readBack = try TerminalShortcutPreferences.read(data)
        XCTAssertEqual(readBack.version, 2)
        XCTAssertFalse(readBack.panels[claudeIndex].shortcuts.contains { $0.id == shortcutID })
        XCTAssertEqual(readBack, value)
    }
}
