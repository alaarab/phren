import PhrenKit
import SwiftUI
import UIKit

/// Which paragraph of which message is selectable right now, one across
/// the whole conversation. The chat screen owns it and every paragraph
/// reads it. Selection owns its gestures until it collapses or the person
/// taps outside the paragraph or chooses Done.
@Observable @MainActor final class ChatTextSelection {
    struct Target: Equatable {
        let owner: String
        let block: Int
        /// Where the double-tap landed, in the paragraph's own coordinates:
        /// the word there starts selected. `nil` selects the whole paragraph
        /// (the menu's "Select text" has no finger to go by).
        let point: CGPoint?
    }
    private(set) var active: Target?
    var composerSelecting = false
    private(set) var messageSelecting = false
    @ObservationIgnored weak var composerView: ChatSelectionTextView?
    var preventsTranscriptScrolling: Bool { composerSelecting || messageSelecting }
    /// Consult the recognizers synchronously too: a dismissal drag can be
    /// delivered before SwiftUI has rendered the latest selection state.
    var preventsKeyboardDismissal: Bool {
        preventsTranscriptScrolling || composerView?.isSelectingText == true
    }

    func messageSelectionChanged(_ selecting: Bool, target: Target?) {
        guard active == target, active != nil else { return }
        messageSelecting = selecting
    }
    @ObservationIgnored private var began = Date.distantPast
    @ObservationIgnored private var touchedInside = Date.distantPast
    @ObservationIgnored private var anchor: CGFloat?
    @ObservationIgnored private var position: CGFloat = 0

    func begin(owner: String, block: Int, at point: CGPoint?) {
        active = Target(owner: owner, block: block, point: point)
        messageSelecting = true
        began = .now
        anchor = position
    }
    func end() {
        guard active != nil else { return }
        active = nil
        messageSelecting = false
        anchor = nil
    }
    func end(owner: String, block: Int) {
        guard target(owner, block) != nil else { return }
        end()
    }
    func target(_ owner: String, _ block: Int) -> Target? {
        guard let active, active.owner == owner, active.block == block else { return nil }
        return active
    }
    /// The selectable view saw a touch: the transcript tap that follows is
    /// the person working the selection, not leaving it.
    func noteTouchInside() { touchedInside = .now }
    /// A tap in the transcript ends the selection unless it is the tap
    /// that just started it, or one on the selectable text itself.
    func transcriptTapped() {
        guard active != nil, Date.now.timeIntervalSince(began) > 0.6, Date.now.timeIntervalSince(touchedInside) > 0.6 else { return }
        end()
    }
    /// The transcript moved; past a few points the selection is over.
    func scrolled(to offset: CGFloat) {
        position = offset
        guard !preventsTranscriptScrolling else { anchor = offset; return }
        guard active != nil, let anchor, abs(offset - anchor) > 12 else { return }
        end()
    }
}

