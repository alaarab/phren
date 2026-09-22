import PhrenKit
import SwiftUI

/// Native Markdown paragraphs, fenced code and pipe tables; no remote web content is loaded.
/// Each prose block has its own hold menu (that paragraph, or the whole
/// reply) and swaps in native text selection on a double-tap.
struct ChatRichText: View, Equatable {
    let text: String
    /// The whole message the blocks came from, for "Copy reply": `text` may
    /// be the cut-short preview.
    let reply: String
    let messageID: String?
    let replyLabel: String
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.text == rhs.text && lhs.reply == rhs.reply && lhs.messageID == rhs.messageID }
    @ScaledMetric(relativeTo: .body) private var textSize = 14.5
    @ScaledMetric(relativeTo: .headline) private var headingSize = 15.5
    private let document: ChatRichTextDocument
    /// Keys this message's selection state; the message id when there is one.
    private let owner: String
    init(text: String, reply: String? = nil, messageID: String? = nil, replyLabel: String = "Copy reply", cacheKey: String? = nil) {
        self.text = text
        self.reply = reply ?? text
        self.messageID = messageID
        self.replyLabel = replyLabel
        let key = cacheKey ?? ChatRenderKey.text(text)
        owner = messageID ?? key
        document = ChatRichTextDocumentCache.value(text, key: key)
    }
    @ViewBuilder var body: some View {
        if document.condensesAccessibility {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(document.accessibilityText)
        } else {
            content
        }
    }
    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(document.blocks) { block in
                if let language = block.language {
                    ChatCodeBlock(text: block.text, language: language)
                } else if !block.rows.isEmpty {
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                            ForEach(Array(block.rows.enumerated()), id: \.offset) { rowIndex, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { column, _ in
                                        Text(ChatInlineCode.tinted(block.attributedRows[rowIndex][column]))
                                            .font(.system(size: textSize, weight: rowIndex == 0 ? .semibold : .regular, design: .monospaced))
                                            .foregroundStyle(rowIndex == 0 ? PhrenTheme.chatNeutral : PhrenTheme.chatText)
                                    }
                                }
                                if rowIndex == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                            }
                        }
                        .tint(PhrenTheme.link)
                    }
                    .padding(12).background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(PhrenTheme.border, lineWidth: 1))
                    .contextMenu {
                        Button("Copy table", systemImage: "tablecells") {
                            ChatClipboard.copy(block.rows.map { $0.joined(separator: " | ") }.joined(separator: "\n"))
                        }
                        Button(replyLabel, systemImage: "doc.on.doc") { ChatClipboard.copy(reply) }
                        ShareLink(item: reply)
                    }
                } else {
                    ChatParagraph(block: block, owner: owner, messageID: messageID, reply: reply, replyLabel: replyLabel,
                                  size: block.heading ? headingSize : textSize)
                }
            }
        }
    }
}

/// One prose block. Hold for its own menu; double-tap for native selection:
/// `ChatSelectableText` lies over this Text at the same frame, the word
/// under the finger already selected, until a tap anywhere else, a scroll,
/// or Done. The Text stays in the layout, invisible, so nothing moves.
private struct ChatParagraph: View {
    let block: ChatRichTextDocument.Block
    let owner: String
    let messageID: String?
    let reply: String
    let replyLabel: String
    let size: CGFloat
    @Environment(ChatTextSelection.self) private var selection: ChatTextSelection?
    var body: some View {
        let selecting = selection?.target(owner, block.id)
        Text(ChatInlineCode.tinted(block.attributed))
            .font(.system(size: size, weight: block.heading ? .semibold : .regular, design: .monospaced))
            .foregroundStyle(PhrenTheme.chatText)
            .lineSpacing(3).tint(PhrenTheme.link)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .opacity(selecting == nil ? 1 : 0)
            .accessibilityHidden(selecting != nil)
            // A double-tap alone: single taps on links inside keep their speed.
            .onTapGesture(count: 2) { point in selection?.begin(owner: owner, block: block.id, at: point) }
            .contextMenu {
                Button("Copy paragraph", systemImage: "text.quote") { ChatClipboard.copy(block.text) }
                Button("Select text", systemImage: "character.cursor.ibeam") { selection?.begin(owner: owner, block: block.id, at: nil) }
                Button(replyLabel, systemImage: "doc.on.doc") { ChatClipboard.copy(reply) }
                ShareLink(item: reply)
            }
            .overlay {
                if let selecting {
                    ChatSelectableText(attributed: ChatInlineCode.tinted(block.attributed), heading: block.heading, size: size,
                                       point: selecting.point, identifier: "chat-selectable:\(messageID ?? owner):\(block.id)",
                                       touched: { selection?.noteTouchInside() },
                                       resigned: { selection?.end(owner: owner, block: block.id) })
                }
            }
            // Done sits in the paragraph's own bottom-right corner, the
            // one spot that is usually blank (a last line rarely fills).
            .overlay(alignment: .bottomTrailing) {
                if selecting != nil {
                    Button("Done") { selection?.end() }
                        .font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.chatText)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(PhrenTheme.surfaceRaised, in: Capsule())
                        .overlay(Capsule().strokeBorder(PhrenTheme.border, lineWidth: 1))
                        .accessibilityIdentifier("chat-selectable-done")
                }
            }
            // Tests find a paragraph by this marker, not by an identifier on
            // the Text (which would hide the links inside it). It sits a few
            // points in from the corner, on the first word, where a press
            // lands inside the paragraph at every text size; VoiceOver never
            // meets it.
            .overlay(alignment: .topLeading) {
                if let messageID, Self.testing {
                    Color.clear.frame(width: 1, height: 1).padding(4).allowsHitTesting(false)
                        .accessibilityElement()
                        .accessibilityLabel(block.heading ? "Heading" : "Paragraph")
                        .accessibilityIdentifier("chat-paragraph:\(messageID):\(block.id)")
                }
            }
    }
    // These transparent hit targets exist only for the paragraph interaction
    // fixture. Adding one for every paragraph in every UI test makes an
    // unrelated long transcript's accessibility snapshot much larger.
    private static let testing = AppRuntime.isUITesting
        && ProcessInfo.processInfo.arguments.contains("--chat-paragraphs")
}

