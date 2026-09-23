import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Phren's draft editor. UITextView owns caret movement, selection handles,
/// the loupe and edge autoscroll, including drafts taller than four lines.
struct ChatComposer: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let size: CGFloat
    let selection: ChatTextSelection
    /// Images pasted into the draft (edit menu Paste, the keyboard's
    /// screenshot suggestion) become attachments instead of text.
    var pasteImages: (([NSItemProvider]) -> Void)? = nil
    @Environment(\.isEnabled) private var enabled

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ChatSelectionTextView {
        let view = ChatSelectionTextView()
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        view.textContainer.lineFragmentPadding = 0
        view.contentInsetAdjustmentBehavior = .never
        view.keyboardDismissMode = .none
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "chat-composer"
        view.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [
            UTType.image.identifier, UTType.plainText.identifier, UTType.text.identifier, UTType.url.identifier,
        ])
        #if DEBUG && targetEnvironment(simulator)
        AgentChatFixture.seedPasteboardImage()
        #endif
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: ChatSelectionTextView, context: Context) {
        context.coordinator.parent = self
        selection.composerView = view
        // Applying an external draft/focus change must not publish SwiftUI
        // state from inside updateUIView. User gestures still report inline.
        view.selectionActivityChanged = nil
        view.font = .monospacedSystemFont(ofSize: size, weight: .regular)
        view.textColor = UIColor(PhrenTheme.chatText)
        view.tintColor = UIColor(PhrenTheme.cyan)
        view.autocorrectionType = ChatSettings.autocorrects ? .yes : .no
        view.isEditable = enabled
        view.isSelectable = enabled
        view.accessibilityLabel = placeholder
        view.pasteImages = pasteImages
        if view.text != text {
            let range = view.selectedRange
            let wasAtEnd = NSMaxRange(range) == view.textStorage.length
            view.text = text
            let start = wasAtEnd ? view.textStorage.length : min(range.location, view.textStorage.length)
            view.selectedRange = NSRange(location: start, length: min(range.length, view.textStorage.length - start))
            view.invalidateIntrinsicContentSize()
        }
        if focused && enabled && !view.isFirstResponder { view.becomeFirstResponder() }
        if (!focused || !enabled) && view.isFirstResponder { view.resignFirstResponder() }
        view.selectionActivityChanged = { [weak selection] in selection?.composerSelecting = $0 }
        DispatchQueue.main.async { [weak view] in view?.selectionDidChange() }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ChatSelectionTextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        return Self.fittingSize(uiView, width: width)
    }

    static func fittingSize(_ view: UITextView, width: CGFloat) -> CGSize {
        let line = view.font?.lineHeight ?? 17
        let insets = view.textContainerInset.top + view.textContainerInset.bottom
        let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(min(max(fitting.height, line + insets), 4 * line + insets)))
    }

    static func dismantleUIView(_ view: ChatSelectionTextView, coordinator: Coordinator) {
        view.selectionActivityChanged = nil
        let selection = coordinator.parent.selection
        DispatchQueue.main.async { [weak selection, weak view] in
            guard let selection, selection.composerView === view else { return }
            selection.composerView = nil
            selection.composerSelecting = false
        }
    }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ChatComposer
        init(_ parent: ChatComposer) { self.parent = parent }
        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.focused { parent.focused = true }
        }
        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.focused { parent.focused = false }
            (textView as? ChatSelectionTextView)?.selectionDidChange()
        }
        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
        }
        func textViewDidChangeSelection(_ textView: UITextView) {
            (textView as? ChatSelectionTextView)?.selectionDidChange()
        }
    }
}

/// Observe UIKit's own selection recognizers without replacing their delegates
/// or installing a competing drag recognizer. A collapsed range can still have
/// an active caret/loupe drag; a stationary nonempty range still has handles.
class ChatSelectionTextView: UITextView {
    var selectionActivityChanged: ((Bool) -> Void)?
    /// Set on the composer only: where pasted images go.
    var pasteImages: (([NSItemProvider]) -> Void)?
    private var observedSelectionGestures: [UIGestureRecognizer] = []
    private var reportedSelecting: Bool?

    var isSelectingText: Bool {
        isFirstResponder && (selectedRange.length > 0 || observedSelectionGestures.contains {
            $0.state == .began || $0.state == .changed
        })
    }

