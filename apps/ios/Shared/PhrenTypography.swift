import SwiftUI

/// Shared by the app and widget targets so their text scales together.
enum PhrenTypography {
    static func icon(_ size: CGFloat, weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight) }
    static let title = Font.title
    static let title2 = Font.title2
    static let title3 = Font.title3
    static let body = Font.body
    static let subheadline = Font.subheadline
    static let footnote = Font.footnote
    static let caption = Font.caption
    static let caption2 = Font.caption2
    static let monoBody = Font.system(.body, design: .monospaced)
    static let monoSubheadline = Font.system(.subheadline, design: .monospaced)
    static let monoFootnote = Font.system(.footnote, design: .monospaced)
    static let monoCaption = Font.system(.caption, design: .monospaced)
    static let monoCaption2 = Font.system(.caption2, design: .monospaced)
}
