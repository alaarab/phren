import PhrenKit
import SwiftUI

struct PhrenToolCard: View, Equatable {
    let presentation: PhrenToolPresentation
    let messages: [AgentChatMessage]
    @Environment(\.openToolOutput) private var openOutput
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.presentation == rhs.presentation && lhs.messages == rhs.messages }

    var body: some View {
        Button {
            let raw = messages.map { message in
                (message.isToolResult ? "Output" : message.isChange ? "Changes" : "Input") + "\n"
                    + (message.isToolResult ? PhrenToolPresentation.readable(message.text) : message.text)
            }.joined(separator: "\n\n")
            openOutput(.init(title: presentation.verb, text: raw))
        } label: {
            VStack(alignment: .leading, spacing: PhrenDensity.toolCardRowSpacing) {
                HStack(spacing: PhrenTheme.Space.small) {
                    Image("PhrenMark").resizable().scaledToFit().frame(width: 14, height: 14).accessibilityHidden(true)
                    Text(presentation.verb).font(PhrenTypography.footnote.weight(.semibold))
                        .foregroundStyle(PhrenTheme.text).lineLimit(2)
                    Spacer(minLength: 0)
                    status
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityHidden(true)
                }
                if presentation.project != nil || presentation.tag != nil {
                    HStack(spacing: 6) {
                        if let project = presentation.project {
                            Text(project).font(.caption.weight(.medium)).lineLimit(1)
                                .foregroundStyle(PhrenTheme.sessionProject)
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(PhrenTheme.sessionProject.opacity(0.1), in: Capsule())
                        }
                        if let tag = presentation.tag {
                            Text(tag).font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                        }
                    }
                }
                if !presentation.body.isEmpty {
                    Text(presentation.body).font(.subheadline).foregroundStyle(PhrenTheme.textSecondary)
                        .lineLimit(4).frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(presentation.fields.enumerated()), id: \.offset) { _, field in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(field.name).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                        Text(field.value).foregroundStyle(PhrenTheme.textSecondary).lineLimit(2)
                    }.font(.caption)
                }
                if let summary = presentation.resultSummary {
                    Text(summary).font(.caption.weight(.medium)).lineLimit(2)
                        .foregroundStyle(presentation.status == .failed ? PhrenTheme.danger : PhrenTheme.phrenCardAccent)
                }
                ForEach(Array(presentation.titles.enumerated()), id: \.offset) { _, title in
                    Text("· \(title)").font(.caption).foregroundStyle(PhrenTheme.textSecondary).lineLimit(1)
                }
            }
            .toolCard()
            .contentShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-phren-card:\(messages.first?.toolCallID ?? messages.first?.id ?? "")")
        .accessibilityHint("Read full input and output")
    }

    @ViewBuilder private var status: some View {
        switch presentation.status {
        case .running:
            Image(systemName: "ellipsis").font(.system(size: 12, weight: .medium))
                .foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Running")
        case .succeeded:
            Image(systemName: "checkmark").font(.system(size: 12, weight: .medium))
                .foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Completed")
        case .failed:
            Image(systemName: "exclamationmark.circle").font(.system(size: 12, weight: .medium))
                .foregroundStyle(PhrenTheme.danger).accessibilityLabel("Failed")
        }
    }
}
