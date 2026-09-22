import PhrenKit
import SwiftUI

/// Ephemeral prose has no message identity, selection, links or tool actions.
struct ChatReplyPreviewRow: View {
    let preview: AgentChatPreview
    @ScaledMetric(relativeTo: .body) private var textSize = 14.5

    var body: some View {
        Text(verbatim: preview.text)
            .font(.system(size: textSize))
            .foregroundStyle(PhrenTheme.chatText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(preview.text)
            .accessibilityIdentifier("chat-reply-preview")
    }
}
