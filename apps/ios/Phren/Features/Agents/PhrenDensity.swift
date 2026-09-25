import CoreGraphics

/// The fixed measurements the density pass settles on (owner, September 21):
/// the chat chrome, the transcript and the Changes screen. Moshi is the
/// reference for how much work fits on a phone, so these live in one place
/// rather than as scattered literals, and a unit test holds them still.
enum PhrenDensity {
    /// The gap between the chat header capsule and the safe area.
    static let chatHeaderTop: CGFloat = 4
    /// The gap between the composer and the home indicator.
    static let composerBottom: CGFloat = 4
    /// The gap between the composer and the keyboard's suggestion bar
    /// (owner, September 24: the box sat almost on it).
    static let composerAboveKeyboard: CGFloat = 10
    /// The gap between two transcript entries.
    static let transcriptRowSpacing: CGFloat = 6
    /// An expanded tool card: its internal padding and the gap between rows.
    static let toolCardPadding: CGFloat = 6
    static let toolCardRowSpacing: CGFloat = 2
    /// The collapsed tool pill (owner, September 23: less padding, more on
    /// screen). Its touch target still reaches 44 points through
    /// `toolRowTouchOutset` above and below the drawn pill.
    static let collapsedToolRowHeight: CGFloat = 36
    static var toolRowTouchOutset: CGFloat { (44 - collapsedToolRowHeight) / 2 }
    /// The Changes list row.
    static let changesRowHeight: CGFloat = 44
    /// The Changes section band and the icon tabs inside it.
    static let changesBandHeight: CGFloat = 40
    static let changesIconTabHeight: CGFloat = 32
    /// The Working tree row and its indent per level.
    static let treeRowHeight: CGFloat = 32
    static let treeIndent: CGFloat = 12
}