/// A fenced block is just the code: no title bar. Press and hold copies it
/// (a "Copied" flash and a tap of haptics say so); when the preview is cut
/// short, a tap opens the whole thing. The language sits faintly in the
/// corner, costing no height.
private struct ChatCodeBlock: View {
    let text: String
    let language: String
    @Environment(\.openToolOutput) private var openOutput
    @State private var copied = false
    @State private var flash: Task<Void, Never>?
    var body: some View {
        let preview = ToolOutputPreview(text, lines: 12, characters: 2_000)
        let title = language.isEmpty ? "Code" : language
        Text(CodeHighlighting.highlightedBlock(preview.text, language: .detect(language)))
            .font(.system(size: 14.5, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
            .lineLimit(12).frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .overlay(alignment: .topTrailing) {
                if !language.isEmpty || preview.truncated {
                    Text(preview.truncated ? "\(language.isEmpty ? "" : language + " · ")tap for all" : language)
                        .font(.caption2).foregroundStyle(PhrenTheme.chatNeutralDim)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                }
            }
            // One accessibility element for the code itself; the "Copied"
            // flash sits outside it so it stays visible to assistive tech
            // and tests.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(title) block")
            .accessibilityHint(preview.truncated ? "Press and hold to copy, tap to view all" : "Press and hold to copy")
            .accessibilityAction(named: "Copy code") { copy() }
            .accessibilityAction(named: "View code") { openOutput(.init(title: title, text: text)) }
            .accessibilityIdentifier("chat-code-block")
            .overlay {
                if copied {
                    Label("Copied", systemImage: "checkmark").font(.caption.weight(.semibold))
                        .foregroundStyle(PhrenTheme.chatText)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(PhrenTheme.surfaceRaised, in: Capsule())
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                        .accessibilityIdentifier("chat-code-copied")
                }
            }
            .phrenPanel(tool: true)
            .contentShape(Rectangle())
            .onTapGesture { if preview.truncated { openOutput(.init(title: title, text: text)) } }
            // Ahead of the bubble's context menu: holding the code copies it
            // rather than opening "Copy message".
            .highPriorityGesture(LongPressGesture(minimumDuration: 0.35).onEnded { _ in copy() })
    }
    private func copy() {
        ChatClipboard.copy(text)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        flash?.cancel()
        withAnimation(.easeOut(duration: 0.15)) { copied = true }
        flash = Task {
            try? await Task.sleep(for: .seconds(AppRuntime.isUITesting ? 6 : 1.4))
            guard !Task.isCancelled else { return }
            withAnimation(.easeIn(duration: 0.25)) { copied = false }
        }
    }
}

/// `code` spans read like links (paths, commands, identifiers stand out the
/// way Moshi draws them). The colour comes from the theme, so it is applied
/// when rendering, not when the Markdown is parsed and cached; the tinted
/// copies are cached per string and colour so scrolling never re-walks runs.
enum ChatInlineCode {
    private final class Box { let value: AttributedString; init(_ value: AttributedString) { self.value = value } }
    private static let cache: NSCache<NSString, Box> = { let c = NSCache<NSString, Box>(); c.countLimit = 2_000; return c }()
    static func tinted(_ attributed: AttributedString) -> AttributedString {
        let color = PhrenTheme.chatInlineCode
        guard attributed.runs.contains(where: { $0.inlinePresentationIntent?.contains(.code) == true }) else { return attributed }
        let key = "\(color.description)|\(ChatRenderKey.text(String(attributed.characters)))" as NSString
        if let hit = cache.object(forKey: key) { return hit.value }
        var copy = attributed
        for run in copy.runs where run.inlinePresentationIntent?.contains(.code) == true {
            copy[run.range].foregroundColor = color
        }
        cache.setObject(Box(copy), forKey: key)
        return copy
    }
}

/// Deterministic content keys for render caches. Swift's `Hasher` is seeded
/// per process and walked on every access; an FNV-1a key is stable and cheap,
/// so a view body that asks twice computes the same key without surprising a
/// cache with a fresh value each launch.
enum ChatRenderKey {
    static func text(_ value: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return "\(value.utf8.count)|\(String(hash, radix: 16))"
    }
}
