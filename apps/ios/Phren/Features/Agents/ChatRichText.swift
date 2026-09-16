import PhrenKit
import SwiftUI

/// Native Markdown paragraphs, fenced code and pipe tables; no remote web content is loaded.
struct ChatRichText: View, Equatable {
    let text: String
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.text == rhs.text }
    @ScaledMetric(relativeTo: .body) private var textSize = 14.5
    @ScaledMetric(relativeTo: .headline) private var headingSize = 15.5
    private let document: ChatRichTextDocument
    init(text: String, cacheKey: String? = nil) {
        self.text = text
        document = ChatRichTextDocumentCache.value(text, key: cacheKey ?? "text:\(text.hashValue)")
    }
    var body: some View {
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
                } else {
                    Text(ChatInlineCode.tinted(block.attributed))
                        .font(.system(size: block.heading ? headingSize : textSize, weight: block.heading ? .semibold : .regular, design: .monospaced))
                        .foregroundStyle(PhrenTheme.chatText)
                        .lineSpacing(3).tint(PhrenTheme.link)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
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
        let key = "\(color.description)|\(attributed.hashValue)" as NSString
        if let hit = cache.object(forKey: key) { return hit.value }
        var copy = attributed
        for run in copy.runs where run.inlinePresentationIntent?.contains(.code) == true {
            copy[run.range].foregroundColor = color
        }
        cache.setObject(Box(copy), forKey: key)
        return copy
    }
}
