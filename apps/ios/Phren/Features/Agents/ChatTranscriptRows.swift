import PhrenKit
import SwiftUI

/// Plain values isolate transcript layout from connection, composer, usage,
/// and scroll-position changes in the observable chat model.
struct ChatTranscriptRows: View, Equatable {
    let revision: Int
    let entries: [ChatTimelineEntry]
    let revealed: [String: String]
    let revealRevision: Int
    let images: [String: [ChatAttachmentDraft]]
    let session: LiveAgentSession
    let target: AgentChatTarget?
    let active: Bool
    let preview: (ChatAttachmentDraft) -> Void
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.revision == rhs.revision && lhs.revealRevision == rhs.revealRevision
            && lhs.images == rhs.images && lhs.session.id == rhs.session.id
            && lhs.target == rhs.target && lhs.active == rhs.active
    }
    var body: some View {
        ChatPerformance.measure("transcript rows") {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(entries) { entry in
                    ChatTranscriptRow(entry: entry, revealedText: revealed[entry.id], images: images[entry.id] ?? [],
                                      session: session, target: target, active: active, preview: preview)
                        .equatable().id(entry.id)
                }
            }
        }
    }
}

private struct ChatTranscriptRow: View, Equatable {
    let entry: ChatTimelineEntry
    let revealedText: String?
    let images: [ChatAttachmentDraft]
    let session: LiveAgentSession
    let target: AgentChatTarget?
    let active: Bool
    let preview: (ChatAttachmentDraft) -> Void
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.entry == rhs.entry && lhs.revealedText == rhs.revealedText && lhs.images == rhs.images
            && lhs.session.id == rhs.session.id && lhs.target == rhs.target && lhs.active == rhs.active
    }
    var body: some View {
        #if DEBUG
        let _ = ChatPerformance.enabled ? Self._printChanges() : ()
        #endif
        if let compaction = entry.messages.first, compaction.isCompaction {
            ChatCompactionRow(message: compaction)
        } else if let phren = entry.phren {
            PhrenToolCard(presentation: phren, messages: entry.messages)
        } else if entry.card != nil {
            ChatToolCard(entry: entry)
        } else if entry.isReadRun {
            ChatReadRun(messages: entry.messages, resultImages: resultImages, imageContext: "\(target?.id ?? "")|\(active)")
        } else if entry.isActivity {
            ChatToolActivity(messages: entry.messages, resultImages: resultImages, imageContext: "\(target?.id ?? "")|\(active)")
        } else if let message = entry.messages.first {
            ChatMessageRow(message: message, revealedText: revealedText, images: images, preview: preview) {
                if let target {
                    ForEach(message.imageBlocks, id: \.self) { block in
                        ChatHistoricalImage(session: session, target: target, line: message.line, block: block, active: active, preview: preview)
                    }
                    // Pictures sent from the phone, which the transcript
                    // names by path: the same bubble, the same way.
                    ForEach(Array(message.uploadImages.enumerated()), id: \.offset) { _, path in
                        ChatHistoricalImage(session: session, target: target, upload: path, active: active, preview: preview)
                    }
                }
            }
        }
    }
    private func resultImages(_ message: AgentChatMessage) -> AnyView {
        AnyView(Group {
            if let target {
                ForEach(message.resultImages, id: \.self) { ref in
                    ChatHistoricalImage(session: session, target: target, line: message.line, block: ref.block, inner: ref.inner,
                                        active: active, preview: preview)
                }
            }
        })
    }
}