    var hasScrollableDraft: Bool {
        contentSize.height > bounds.height + 1
    }

    override var selectedRange: NSRange {
        didSet { selectionDidChange() }
    }
    override var selectedTextRange: UITextRange? {
        didSet { selectionDidChange() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        observeSelectionGestures()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // UIKit can install handle recognizers after the first selection.
        if event?.type == .touches { observeSelectionGestures() }
        return super.hitTest(point, with: event)
    }

    @discardableResult override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        observeSelectionGestures()
        selectionDidChange()
        return result
    }

    @discardableResult override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        selectionDidChange()
        return result
    }

    // MARK: Image paste

    static func isImage(_ provider: NSItemProvider) -> Bool {
        provider.registeredTypeIdentifiers.contains { UTType($0)?.conforms(to: .image) == true }
    }

    private var acceptsImagePaste: Bool { pasteImages != nil && isEditable }

    private var pasteboardImageProviders: [NSItemProvider] {
        guard UIPasteboard.general.hasImages else { return [] }
        return UIPasteboard.general.itemProviders.filter(Self.isImage)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), acceptsImagePaste, UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
        if acceptsImagePaste, itemProviders.contains(where: Self.isImage) { return true }
        return super.canPaste(itemProviders)
    }

    override func paste(_ sender: Any?) {
        // Text wins when the pasteboard carries both, as copied rich text does.
        if acceptsImagePaste, !UIPasteboard.general.hasStrings,
           case let images = pasteboardImageProviders, !images.isEmpty {
            pasteImages?(images)
            return
        }
        super.paste(sender)
    }

    override func paste(itemProviders: [NSItemProvider]) {
        guard acceptsImagePaste else { return super.paste(itemProviders: itemProviders) }
        let images = itemProviders.filter { Self.isImage($0) && !$0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }
        let rest = itemProviders.filter { provider in !images.contains { $0 === provider } }
        if !images.isEmpty { pasteImages?(images) }
        if !rest.isEmpty { super.paste(itemProviders: rest) }
    }

    private func observeSelectionGestures() {
        let interactionGestures = interactions.compactMap { $0 as? UITextInteraction }
            .flatMap(\.gesturesForFailureRequirements)
        // Some OS versions attach the handle/loupe recognizers to text
        // subviews instead of exposing them through UITextInteraction.
        // Observe their actual states too, excluding ordinary editor scrolls.
        func recognizers(in view: UIView) -> [UIGestureRecognizer] {
            let gestures = (view.gestureRecognizers ?? []).filter { gesture in
                if gesture === (view as? UIScrollView)?.panGestureRecognizer { return false }
                return gesture is UILongPressGestureRecognizer || (view !== self && gesture is UIPanGestureRecognizer)
            }
            return gestures + view.subviews.flatMap { recognizers(in: $0) }
        }
        let gestures = (interactionGestures + recognizers(in: self)).filter { $0 !== panGestureRecognizer }
        for old in observedSelectionGestures where !gestures.contains(where: { $0 === old }) {
            old.removeTarget(self, action: #selector(selectionGestureChanged))
        }
        observedSelectionGestures.removeAll { old in !gestures.contains(where: { $0 === old }) }
        for gesture in gestures where !observedSelectionGestures.contains(where: { $0 === gesture }) {
            observedSelectionGestures.append(gesture)
            gesture.addTarget(self, action: #selector(selectionGestureChanged))
        }
    }

    @objc private func selectionGestureChanged(_ gesture: UIGestureRecognizer) {
        selectionDidChange()
    }

    func selectionDidChange() {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled, let range = Range(selectedRange, in: text), let selectedTextRange {
            AgentChatFixture.report.selected = String(text[range])
            let end = caretRect(for: selectedTextRange.end)
            AgentChatFixture.report.selectionEndX = end.midX - bounds.minX
            AgentChatFixture.report.selectionEndY = end.maxY - bounds.minY + 3
        }
        #endif
        guard isFirstResponder || reportedSelecting == true else { return }
        let selecting = isSelectingText
        guard let selectionActivityChanged, selecting != reportedSelecting else { return }
        reportedSelecting = selecting
        selectionActivityChanged(selecting)
    }
}
