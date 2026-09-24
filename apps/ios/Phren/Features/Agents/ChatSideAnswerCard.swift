import PhrenKit
import SwiftUI

/// Claude's `/btw` answer, pinned above the composer until dismissed. It is
/// never part of the conversation: the card says so, and nothing of it goes
/// into the timeline. Long answers scroll inside the card.
struct ChatSideAnswerCard: View {
    let side: AgentSideAnswer
    let dismiss: () -> Void
    @ScaledMetric(relativeTo: .body) private var maximumAnswerHeight = 240.0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "text.bubble").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.cyan)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Side answer").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.cyan)
                    Text("Not part of the conversation").font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                }
                Spacer(minLength: 0)
                Text(stateLabel).font(.caption2.weight(.medium)).foregroundStyle(stateColor)
                    .accessibilityIdentifier("chat-side-answer-state")
            }
            Text(side.question).font(.callout.weight(.medium)).foregroundStyle(PhrenTheme.textSecondary)
                .lineLimit(3).accessibilityIdentifier("chat-side-answer-question")
            content
            HStack(spacing: 20) {
                if side.state == .answer, let answer = side.answer {
                    Button { ChatClipboard.copy(answer) } label: {
                        Label("Copy", systemImage: "doc.on.doc").frame(minHeight: 32).contentShape(Rectangle())
                    }.accessibilityIdentifier("chat-side-answer-copy")
                }
                Spacer(minLength: 0)
                Button(action: dismiss) {
                    Text(side.state == .pending ? "Cancel" : "Dismiss").fontWeight(.semibold)
                        .frame(minHeight: 32).contentShape(Rectangle())
                }.accessibilityIdentifier("chat-side-answer-dismiss")
            }
            .font(.caption).foregroundStyle(PhrenTheme.cyan).buttonStyle(.plain)
        }
        .padding(12)
        .background(PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(PhrenTheme.border, lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-side-answer")
    }

    @ViewBuilder private var content: some View {
        switch side.state {
        case .pending:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Claude is answering beside the current turn…").font(.caption).foregroundStyle(PhrenTheme.textMuted)
            }
        case .answer:
            ScrollView {
                ChatRichText(text: side.answer ?? "", reply: side.answer, replyLabel: "Copy answer",
                             cacheKey: "side-answer:\(side.id)").equatable()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: maximumAnswerHeight).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("chat-side-answer-text")
        case .error, .cancelled:
            Text(side.answer ?? "The side question was closed in the terminal.")
                .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                .accessibilityIdentifier("chat-side-answer-text")
        }
    }

    private var stateLabel: String {
        switch side.state {
        case .pending: return "Answering"
        case .answer: return "Answered"
        case .error: return "No answer"
        case .cancelled: return "Closed"
        }
    }
    private var stateColor: Color {
        switch side.state {
        case .pending: return PhrenTheme.warning
        case .answer: return PhrenTheme.textMuted
        case .error, .cancelled: return PhrenTheme.danger
        }
    }
}
