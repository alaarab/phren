import SwiftUI

/// A trimmed copy of `Phren/DesignSystem/PhrenTheme.swift` for the widget
/// extension, which can't import the app target. Keep these in sync by hand
/// if the palette changes — deep-void.ts / docs/style.css are still the one
/// source of truth for the brand.
///
/// Only used for the Home Screen families (`systemSmall`/`systemMedium`).
/// Lock Screen accessory families ignore custom colors — the system renders
/// them through its own vibrant/monochrome material — so those widgets stick
/// to default text styles plus `.widgetAccentable()`.
enum WidgetTheme {
    static let bg = Color(widgetHex: 0x0A0A1A)          // --bg
    static let text = Color(widgetHex: 0xECE9F5)        // --ink
    static let textMuted = Color(widgetHex: 0xECE9F5).opacity(0.55) // --muted
    static let accent = Color(widgetHex: 0x9058F0)      // --accent
    static let cyan = Color(widgetHex: 0x28D3F2)        // --cyan
    static let green = Color(widgetHex: 0x8AC8AC)       // stateDone
    static let border = Color(widgetHex: 0x9C8FF8).opacity(0.18)    // --border
}

extension Color {
    /// Named distinctly from the app target's `Color(hex:)` — these are two
    /// separate modules, but the suffix keeps a stray copy-paste from reading
    /// like it's sharing state it isn't.
    init(widgetHex hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
