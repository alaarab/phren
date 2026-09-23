import PhrenKit
import SwiftUI

/// Every materialized row's frame in the transcript's scroll space, so the
/// stack can tell which rows still sit near the viewport.
private struct ChatRowFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// A far-off screen row: its identifier and label only, at the height it last
/// measured, so its rich subtree is never laid out and scrolling does not jump.
private struct ChatRowPlaceholder: View {
    let identifier: String
    let label: String
    var body: some View {
        Color.clear
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityIdentifier(identifier)
    }
}

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
    /// The scroll viewport's height, from the chat screen; zero disables
    /// placeholder folding (the child-agent transcript stays fully drawn).
    var viewportHeight: CGFloat = 0
    let preview: (ChatAttachmentDraft) -> Void
    /// Rows more than two screens away that have a measured height draw as
    /// placeholders; the first layout measures every loaded row.
    @State private var distant: Set<String> = []
    @State private var heights: [String: CGFloat] = [:]
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.revision == rhs.revision && lhs.revealRevision == rhs.revealRevision
            && lhs.images == rhs.images && lhs.session.id == rhs.session.id
            && lhs.target == rhs.target && lhs.active == rhs.active && lhs.viewportHeight == rhs.viewportHeight
    }
    var body: some View {
        ChatPerformance.measure("transcript rows") {
            // Measure every loaded row before folding it. LazyVStack estimates
            // unseen rows from the visible ones, which puts an uneven chat's
            // bottom beyond its actual last reply.
            VStack(alignment: .leading, spacing: PhrenDensity.transcriptRowSpacing) {
                ForEach(entries) { entry in
                    ChatTranscriptRow(entry: entry, revealedText: revealed[entry.id], images: images[entry.id] ?? [],
                                      session: session, target: target, active: active, preview: preview,
                                      distantHeight: distant.contains(entry.id) ? heights[entry.id] : nil)
                        .equatable().id(entry.id)
                        .background {
                            GeometryReader { geometry in
                                Color.clear.preference(key: ChatRowFramesKey.self,
                                                       value: [entry.id: geometry.frame(in: .named("chat-scroll"))])
                            }
                        }
                }
            }
            .onPreferenceChange(ChatRowFramesKey.self) { measure($0) }
        }
    }

    /// Fold a row once it is two screens beyond the viewport and its height is
    /// known from an earlier pass; a row coming back inside is drawn in full
    /// again. Only materialized rows update their measurements, so a
    /// placeholder never feeds its own height back in.
    private func measure(_ frames: [String: CGRect]) {
        guard viewportHeight > 0 else { return }
        let slack = viewportHeight * 2
        var nextHeights = heights.filter { frames[$0.key] != nil }
        var nextDistant = Set<String>()
        for (id, frame) in frames where !frame.isNull && frame.height > 0 {
            let far = frame.maxY < -slack || frame.minY > viewportHeight + slack
            if !distant.contains(id) { nextHeights[id] = frame.height }
            if far, nextHeights[id] != nil { nextDistant.insert(id) }
        }
        if nextHeights != heights { heights = nextHeights }
        if nextDistant != distant { distant = nextDistant }
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
    /// The measured height to use while the row is far off screen; nil draws
    /// the row in full.
    var distantHeight: CGFloat? = nil
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.entry == rhs.entry && lhs.revealedText == rhs.revealedText && lhs.images == rhs.images
            && lhs.session.id == rhs.session.id && lhs.target == rhs.target && lhs.active == rhs.active
            && lhs.distantHeight == rhs.distantHeight
    }
    var body: some View {
        if let distantHeight, entry.turnActivity?.isLive != true, !entry.placeholderIdentifier.isEmpty {
            ChatRowPlaceholder(identifier: entry.placeholderIdentifier, label: entry.placeholderLabel)
                .frame(height: distantHeight)
        } else {
            row
        }
    }
    @ViewBuilder private var row: some View {
        #if DEBUG
        let _ = ChatPerformance.enabled ? Self._printChanges() : ()
        #endif
        if let activity = entry.turnActivity {
            ChatTurnActivityRow(activity: activity)
        } else if let echo = entry.pendingEcho {
            ChatPendingEchoRow(echo: echo, preview: preview)
        } else if let changes = entry.turnChanges {
            ChatTurnChangesRow(changes: changes).equatable()
        } else if let note = entry.messages.first, note.isNarration {
            ChatNarrationRow(message: note).equatable()
        } else if let compaction = entry.messages.first, compaction.isCompaction {
            ChatCompactionRow(message: compaction).equatable()
        } else if let phren = entry.phren {
            PhrenToolCard(presentation: phren, messages: entry.messages, session: session).equatable()
        } else if entry.card != nil {
            ChatToolCard(entry: entry)
        } else if entry.isReadRun {
            ChatReadRun(messages: entry.messages, presentation: entry.readRun, resultImages: resultImages,
                        imageContext: "\(target?.id ?? "")|\(active)")
        } else if entry.isActivity {
            ChatToolActivity(messages: entry.messages, resultImages: resultImages, imageContext: "\(target?.id ?? "")|\(active)",
                             hasLargeCollapsedChange: entry.hasLargeCollapsedChange)
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

/// A message sent from this phone, before its transcript row lands: the
/// same bubble, muted and uncaptioned. The real row replaces it.
struct PendingEchoActionKey: EnvironmentKey { static let defaultValue: ((UUID, Bool) -> Void)? = nil }
extension EnvironmentValues {
    /// Dismiss (false) or retry (true) a receipt the transcript never showed.
    var resolvePendingEcho: ((UUID, Bool) -> Void)? {
        get { self[PendingEchoActionKey.self] }
        set { self[PendingEchoActionKey.self] = newValue }
    }
}

private struct ChatPendingEchoRow: View {
    let echo: ChatPendingEcho
    let preview: (ChatAttachmentDraft) -> Void
    @Environment(\.resolvePendingEcho) private var resolve
    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            bubble
            if let submittedAt = echo.submittedAt, resolve != nil {
                // Only this row ticks, and only while it waits.
                TimelineView(.periodic(from: submittedAt.addingTimeInterval(ChatPendingEcho.staleAfter), by: 30)) { context in
                    if context.date.timeIntervalSince(submittedAt) >= ChatPendingEcho.staleAfter { staleActions }
                }
            }
        }
    }

    /// The message never showed up in the conversation: say so and offer a
    /// way out instead of leaving a grey bubble behind for good.
    private var staleActions: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            Text("Not seen in the chat yet").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.warning)
            Button("Dismiss") { resolve?(echo.id, false) }
                .font(PhrenTheme.Font.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                .frame(minHeight: 44).contentShape(Rectangle()).buttonStyle(.plain)
                .accessibilityIdentifier("chat-pending-dismiss:\(echo.id)")
            Button("Retry") { resolve?(echo.id, true) }
                .font(PhrenTheme.Font.caption.weight(.semibold)).foregroundStyle(PhrenTheme.accent)
                .frame(minHeight: 44).contentShape(Rectangle()).buttonStyle(.plain)
                .accessibilityIdentifier("chat-pending-retry:\(echo.id)")
        }
        .accessibilityElement(children: .contain)
    }

    private var bubble: some View {
        HStack(alignment: .top, spacing: 0) {
            Spacer(minLength: 30)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(echo.images) { item in
                    Button { preview(item) } label: {
                        ChatAttachmentImage(attachment: item.attachment).frame(maxHeight: 220).clipShape(RoundedRectangle(cornerRadius: 12))
                    }.accessibilityLabel("View attached \(item.attachment.name)")
                }
                if !echo.text.isEmpty {
                    ChatRichText(text: echo.text, messageID: nil, replyLabel: "Copy message", cacheKey: "pending:\(echo.id)").equatable()
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PhrenTheme.chatUserBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .opacity(0.5)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your message, sending: \(echo.text)")
        .accessibilityIdentifier("chat-pending-message:\(echo.id)")
    }
}

private struct ChatMessageRow<Historical: View>: View {
    let message: AgentChatMessage
    var revealedText: String? = nil
    /// A long reply unfolds in place, rendered like the rest of the bubble;
    /// the monospace pager is for tool output, not for prose (owner, Sep 21).
    @State private var expanded = false
    @State private var menuAnchor = ChatMessageMenuAnchor()
    @Environment(ChatMessageMenu.self) private var messageMenu: ChatMessageMenu?
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
        bubbleSurface
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { menuAnchor.frame = $0 }
            .environment(\.chatMessageMenuSource, ChatMessageMenuSource { paragraph, actions in
                openMenu(paragraph: paragraph, actions: actions)
            })
            .opacity(messageMenu?.request?.owner == message.id ? 0 : 1)
            .onLongPressGesture(minimumDuration: 0.4) { openMenu(paragraph: nil, actions: messageActions) }
            .accessibilityAction(named: "Message actions") { openMenu(paragraph: nil, actions: messageActions) }
    }
    private var messageActions: [PhrenControlAction] {
        [PhrenControlAction(id: "copy-message", title: "Copy message", icon: "doc.on.doc") { ChatClipboard.copy(message.text) },
         PhrenControlAction(id: "share", title: "Share", icon: "square.and.arrow.up") { messageMenu?.sharedText = message.text }]
    }
    private func openMenu(paragraph: Int?, actions: [PhrenControlAction]) {
        guard menuAnchor.frame.width > 0 else { return }
        messageMenu?.present(.init(owner: message.id, frame: menuAnchor.frame,
                                  preview: AnyView(bubbleSurface.environment(\.chatMessageMenuSource, nil)),
                                  paragraph: paragraph, actions: actions))
    }
    private var bubbleSurface: some View {
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
                if message.isQueued {
                    Text("Queued in the agent").font(PhrenTypography.caption)
                        .foregroundStyle(PhrenTheme.textMuted)
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
    @Environment(ChatMessageMenu.self) private var messageMenu: ChatMessageMenu?
    @State private var menuAnchor = ChatMessageMenuAnchor()
    var body: some View {
        if command.kind == .output && command.text.isEmpty {
            EmptyView()
        } else {
            HStack(alignment: .top, spacing: PhrenTheme.Space.small) {
                commandContent
                PhrenIconButton(icon: "ellipsis", label: "Command actions", action: openActions)
                    .phrenIdentifier("chat-command:\(id):actions")
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { menuAnchor.frame = $0 }
            .onLongPressGesture(minimumDuration: 0.4, perform: openActions)
            .accessibilityAction(named: "Command actions", openActions)
            .opacity(messageMenu?.request?.owner == "command:\(id)" ? 0 : 1)
        }
    }

    private func openActions() {
        guard menuAnchor.frame.width > 0 else { return }
        messageMenu?.present(.init(owner: "command:\(id)", frame: menuAnchor.frame,
                                  preview: AnyView(commandContent), paragraph: nil, actions: [
            .init(id: "view-output", title: "View full output", icon: "text.alignleft") {
                openOutput(.init(title: "Command output", text: command.text))
            },
            .init(id: "copy", title: "Copy", icon: "doc.on.doc") { ChatClipboard.copy(command.text) },
        ]))
    }

    private var commandContent: some View {
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
    }
}

/// Claude Code summarizing the conversation: one small centered system line.
/// The summary's words stay behind a tap, so a 25 KB summary can never draw
/// a giant bubble or throw the scroll position.
private struct ChatCompactionRow: View, Equatable {
    let message: AgentChatMessage
    @State private var showing = false
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.message == rhs.message }
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

/// Claude's narration between tool calls ("Checking the tests next"): a
/// dim italic note, not the reply. One line with an ellipsis; a tap opens
/// the whole note in place and another folds it.
private struct ChatNarrationRow: View, Equatable {
    let message: AgentChatMessage
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.message == rhs.message }
    private var note: String { message.text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
        } label: {
            (Text("Thinking: ").fontWeight(.medium) + Text(expanded ? note : note.replacingOccurrences(of: "\n", with: " ")))
                .italic()
                .font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.chatNote)
                .lineLimit(expanded ? nil : 1).truncationMode(.tail)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                .fixedSize(horizontal: false, vertical: expanded)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Thinking: \(note)")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Fold the note" : "Show the whole note")
        .accessibilityIdentifier("chat-narration:\(message.id)")
    }
}
