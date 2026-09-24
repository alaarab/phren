import PhrenKit
import SwiftUI

/// Ephemeral prose has no message identity, selection, links or tool actions.
struct ChatReplyPreviewRow: View {
    let preview: AgentChatPreview

    var body: some View {
        // The same blocks, type and color as the finished reply, so the row
        // that replaces it changes nothing but the caret. Settled paragraphs
        // are parsed once; each frame parses only the growing tail.
        let document = ChatRichTextDocumentCache.streaming(preview.text)
        ChatRichText(streaming: document, owner: "chat-reply-preview")
            // No path checks for text that is still changing: the finished
            // row links paths once the computer confirms them.
            .environment(\.fileLinkContext, nil)
            .environment(\.chatMessageMenuSource, nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Reply in progress: \(document.accessibilityText)")
            .accessibilityIdentifier("chat-reply-preview")
    }
}