/// A paragraph the person is selecting from: the same text, drawn by UIKit
/// so it has the native handles and edit menu. It lies over the SwiftUI
/// paragraph at exactly its size, so nothing moves when it appears or goes.
struct ChatSelectableText: UIViewRepresentable {
    let attributed: AttributedString
    let heading: Bool
    let size: CGFloat
    let point: CGPoint?
    let identifier: String
    let touched: () -> Void
    let resigned: () -> Void
    @Environment(ChatTextSelection.self) private var selection: ChatTextSelection?

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> ChatSelectableTextView {
        let view = ChatSelectableTextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = false
        view.linkTextAttributes = [.foregroundColor: UIColor(PhrenTheme.link)]
        view.delegate = context.coordinator
        view.pendingSelection = point ?? .zero
        view.selectsAll = point == nil
        view.touched = touched
        view.resigned = resigned
        configure(view, context: context)
        return view
    }
    func updateUIView(_ view: ChatSelectableTextView, context: Context) { configure(view, context: context) }
    private func configure(_ view: ChatSelectableTextView, context: Context) {
        let target = selection?.active
        view.selectionActivityChanged = { [weak selection] in
            selection?.messageSelectionChanged($0, target: target)
        }
        context.coordinator.openURL = context.environment.openURL
        view.accessibilityIdentifier = identifier
        context.coordinator.apply(attributed, heading: heading, size: size, to: view)
    }
    /// The overlay proposes the SwiftUI paragraph's exact size; take it.
    /// Anything else (a preview, say) gets the text's own fitting size.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ChatSelectableTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? UIView.layoutFittingExpandedSize.width
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        return CGSize(width: proposal.width ?? fitting.width, height: proposal.height ?? fitting.height)
    }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var openURL = OpenURLAction { _ in .systemAction }
        private var applied: (AttributedString, Bool, CGFloat)?
        /// Re-renders only when the text or its size changed, keeping the
        /// selection across updates that did not touch this paragraph.
        func apply(_ attributed: AttributedString, heading: Bool, size: CGFloat, to view: UITextView) {
            if let applied, applied.0 == attributed, applied.1 == heading, applied.2 == size { return }
            applied = (attributed, heading, size)
            let selected = view.selectedRange
            view.attributedText = ChatSelectableText.render(attributed, heading: heading, size: size)
            if selected.length > 0, NSMaxRange(selected) <= view.textStorage.length { view.selectedRange = selected }
        }
        // Links go the way the rest of the chat sends them: through the
        // website confirmation, never straight out of the app.
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return nil }
            let open = openURL
            return UIAction { _ in open(url) }
        }
        func textView(_ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? { nil }
        func textViewDidChangeSelection(_ textView: UITextView) {
            (textView as? ChatSelectionTextView)?.selectionDidChange()
        }
    }

    /// The paragraph's runs as UIKit draws them: the chat's monospaced face
    /// and colors, bold and italic from the Markdown, inline code in its
    /// own color, links carrying their URL.
    static func render(_ source: AttributedString, heading: Bool, size: CGFloat) -> NSAttributedString {
        let base = UIFont.monospacedSystemFont(ofSize: size, weight: heading ? .semibold : .regular)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        let text = UIColor(PhrenTheme.chatText), code = UIColor(PhrenTheme.chatInlineCode)
        let result = NSMutableAttributedString()
        for run in source.runs {
            var attributes: [NSAttributedString.Key: Any] = [.font: base, .foregroundColor: text, .paragraphStyle: paragraph]
            let intent = run.inlinePresentationIntent ?? []
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            if !traits.isEmpty, let descriptor = base.fontDescriptor.withSymbolicTraits(traits) {
                attributes[.font] = UIFont(descriptor: descriptor, size: size)
            }
            if intent.contains(.code) { attributes[.foregroundColor] = code }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let url = run.link { attributes[.link] = url }
            result.append(NSAttributedString(string: String(source[run.range].characters), attributes: attributes))
        }
        return result
    }
}

final class ChatSelectableTextView: ChatSelectionTextView {
    /// Where to start selecting once there is a layout to hit-test against.
    var pendingSelection: CGPoint?
    var selectsAll = false
    var touched: (() -> Void)?
    var resigned: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let point = pendingSelection, bounds.width > 0 else { return }
        pendingSelection = nil
        if selectsAll { selectedRange = NSRange(location: 0, length: textStorage.length) } else { selectWord(at: point) }
        // Non-editable, so first responder brings the handles and the edit
        // menu without a keyboard. After layout, not inside it.
        DispatchQueue.main.async { [weak self] in
            guard let self, window != nil else { return }
            becomeFirstResponder()
            if selectedRange.length > 0, let menu = interactions.compactMap({ $0 as? UIEditMenuInteraction }).first {
                menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
            }
        }
    }
    /// The word under `point`, by the text view's own tokenizer; on a
    /// boundary, the word on either side.
    private func selectWord(at point: CGPoint) {
        guard let position = closestPosition(to: point) else { return }
        let range = tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: .storage(.forward))
            ?? tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: .storage(.backward))
        let start = offset(from: beginningOfDocument, to: range?.start ?? position)
        let length = range.map { offset(from: $0.start, to: $0.end) } ?? 0
        selectedRange = NSRange(location: start, length: length)
    }
    // A finger on the text, a handle or the loupe must not read as a
    // tap elsewhere in the transcript. Only real touches count, not the
    // hit-testing accessibility and tests do.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let view = super.hitTest(point, with: event)
        if view != nil, event?.type == .touches { touched?() }
        return view
    }
    // The composer taking focus is a tap elsewhere too. Deferred: UIKit
    // resigns during teardown as well, when the paragraph is already gone.
    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result, window != nil { DispatchQueue.main.async { [weak self] in if self?.window != nil { self?.resigned?() } } }
        return result
    }
}