private struct ChatMessageRow<Historical: View>: View {
    let message: AgentChatMessage
    var revealedText: String? = nil
    /// A long reply unfolds in place, rendered like the rest of the bubble;
    /// the monospace pager is for tool output, not for prose (owner, Sep 21).
    @State private var expanded = false
    let images: [ChatAttachmentDraft]
    let preview: (ChatAttachmentDraft) -> Void
    @ViewBuilder let historical: () -> Historical
    /// The pictures the transcript itself carries. When there are any, the
    /// local previews of the same send would only draw them twice.
    private var inlineImages: Bool { !message.imageBlocks.isEmpty || !message.uploadImages.isEmpty }
    private var displayText: String {
        if let revealedText { return revealedText }
        return ChatMessageDisplayCache.text(for: message, imagePaths: images.compactMap(\.path), hasImages: !images.isEmpty, inlineImages: inlineImages)
    }
    private var richTextCacheKey: String {
        "\(message.renderKey)|\(inlineImages)|\(images.map(\.id))|\(revealedText?.utf8.count ?? -1)"
    }
    /// Generated replies with many inline links already draw as one rich-text
    /// element. Let the identified message bubble own that element instead of
    /// adding a second container around it.
    private var condensedAccessibilityText: String? {
        let text = displayText
        guard !text.isEmpty, !(text == "[Image attachment]" && inlineImages) else { return nil }
        let preview = ToolOutputPreview(text, lines: 40, characters: 6_000)
        let document = ChatRichTextDocumentCache.value(preview.text, key: richTextCacheKey)
        return document.condensesAccessibility ? document.accessibilityText : nil
    }
    var body: some View { ChatPerformance.measure("message row") { content } }
    @ViewBuilder private var content: some View {
        #if DEBUG
        let _ = ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" ? Self._printChanges() : ()
        #endif
        if let command = message.localCommand {
            LocalCommandRow(command: command, id: message.id)
        } else {
            bubble
        }
    }
    private var bubble: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == .user { Spacer(minLength: 30) }
            VStack(alignment: .leading, spacing: 8) {
                if !inlineImages {
                    ForEach(images) { item in
                        Button { preview(item) } label: {
                            ChatAttachmentImage(attachment: item.attachment).frame(maxHeight: 220).clipShape(RoundedRectangle(cornerRadius: 12))
                        }.accessibilityLabel("View attached \(item.attachment.name)")
                    }
                }
                historical()
                let text = displayText
                if !text.isEmpty && !(text == "[Image attachment]" && inlineImages) {
                    let preview = ToolOutputPreview(text, lines: 40, characters: 6_000)
                    ChatRichText(text: expanded ? text : preview.text, reply: text, messageID: message.id,
                                 replyLabel: message.role == .user ? "Copy message" : "Copy reply",
                                 cacheKey: expanded ? richTextCacheKey + ":full" : richTextCacheKey).equatable()
                    if preview.truncated {
                        Button(expanded ? "Show less" : "Show more") { withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() } }
                            .font(.caption).foregroundStyle(PhrenTheme.accent)
                            .frame(minHeight: 44, alignment: .leading)
                            .accessibilityIdentifier("chat-message-full:\(message.id)")
                    }
                }
                if revealedText != nil {
                    Capsule().fill(PhrenTheme.chatText).frame(width: 4, height: 13).accessibilityHidden(true)
                }
            }
            .overlay(alignment: .topLeading) {
                if message.isQueued {
                    Color.clear.frame(width: 1, height: 1).accessibilityElement()
                        .accessibilityLabel("Pending message")
                        .accessibilityIdentifier("chat-queued-tag:\(message.id)")
                }
            }
            .padding(message.role == .user ? 14 : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(message.role == .user ? PhrenTheme.chatUserBubble : .clear, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .opacity(message.isQueued ? 0.5 : 1)
        .modifier(ChatMessageAccessibility(
            role: message.role == .user ? "Your message" : "Agent reply",
            identifier: "chat-message:\(message.id)",
            condensedText: condensedAccessibilityText
        ))
        // The bubble's menu: pictures, padding, anything that is not a
        // block. Each block of text has its own, nearer menu that wins.
        .contextMenu {
            Button("Copy message", systemImage: "doc.on.doc") { ChatClipboard.copy(message.text) }
            ShareLink(item: message.text)
        }
    }
}

private struct ChatMessageAccessibility: ViewModifier {
    let role: String
    let identifier: String
    let condensedText: String?

    @ViewBuilder func body(content: Content) -> some View {
        if let condensedText {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(role): \(condensedText)")
                .accessibilityIdentifier(identifier)
        } else {
            content
                .accessibilityElement(children: .contain)
                .accessibilityLabel(role)
                .accessibilityIdentifier(identifier)
        }
    }
}

/// A slash command or `!` shell line typed at the agent's own prompt, and
/// what it printed: system text inline, not a bubble of angle brackets.
private struct LocalCommandRow: View {
    let command: AgentChatMessage.LocalCommand
    let id: String
    @Environment(\.openToolOutput) private var openOutput
    var body: some View {
        if command.kind == .output && command.text.isEmpty {
            EmptyView()
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Group {
                    switch command.kind {
                    case .command: Image(systemName: "command")
                    case .shell: Image(systemName: "terminal")
                    case .output: Image(systemName: "arrow.turn.down.right")
                    }
                }
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 14)
                .accessibilityHidden(true)
                Text(ToolOutputPreview(command.text, lines: 12, characters: 2_000).text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(command.kind == .output ? PhrenTheme.textMuted : PhrenTheme.textSecondary)
                    .lineLimit(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(command.kind == .output ? "Command output: \(command.text)" : "Command: \(command.text)")
            .accessibilityIdentifier("chat-command:\(id)")
            .contextMenu {
                Button("View full output") { openOutput(.init(title: "Command output", text: command.text)) }
                Button("Copy", systemImage: "doc.on.doc") { ChatClipboard.copy(command.text) }
            }
        }
    }
}

/// Claude Code summarizing the conversation: one small centered system line.
/// The summary's words stay behind a tap, so a 25 KB summary can never draw
/// a giant bubble or throw the scroll position.
private struct ChatCompactionRow: View {
    let message: AgentChatMessage
    @State private var showing = false
    private var hasText: Bool { !message.text.isEmpty }
    var body: some View {
        if hasText {
            Button { showing = true } label: { label }
                .buttonStyle(.plain)
                .accessibilityLabel("Conversation compacted")
                .accessibilityHint("Open the summary")
                .accessibilityIdentifier("chat-compaction")
                .sheet(isPresented: $showing) { summarySheet }
        } else {
            label
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Conversation compacted")
                .accessibilityIdentifier("chat-compaction")
        }
    }
    private var label: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 11, weight: .semibold))
            Text("Conversation compacted").font(.caption)
        }
        .foregroundStyle(PhrenTheme.textMuted)
        .frame(maxWidth: .infinity).frame(height: 32)
        .contentShape(Rectangle())
    }
    private var summarySheet: some View {
        NavigationStack {
            ScrollView {
                Text(message.text).font(.system(.body, design: .monospaced))
                    .foregroundStyle(PhrenTheme.chatText).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
            .background(PhrenTheme.chatPanel)
            .navigationTitle("Conversation compacted").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showing = false }.accessibilityIdentifier("chat-compaction-done")
                }
            }
        }
    }
}
