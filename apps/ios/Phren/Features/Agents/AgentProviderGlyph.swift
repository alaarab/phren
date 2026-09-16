import PhrenKit
import SwiftUI

/// Which agent is answering, at a glance: the real marks — Claude's
/// starburst in Anthropic's terracotta, OpenAI's knot for Codex, GitHub
/// Copilot's goggles — as template vectors (simple-icons, CC0), so Codex and
/// Copilot follow the theme's foreground colour.
struct AgentProviderGlyph: View {
    let source: String?
    var size: CGFloat = 22

    var body: some View {
        Group {
            switch source {
            case "claude":
                Image("ClaudeMark").resizable().scaledToFit().frame(width: size * 0.92, height: size * 0.92)
                    .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
            case "codex":
                Image("CodexMark").resizable().scaledToFit().frame(width: size * 0.9, height: size * 0.9)
                    .foregroundStyle(PhrenTheme.text)
            case "copilot":
                Image("CopilotMark").resizable().scaledToFit().frame(width: size * 0.92, height: size * 0.92)
                    .foregroundStyle(PhrenTheme.text)
            case "phren":
                // phren-mascot.png keeps wide transparent margins — its ink
                // fills 0.59 × 0.67 of the square — so at the shared size it
                // drew a third smaller than the vector marks. Scaling past the
                // frame lands its height on theirs; only padding overhangs.
                Image("PhrenMascot").resizable().scaledToFit().frame(width: size, height: size)
                    .scaleEffect(1.32)
            default:
                Image(systemName: "person.crop.circle").font(.system(size: size * 0.82))
                    .foregroundStyle(PhrenTheme.textDim)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name).accessibilityIdentifier("chat-provider")
    }

    private var name: String { Self.name(for: source) }
    static func name(for source: String?) -> String {
        switch source {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "copilot": return "Copilot"
        case "phren": return "Phren"
        default: return "Agent"
        }
    }
}
