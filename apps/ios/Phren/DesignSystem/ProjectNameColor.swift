import PhrenKit
import SwiftUI

/// The color a project's name is drawn in: the theme's own project colour
/// (`default`), or any `#RRGGBB` chosen from the same palette and picker a
/// computer gets. Choices are per store+project and live only on this phone,
/// in `project.colour.<storeId>/<project>`.
enum ProjectNameColor: Hashable {
    case `default`
    case hex(String)

    /// The computer palette, so projects and computers share one set of colors.
    static let palette = LiveHost.colorPalette
    static let paletteNames = ["Blue", "Teal", "Green", "Amber", "Orange", "Pink", "Lavender", "Slate"]

    static func normalized(_ hex: String) -> String? {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let body = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard body.count == 6, body.allSatisfy(\.isHexDigit) else { return nil }
        return "#" + body
    }

    var title: String {
        switch self {
        case .default: return "Default"
        case .hex(let value):
            if let index = Self.palette.firstIndex(of: value) { return Self.paletteNames[index] }
            return value
        }
    }

    /// The stored hex when the color is not the theme's own.
    var hexValue: String? {
        if case .hex(let value) = self { return value }
        return nil
    }

    /// The swatch, and the color the name is drawn in on the phone.
    var color: Color {
        switch self {
        case .default: return PhrenTheme.sessionProject
        case .hex(let value): return PhrenTheme.hostColor(value)
        }
    }

    /// The resolved color as a hex string, for the widget extension which
    /// cannot read this app's UserDefaults or appearance.
    func widgetHex(for palette: PhrenPalette) -> String {
        switch self {
        case .default: return String(format: "#%06X", palette.sessionProject ?? palette.link ?? palette.action)
        case .hex(let value): return value
        }
    }

    static let storagePrefix = "project.colour."

    static func key(storeId: String, project: String) -> String { "\(storagePrefix)\(storeId)/\(project)" }

    /// Older builds stored a named token; those map onto the nearest palette entry.
    private static let legacy: [String: String] = [
        "accent": "#A78BFA", "purple": "#A78BFA", "cyan": "#35C9C0", "success": "#4CD37A", "warning": "#F2B441",
    ]

    static func stored(storeId: String, project: String) -> ProjectNameColor {
        guard let raw = AppRuntime.defaults.string(forKey: key(storeId: storeId, project: project)) else { return .default }
        if let hex = normalized(raw) { return .hex(hex) }
        if let mapped = legacy[raw] { return .hex(mapped) }
        return .default
    }

    @discardableResult
    static func set(_ value: ProjectNameColor, storeId: String, project: String) -> ProjectNameColor {
        switch value {
        case .default: AppRuntime.defaults.removeObject(forKey: key(storeId: storeId, project: project))
        case .hex(let hex): AppRuntime.defaults.set(hex, forKey: key(storeId: storeId, project: project))
        }
        return value
    }
}
