import PhrenKit
import SwiftUI

/// Ephemeral prose has no message identity, selection, links or tool actions.
struct ChatReplyPreviewRow: View {
    let preview: AgentChatPreview
    @ScaledMetric(relativeTo: .body) private var textSize = 14.5

    var body: some View {
        // A live partial, not the reply: it can stop mid-word, so it reads
        // a step quieter and ends in a caret until the transcript's text
        // replaces it.
        (Text(verbatim: preview.text).foregroundColor(PhrenTheme.chatText.opacity(0.78))
            + Text(verbatim: " ▍").foregroundColor(PhrenTheme.accent))
            // The finished reply renders in the chat's monospaced face; the
            // preview matches it so the text does not change font when it lands.
            .font(.system(size: textSize, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Reply in progress: \(preview.text)")
            .accessibilityIdentifier("chat-reply-preview")
    }
}
