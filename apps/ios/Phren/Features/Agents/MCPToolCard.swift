import PhrenKit
import SwiftUI

/// A call to any MCP server other than phren, in the phren card's shape:
/// the server as a chip, the tool as a verb, the input as key/value rows,
/// the result's first lines, and how the call stands. Tapping opens the
/// full input and output in the reader, as the phren card does.
struct MCPToolCard: View, Equatable {
    let presentation: MCPToolPresentation
    let messages: [AgentChatMessage]
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.presentation == rhs.presentation && lhs.messages == rhs.messages }
    @Environment(\.openToolOutput) private var openOutput
    private var callID: String { messages.first?.toolCallID ?? messages.first?.id ?? "" }

    private static let cache = ToolCardCache<MCPToolPresentation>()
    static func presentation(_ messages: [AgentChatMessage]) -> MCPToolPresentation? {
        cache.value(messages) { call, result in
            MCPToolPresentation(name: call.title ?? "", input: call.text, result: result?.text, isError: result?.isToolError == true)
        }
    }

    var body: some View { ChatPerformance.measure("mcp card row") { content } }
    @ViewBuilder private var content: some View {
        Button {
            let raw = messages.map { message in
                (message.isToolResult ? "Output" : message.isChange ? "Changes" : "Input") + "\n" + message.text
            }.joined(separator: "\n\n")
            openOutput(.init(title: "\(presentation.server) · \(presentation.verb)", text: raw))
        } label: {
            VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                HStack(spacing: PhrenTheme.Space.small) {
                    Image(systemName: "server.rack").font(.system(size: 15, weight: .medium)).foregroundStyle(PhrenTheme.phrenCardAccent)
                        .frame(width: 22, height: 22).accessibilityHidden(true)
                    Text(presentation.verb).font(.subheadline.weight(.semibold))
                        .foregroundStyle(PhrenTheme.text).lineLimit(2)
                    Spacer(minLength: 0)
                    status
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityHidden(true)
                }
                ToolCardChip(text: presentation.server)
                ForEach(Array(presentation.fields.enumerated()), id: \.offset) { _, field in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(field.name).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                        Text(field.value).foregroundStyle(PhrenTheme.textSecondary).lineLimit(2)
                    }.font(.caption)
                }
                if presentation.hiddenFields > 0 {
                    Text("+\(presentation.hiddenFields) more").font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                }
                if !presentation.resultLines.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(presentation.resultLines.enumerated()), id: \.offset) { _, line in
                            Text(line).lineLimit(2)
                        }
                        if presentation.resultTruncated {
                            Text("…").accessibilityHidden(true)
                        }
                    }
                    .font(.caption.weight(presentation.status == .failed ? .medium : .regular))
                    .foregroundStyle(presentation.status == .failed ? PhrenTheme.danger : PhrenTheme.textSecondary)
                    .padding(.top, 2)
                }
            }
            .toolCard()
            .contentShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-mcp-card:\(callID)")
        .accessibilityHint("Read full input and output")
    }

    @ViewBuilder private var status: some View {
        switch presentation.status {
        case .running:
            Image(systemName: "ellipsis").foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Running")
        case .succeeded:
            Image(systemName: "checkmark").foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Completed")
        case .failed:
            Image(systemName: "exclamationmark.circle").foregroundStyle(PhrenTheme.danger).accessibilityLabel("Failed")
        }
    }
}
