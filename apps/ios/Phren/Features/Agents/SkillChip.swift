import PhrenKit
import SwiftUI

/// A skill invocation as one small chip in the timeline — `/design`, the
/// arguments dimmed after it — not a card: the call is a visible event, but
/// what it loaded is the agent's business. A tap opens the result (Claude
/// Code's launch notice, or the skill body where a harness returns one) in
/// the full reader. A skill call ends a read run: it is something the
/// person should see happen, not looking around.
struct SkillChip: View, Equatable {
    let presentation: SkillCallPresentation
    let messages: [AgentChatMessage]
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.presentation == rhs.presentation && lhs.messages == rhs.messages }
    @Environment(\.openToolOutput) private var openOutput
    private var callID: String { messages.first?.toolCallID ?? messages.first?.id ?? "" }

    private static let cache = ToolCardCache<SkillCallPresentation>()
    static func presentation(_ messages: [AgentChatMessage]) -> SkillCallPresentation? {
        cache.value(messages) { call, result in
            SkillCallPresentation(name: call.title ?? "", input: call.text, result: result?.text, isError: result?.isToolError == true)
        }
    }

    var body: some View {
        Button {
            let text = presentation.result.flatMap { $0.isEmpty ? nil : $0 }
                ?? (presentation.status == .running ? "Still running." : "No output.")
            openOutput(.init(title: presentation.command, text: text))
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "command").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityHidden(true)
                Text(presentation.command).font(.system(.caption, design: .monospaced).weight(.semibold))
                    .foregroundStyle(PhrenTheme.text).lineLimit(1)
                if let args = presentation.args {
                    Text(args).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted)
                        .lineLimit(1).truncationMode(.tail)
                }
                status
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(PhrenTheme.phrenCardSurface, in: Capsule())
            .overlay(Capsule().strokeBorder(PhrenTheme.phrenCardBorder, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // Chip glyph, command and args as one element.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Skill \(presentation.command)" + (presentation.args.map { ", \($0)" } ?? ""))
        .accessibilityHint("Read what the skill loaded")
        .accessibilityIdentifier("chat-skill-chip:\(callID)")
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var status: some View {
        switch presentation.status {
        case .running:
            Image(systemName: "ellipsis").font(.caption2).foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Running")
        case .succeeded:
            EmptyView()
        case .failed:
            Image(systemName: "exclamationmark.circle").font(.caption2).foregroundStyle(PhrenTheme.danger).accessibilityLabel("Failed")
        }
    }
}
