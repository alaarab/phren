import SwiftUI

/// Semantic colors follow the saved appearance without resetting view state.
enum PhrenTheme {
    private static var palette: PhrenPalette { PhrenAppearance.shared.palette }
    static var bg: Color { Color(hex: palette.background) }
    static var bgSunken: Color { Color(hex: palette.sunken) }
    static var surface: Color { Color(hex: palette.surface) }
    static var surfaceRaised: Color { Color(hex: palette.raised) }

    // Chat uses quieter surfaces so the transcript carries the hierarchy.
    static var chatCanvas: Color { Color(hex: palette.chatCanvas) }
    static var chatPanel: Color { Color(hex: palette.chatPanel) }
    static var toolPanel: Color { Color(hex: palette.toolPanel ?? palette.chatPanel) }
    static var link: Color { Color(hex: palette.link ?? palette.action) }

    static var text: Color { Color(hex: palette.text) }
    static var textSecondary: Color { Color(hex: palette.secondary) }
    static var textMuted: Color { Color(hex: palette.muted) }
    static var textDim: Color { Color(hex: palette.dim) }

    static var navigation: Color { Color(hex: palette.navigation) }
    static var accent: Color { Color(hex: palette.accent) }
    static var accentHover: Color { Color(hex: palette.hover) }
    static var accentSolid: Color { Color(hex: palette.solid) }
    static var cyan: Color { Color(hex: palette.action) }
    static var lavender: Color { accent }

    static let border = Color.white.opacity(0.07)
    static let borderStrong = Color.white.opacity(0.14)

    static let success = Color(hex: 0x8AC8AC)
    static let warning = Color(hex: 0xE0BC7F)
    static let danger = Color(hex: 0xEF9898)

    /// The transcript reads in plain white and grey whatever the theme's
    /// tinted text tokens are — Amethyst and Graphite cast their muted greys
    /// lavender, which is right for chrome and wrong for a wall of prose and
    /// shell commands. The theme's accent stays on Send and Stop.
    static let chatText = Color.white
    static let chatNeutral = Color(hex: 0xA9AEB6)
    static let chatNeutralDim = Color(hex: 0x868B93)
    static let chatUserBubble = Color.white.opacity(0.08)

    // Aliases kept for call-site readability
    static let green = success
    static let amber = warning
    static let red = danger
    static var violet: Color { accentSolid }

    /// Semantic chip colors shared across screens.
    static func chipColor(_ role: ChipRole) -> Color {
        switch role {
        case .project: return cyan
        case .store: return lavender
        case .type: return accent
        case .status: return warning
        case .scope: return accentHover
        case .good: return success
        case .warn: return warning
        case .bad: return danger
        }
    }

    enum ChipRole {
        case project, store, type, status, scope, good, warn, bad
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

// MARK: - Screen scaffolding

extension View {
    func phrenScreen() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background(PhrenTheme.bg)
    }

    func phrenCard() -> some View {
        self
            .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(PhrenTheme.border, lineWidth: 1))
    }

    func phrenRow() -> some View {
        self.listRowBackground(PhrenTheme.surface)
            .listRowSeparatorTint(PhrenTheme.borderStrong)
    }
}

/// Apply row styling inside the builder: a background on List alone leaves
/// the system gray cells in place. Keep native scrolling, selection and forms.
struct PhrenList<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        List { content.phrenRow() }
            .listStyle(.insetGrouped)
            .phrenScreen()
    }
}

struct PhrenForm<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        Form { content.phrenRow() }
            .phrenScreen()
    }
}

/// A shared silhouette makes menus feel related without coloring every row.
struct PhrenMenuRow: View {
    let title: String
    var subtitle: String? = nil
    let icon: String
    var color: Color = PhrenTheme.textSecondary

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(color)
                .frame(width: 40, height: 40)
                .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(PhrenTheme.text)
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
    }
}

/// Counts are metadata, so avoid the full-size icon column used by list rows.
struct PhrenMetadataLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

// MARK: - Mascot + cute pieces

/// The pixel-art phren, optionally bobbing like the site's animated poses.
struct PhrenMascotView: View {
    var size: CGFloat = 140
    var bobbing = true
    var glow = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var up = false

    var body: some View {
        Image("PhrenMascot")
            .resizable()
            .interpolation(.none)
            .scaledToFit()
            .frame(width: size, height: size)
            .shadow(color: glow ? PhrenTheme.cyan.opacity(0.25) : .clear, radius: size / 6)
            .offset(y: up && !reduceMotion ? -6 : 0)
            .animation(
                bobbing && !reduceMotion ? .easeInOut(duration: 1.4).repeatForever(autoreverses: true) : nil,
                value: up
            )
            .onAppear { if bobbing { up = true } }
            .accessibilityHidden(true)
    }
}
