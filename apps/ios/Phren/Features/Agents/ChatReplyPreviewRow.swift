import PhrenKit
import SwiftUI

/// Ephemeral prose has no message identity, selection, links or tool actions.
struct ChatReplyPreviewRow: View {
    let preview: AgentChatPreview
    @ScaledMetric(relativeTo: .body) private var textSize = 14.5

    var body: some View {
        Text(verbatim: preview.text)
            // The finished reply renders in the chat's monospaced face; the
            // preview matches it so the text does not change font when it lands.
            .font(.system(size: textSize, design: .monospaced))
            .foregroundStyle(PhrenTheme.chatText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(preview.text)
            .accessibilityIdentifier("chat-reply-preview")
    }
}
