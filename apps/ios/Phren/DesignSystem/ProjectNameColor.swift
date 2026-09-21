import SwiftUI

/// The colour a project's name is drawn in. A small palette of named phren
/// colours, or `default` for the theme's own project colour. Choices are
/// per store+project and live only on this phone, in
/// `project.colour.<storeId>/<project>`.
enum ProjectNameColor: String, CaseIterable, Identifiable {
    case `default`, accent, cyan, success, warning, purple

    var id: String { rawValue }

    var title: String {
        switch self {
        case .default: return "Default"
        case .accent: return "Accent"
        case .cyan: return "Cyan"
        case .success: return "Success"
        case .warning: return "Warning"
        case .purple: return "Purple"
        }
    }

    /// The swatch, and the colour the name is drawn in on the phone.
    var color: Color {
        switch self {
        case .default: return PhrenTheme.sessionProject
        case .accent: return PhrenTheme.accent
        case .cyan: return PhrenTheme.cyan
        case .success: return PhrenTheme.success
        case .warning: return PhrenTheme.warning
        case .purple: return Color(hex: 0xC2AAFF)
        }
    }

    /// The resolved colour as a hex string, for the widget extension which
    /// cannot read this app's UserDefaults or appearance.
    func widgetHex(for palette: PhrenPalette) -> String {
        let value: UInt32
        switch self {
        case .default: value = palette.sessionProject ?? palette.link ?? palette.action
        case .accent: value = palette.accent
        case .cyan: value = palette.action
        case .success: value = 0x8AC8AC
        case .warning: value = 0xE0BC7F
        case .purple: value = 0xC2AAFF
        }
        return String(format: "#%06X", value)
    }

    static let storagePrefix = "project.colour."

    static func key(storeId: String, project: String) -> String { "\(storagePrefix)\(storeId)/\(project)" }

    static func stored(storeId: String, project: String) -> ProjectNameColor {
        guard let raw = AppRuntime.defaults.string(forKey: key(storeId: storeId, project: project)),
              let value = ProjectNameColor(rawValue: raw) else { return .default }
        return value
    }

    @discardableResult
    static func set(_ value: ProjectNameColor, storeId: String, project: String) -> ProjectNameColor {
        if value == .default {
            AppRuntime.defaults.removeObject(forKey: key(storeId: storeId, project: project))
        } else {
            AppRuntime.defaults.set(value.rawValue, forKey: key(storeId: storeId, project: project))
        }
        return value
    }
}
