import PhrenKit
import SwiftUI

/// A web fetch or search: a globe and where the agent went (or what it asked)
/// while folded; open, the prompt and the first lines of what came back as
/// Markdown, with "Read all" into the full reader. Links inside stay under
/// the transcript's web-link confirmation, which wraps the whole chat.
struct WebToolCard: View, Equatable {
    let presentation: WebToolPresentation
    let messages: [AgentChatMessage]
    /// The key the preparation pass parsed the result under (the entry's
    /// `cardMarkdownKey`); a card drawn from messages alone keys its own.
    var markdownKey: String? = nil
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.presentation == rhs.presentation && lhs.messages == rhs.messages }
    @State private var expanded = false
    @Environment(\.openToolOutput) private var openOutput
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var callID: String { messages.first?.toolCallID ?? messages.first?.id ?? "" }

    /// For rows that only have the messages: a fetch inside an expanded run.
    private static let cache = ToolCardCache<WebToolPresentation>()
    static func presentation(_ messages: [AgentChatMessage]) -> WebToolPresentation? {
        cache.value(messages) { call, result in
            WebToolPresentation(name: call.title ?? "", input: call.text, result: result?.text, isError: result?.isToolError == true)
        }
    }

    var body: some View { ChatPerformance.measure("web card row") { content } }
    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: expanded ? PhrenDensity.toolCardRowSpacing : 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
            } label: {
                HStack(spacing: PhrenTheme.Space.small) {
                    Image(systemName: "globe").font(.system(size: expanded ? 15 : 14, weight: .medium)).foregroundStyle(PhrenTheme.phrenCardAccent)
                        .frame(width: expanded ? 22 : 18, height: expanded ? 22 : 18).accessibilityHidden(true)
                    Text(presentation.location)
                        .font(expanded ? .subheadline.weight(.semibold) : PhrenTypography.footnote.weight(.semibold))
                        .foregroundStyle(PhrenTheme.text).lineLimit(expanded ? 2 : 1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    status
                    Image(systemName: "chevron.down").font(.system(size: expanded ? 10 : 12, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityHidden(true)
                }
                .frame(height: expanded ? nil : 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(presentation.title), \(presentation.location)")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Show the prompt and the first lines of the result")
            .accessibilityIdentifier("chat-web-card:\(callID)")
            if expanded { details }
        }
        .toolCard(collapsed: !expanded)
    }

    @ViewBuilder private var details: some View {
        if let url = presentation.url, url != presentation.location {
            Text(url).font(.system(.caption2, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted)
                .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
        }
        if let prompt = presentation.prompt {
            Text(prompt).font(.subheadline).foregroundStyle(PhrenTheme.textSecondary)
                .lineLimit(6).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("chat-web-prompt:\(callID)")
        }
        switch presentation.status {
        case .running:
            Text(presentation.kind == .fetch ? "Fetching…" : "Searching…").font(.caption).foregroundStyle(PhrenTheme.textMuted)
        case .succeeded, .failed:
            if let preview = ToolCardKind.web(presentation).markdownPreview {
                // The same text and key the preparation pass parsed ahead of
                // the row, so drawing never parses.
                ChatRichText(text: preview.text, reply: presentation.result, replyLabel: "Copy result",
                             cacheKey: markdownKey ?? "\(messages.first?.renderKey ?? "")|\(messages.last?.renderKey ?? "")|card").equatable()
            } else {
                Text("No result").font(.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            if let result = presentation.result, !result.isEmpty {
                Button {
                    openOutput(.init(title: presentation.title, text: result))
                } label: {
                    Label(presentation.resultTruncated ? "Read all" : "Open", systemImage: "arrow.up.left.and.arrow.down.right")
                        .font(.caption.weight(.medium)).foregroundStyle(PhrenTheme.phrenCardAccent)
                        .frame(minHeight: 32).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Read the whole result")
                .accessibilityIdentifier("chat-web-read-all:\(callID)")
            }
        }
    }

    private var status: some View {
        ToolStatusMark(status: ToolCardStatus(presentation.status), size: expanded ? 15 : 12)
    }
}
