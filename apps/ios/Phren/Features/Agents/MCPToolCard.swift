import PhrenKit
import SwiftUI

/// A call to any MCP server other than phren: one quiet line while folded
/// (the tool as a verb, its server, the result's first line and how the call
/// stands); tapping opens it in place to the input as key/value rows and the
/// result's first lines, with the full input and output one tap further.
struct MCPToolCard: View, Equatable {
    let presentation: MCPToolPresentation
    let messages: [AgentChatMessage]
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.presentation == rhs.presentation && lhs.messages == rhs.messages }
    @State private var expanded = false
    @Environment(\.openToolOutput) private var openOutput
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var callID: String { messages.first?.toolCallID ?? messages.first?.id ?? "" }

    private static let cache = ToolCardCache<MCPToolPresentation>()
    static func presentation(_ messages: [AgentChatMessage]) -> MCPToolPresentation? {
        cache.value(messages) { call, result in
            MCPToolPresentation(name: call.title ?? "", input: call.text, result: result?.text, isError: result?.isToolError == true)
        }
    }

    /// The one line a folded card says after its verb.
    private var summary: String {
        presentation.resultLines.first ?? presentation.fields.first.map { "\($0.name): \($0.value)" } ?? ""
    }

    /// Everything the folded card holds, for VoiceOver and the tests.
    private var spokenLabel: String {
        var parts = ["\(presentation.server), \(presentation.verb)"]
        parts += presentation.fields.map { "\($0.name) \($0.value)" }
        parts += presentation.resultLines
        return parts.joined(separator: ", ")
    }

    var body: some View { ChatPerformance.measure("mcp card row") { content } }
    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "server.rack").font(.system(size: 13)).foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 14)
                    Text(presentation.verb).fontWeight(.semibold).foregroundStyle(PhrenTheme.chatText).lineLimit(1)
                        .layoutPriority(1)
                    Text(presentation.server).foregroundStyle(PhrenTheme.chatNeutralDim).lineLimit(1)
                    Text(summary).foregroundStyle(presentation.status == .failed ? PhrenTheme.danger : PhrenTheme.chatNeutral)
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    ToolStatusMark(status: ToolCardStatus(presentation.status))
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(PhrenTheme.chatNeutralDim)
                }
                .font(PhrenTypography.footnote)
                .padding(.horizontal, 12).frame(height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(spokenLabel)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Show the input and result")
            .accessibilityIdentifier("chat-mcp-card:\(callID)")
            if expanded { details }
        }
        .phrenPanel(tool: true)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: PhrenDensity.toolCardRowSpacing) {
            ToolCardChip(text: presentation.server)
            ForEach(Array(presentation.fields.enumerated()), id: \.offset) { _, field in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(field.name).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                    Text(field.value).foregroundStyle(PhrenTheme.textSecondary)
                }.font(.caption)
            }
            if presentation.hiddenFields > 0 {
                Text("+\(presentation.hiddenFields) more").font(.caption2).foregroundStyle(PhrenTheme.textMuted)
            }
            if !presentation.resultLines.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(presentation.resultLines.enumerated()), id: \.offset) { _, line in Text(line) }
                    if presentation.resultTruncated { Text("…").accessibilityHidden(true) }
                }
                .font(.caption.weight(presentation.status == .failed ? .medium : .regular))
                .foregroundStyle(presentation.status == .failed ? PhrenTheme.danger : PhrenTheme.textSecondary)
            }
            Button {
                let raw = messages.map { message in
                    (message.isToolResult ? "Output" : message.isChange ? "Changes" : "Input") + "\n" + message.text
                }.joined(separator: "\n\n")
                openOutput(.init(title: "\(presentation.server) · \(presentation.verb)", text: raw))
            } label: {
                Label("Full input and output", systemImage: "arrow.up.left.and.arrow.down.right")
                    .font(.caption.weight(.medium)).foregroundStyle(PhrenTheme.chatPath)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat-mcp-open:\(callID)")
        }
        .textSelection(.enabled)
        .padding(.horizontal, PhrenDensity.toolCardPadding).padding(.bottom, PhrenDensity.toolCardPadding / 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
