import SwiftUI

enum PhrenAppearanceStyle: String, CaseIterable, Identifiable {
    // Keep the original saved identifier so the refined default also updates
    // installations that explicitly selected it in the first theme release.
    case charcoal = "midnight", amethyst, graphite, slate
    var id: String { rawValue }
    var name: String { self == .charcoal ? "Charcoal" : rawValue.capitalized }
    var detail: String {
        switch self {
        case .charcoal: return "Charcoal canvas. Crisp white text."
        case .amethyst: return "Deep violet. Soft lavender."
        case .graphite: return "Warm charcoal. Paper-white text."
        case .slate: return "Cool slate. Cyan and lavender."
        }
    }
    var palette: PhrenPalette {
        switch self {
        case .charcoal:
            return .init(background: 0x1E1E1E, sunken: 0x141618, surface: 0x282A2C, raised: 0x3C3F42,
                         chatCanvas: 0x1E1E1E, chatPanel: 0x0E0E0E, text: 0xFFFFFF, secondary: 0xECEDEE,
                         muted: 0xA4A9B1, dim: 0x999FA8, accent: 0xB994F4, hover: 0xDCC5FF, solid: 0x7450A7,
                         action: 0xB994F4, navigation: 0xB994F4, toolPanel: 0x121416, link: 0xC2AAFF)
        case .amethyst:
            return .init(background: 0x17121F, sunken: 0x100C17, surface: 0x251E32, raised: 0x3A2E4D,
                         chatCanvas: 0x17121F, chatPanel: 0x100D17, text: 0xEEE3FF, secondary: 0xD8CAE9,
                         muted: 0xB8A6CE, dim: 0xA491BA, accent: 0xB994F4, hover: 0xDCC5FF, solid: 0x7450A7,
                         action: 0xC39AF9, navigation: 0xDCC5FF)
        case .graphite:
            return .init(background: 0x202020, sunken: 0x181818, surface: 0x2C2B2E, raised: 0x424045,
                         chatCanvas: 0x202020, chatPanel: 0x151416, text: 0xF2EEF6, secondary: 0xDDD8E3,
                         muted: 0xBEB7C6, dim: 0xA8A1B1, accent: 0xC0AAF2, hover: 0xE0CCFF, solid: 0x756096,
                         action: 0xC0AAF2, navigation: 0xE4D9F3)
        case .slate:
            return .init(background: 0x292D3C, sunken: 0x242837, surface: 0x373D50, raised: 0x48516A,
                         chatCanvas: 0x272832, chatPanel: 0x1C1E27, text: 0xF3F2F8, secondary: 0xDCDFEF,
                         muted: 0xBCC3D8, dim: 0xABB3CA, accent: 0xB8AAF2, hover: 0xD2C5FF, solid: 0x71609E,
                         action: 0x70DBE8, navigation: 0xE4E3F5)
        }
    }
}

struct PhrenPalette: Codable, Equatable {
    var background, sunken, surface, raised: UInt32
    var chatCanvas, chatPanel, text, secondary, muted, dim: UInt32
    var accent, hover, solid, action, navigation: UInt32
    var toolPanel: UInt32? = nil
    var link: UInt32? = nil
}

struct PhrenCustomTheme: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var name: String
    var palette: PhrenPalette
}

/// Read by the shared semantic colors, so existing views update in place.
/// Changing appearance never recreates navigation, chat models, or SSH sessions.
@Observable final class PhrenAppearance {
    static let storageKey = "appearance.theme.v1"
    static let customStorageKey = "appearance.custom-themes.v2"
    static let recoveryKey = "appearance.custom-themes.recovery"
    private struct Collection: Codable {
        var schemaVersion = 2
        let themes: [PhrenCustomTheme]
    }
    static let shared = PhrenAppearance(defaults: AppRuntime.defaults)
    private let defaults: UserDefaults
    private(set) var storageIssue: String?
    var selectedID: String {
        didSet { defaults.set(selectedID, forKey: Self.storageKey) }
    }
    private(set) var customThemes: [PhrenCustomTheme] {
        didSet { if let data = try? JSONEncoder().encode(Collection(themes: customThemes)) { defaults.set(data, forKey: Self.customStorageKey) } }
    }
    var palette: PhrenPalette {
        customThemes.first { $0.id == selectedID }?.palette
            ?? (PhrenAppearanceStyle(rawValue: selectedID) ?? .charcoal).palette
    }
    var name: String {
        customThemes.first { $0.id == selectedID }?.name
            ?? (PhrenAppearanceStyle(rawValue: selectedID) ?? .charcoal).name
    }
    func save(_ theme: PhrenCustomTheme) {
        if let index = customThemes.firstIndex(where: { $0.id == theme.id }) { customThemes[index] = theme }
        else { customThemes.append(theme) }
        selectedID = theme.id
    }
    func remove(_ theme: PhrenCustomTheme) {
        if selectedID == theme.id { selectedID = PhrenAppearanceStyle.charcoal.id }
        customThemes.removeAll { $0.id == theme.id }
    }

    init(defaults: UserDefaults) {
        self.defaults = defaults
        customThemes = []
        if let data = defaults.data(forKey: Self.customStorageKey) ?? defaults.data(forKey: "appearance.custom-themes.v1") {
            do {
                let decoded: [PhrenCustomTheme]
                if defaults.data(forKey: Self.customStorageKey) != nil {
                    let collection = try JSONDecoder().decode(Collection.self, from: data)
                    guard collection.schemaVersion == 2 else { throw CocoaError(.coderReadCorrupt) }
                    decoded = collection.themes
                } else { decoded = try JSONDecoder().decode([PhrenCustomTheme].self, from: data) }
                guard Set(decoded.map(\.id)).count == decoded.count else { throw CocoaError(.coderReadCorrupt) }
                customThemes = decoded
            } catch {
                // Preserve the original bytes before any subsequent edit can
                // replace them. Reopening the app does not duplicate backups.
                var backups = defaults.array(forKey: Self.recoveryKey) as? [Data] ?? []
                if !backups.contains(data) { backups.append(data); defaults.set(backups, forKey: Self.recoveryKey) }
                storageIssue = "Saved custom themes couldn't be read. The original data is preserved for recovery; built-in themes are available."
            }
        }
        selectedID = defaults.string(forKey: Self.storageKey) ?? PhrenAppearanceStyle.charcoal.id
    }
}
