import XCTest
@testable import Phren

final class AppearanceTests: XCTestCase {
    func testPhrenCardSlotsDecodeOldThemesAndFollowDarkAndLightPanels() throws {
        for style in PhrenAppearanceStyle.allCases {
            let palette = style.palette
            let oldData = try JSONEncoder().encode(palette) // Nil optional slots are absent.
            let old = try JSONDecoder().decode(PhrenPalette.self, from: oldData)
            XCTAssertEqual(old.resolvedPhrenCardAccent, palette.action)
            XCTAssertNotEqual(old.resolvedPhrenCardSurface, palette.chatPanel)
            XCTAssertEqual(old.resolvedPhrenCardSurface, palette.resolvedPhrenCardSurface)
            var custom = old
            ThemeColorField.phrenCardSurface.apply(0xEEEEEE, to: &custom)
            ThemeColorField.phrenCardBorder.apply(0xAAAAAA, to: &custom)
            ThemeColorField.phrenCardAccent.apply(0x553399, to: &custom)
            let restored = try JSONDecoder().decode(PhrenPalette.self, from: JSONEncoder().encode(custom))
            XCTAssertEqual(restored.resolvedPhrenCardSurface, 0xEEEEEE)
            XCTAssertEqual(restored.resolvedPhrenCardBorder, 0xAAAAAA)
            XCTAssertEqual(restored.resolvedPhrenCardAccent, 0x553399)
        }
        var light = PhrenAppearanceStyle.charcoal.palette
        light.chatPanel = 0xFFFFFF; light.toolPanel = 0xFFFFFF; light.action = 0x663399
        XCTAssertGreaterThan(light.resolvedPhrenCardSurface, 0xDDDDDD)
        XCTAssertLessThan(light.resolvedPhrenCardSurface, 0xFFFFFF)
    }

    func testLegacyThemeMigrationAndUnreadableDataSurvivesNewEdits() throws {
        let suite = "phren.appearance-test.\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let theme = PhrenCustomTheme(name: "Legacy", palette: PhrenAppearanceStyle.slate.palette)
        let legacy = try JSONEncoder().encode([theme])
        defaults.set(legacy, forKey: "appearance.custom-themes.v1")
        let migrated = PhrenAppearance(defaults: defaults)
        XCTAssertEqual(migrated.customThemes, [theme])
        migrated.save(theme)
        XCTAssertEqual(PhrenAppearance(defaults: defaults).customThemes, [theme])
        for broken in [Data("{invalid".utf8), Data(#"{"schemaVersion":99,"themes":[]}"#.utf8)] {
            defaults.set(broken, forKey: PhrenAppearance.customStorageKey)
            let damaged = PhrenAppearance(defaults: defaults)
            XCTAssertNotNil(damaged.storageIssue)
            XCTAssertTrue(damaged.customThemes.isEmpty)
            damaged.save(theme)
            XCTAssertTrue((defaults.array(forKey: PhrenAppearance.recoveryKey) as? [Data])?.contains(broken) == true)
        }
        XCTAssertEqual(defaults.data(forKey: "appearance.custom-themes.v1"), legacy)
    }
    func testNamedCustomThemesRoundTripEditsAndDeletion() {
        let suite = "phren.appearance-test.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("midnight", forKey: PhrenAppearance.storageKey)
        let appearance = PhrenAppearance(defaults: defaults)
        XCTAssertEqual(appearance.name, "Charcoal")
        XCTAssertEqual(appearance.palette.text, 0xFFFFFF)
        var first = PhrenCustomTheme(name: "Ocean", palette: appearance.palette)
        ThemeColorField.background.apply(0x24303B, to: &first.palette)
        ThemeColorField.accent.apply(0x56B7DE, to: &first.palette)
        appearance.save(first)
        let second = PhrenCustomTheme(name: "Evening", palette: PhrenAppearanceStyle.amethyst.palette)
        appearance.save(second)
        first.name = "Ocean blue"
        appearance.save(first)
        let reloaded = PhrenAppearance(defaults: defaults)
        XCTAssertEqual(reloaded.customThemes.count, 2)
        XCTAssertEqual(reloaded.name, "Ocean blue")
        XCTAssertEqual(reloaded.palette, first.palette)
        XCTAssertEqual(reloaded.palette.chatCanvas, 0x24303B)
        XCTAssertEqual(reloaded.palette.action, 0x56B7DE)
        reloaded.remove(first)
        XCTAssertEqual(reloaded.name, "Charcoal")
        XCTAssertEqual(PhrenAppearance(defaults: defaults).customThemes, [second])
    }

    func testOlderCustomThemeMissingSessionSlotsUsesPaletteFallbacks() throws {
        let suite = "phren.appearance-test.\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let original = PhrenCustomTheme(name: "Legacy colors", palette: PhrenAppearanceStyle.slate.palette)
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as! [String: Any]
        var palette = object["palette"] as! [String: Any]
        for key in ["sessionProject", "sessionTitle", "sessionMeta", "stateWorking", "stateWaiting", "stateDone"] { palette.removeValue(forKey: key) }
        object["palette"] = palette
        defaults.set(try JSONSerialization.data(withJSONObject: ["schemaVersion": 2, "themes": [object]]),
                     forKey: PhrenAppearance.customStorageKey)
        let loaded = try XCTUnwrap(PhrenAppearance(defaults: defaults).customThemes.first?.palette)
        XCTAssertNil(loaded.sessionProject)
        XCTAssertEqual(ThemeColorField.sessionProject.value(in: loaded), loaded.link ?? loaded.action)
        XCTAssertEqual(ThemeColorField.sessionTitle.value(in: loaded), loaded.secondary)
        XCTAssertEqual(ThemeColorField.sessionMeta.value(in: loaded), loaded.muted)
        XCTAssertEqual(ThemeColorField.stateWorking.value(in: loaded), loaded.action)
        XCTAssertEqual(ThemeColorField.stateWaiting.value(in: loaded), 0xE0BC7F)
        XCTAssertEqual(ThemeColorField.stateDone.value(in: loaded), 0x8AC8AC)
    }
}
