import PhrenKit
import SwiftUI

/// Which agent is answering, at a glance: Anthropic's asterisk for Claude,
/// a six-petal blossom for Codex, and a sparkle for Copilot. Drawn rather
/// than bundled so the marks follow the theme's foreground colours.
struct AgentProviderGlyph: View {
    let source: String?
    var size: CGFloat = 22

    var body: some View {
        Group {
            switch source {
            case "claude":
                Image(systemName: "asterisk").font(.system(size: size * 0.82, weight: .bold))
                    .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
            case "codex":
                Blossom().fill(PhrenTheme.text).frame(width: size * 0.9, height: size * 0.9)
            case "copilot":
                Image(systemName: "sparkles").font(.system(size: size * 0.78, weight: .semibold))
                    .foregroundStyle(PhrenTheme.lavender)
            default:
                Image(systemName: "person.crop.circle").font(.system(size: size * 0.82))
                    .foregroundStyle(PhrenTheme.textDim)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name).accessibilityIdentifier("chat-provider")
    }

    private var name: String {
        switch source {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "copilot": return "Copilot"
        default: return "Agent"
        }
    }

    /// Six capsules around a centre, sixty degrees apart.
    private struct Blossom: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            let center = CGPoint(x: rect.midX, y: rect.midY)
            let length = rect.width * 0.46, width = rect.width * 0.19
            for petal in 0..<6 {
                let angle = CGFloat(petal) * .pi / 3
                let capsule = Path(roundedRect: CGRect(x: -width / 2, y: -length, width: width, height: length),
                                   cornerRadius: width / 2)
                path.addPath(capsule.applying(CGAffineTransform(translationX: center.x, y: center.y).rotated(by: angle)))
            }
            return path
        }
    }
}
