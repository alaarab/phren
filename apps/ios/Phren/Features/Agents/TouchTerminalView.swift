import SwiftTerm
import UIKit

/// Phone gestures are deliberately different from desktop pointer gestures.
/// Keep taps for TUI controls, scroll with a swipe, and select only after a hold.
final class TouchTerminalView: TerminalView, UIGestureRecognizerDelegate, UIEditMenuInteractionDelegate {
    private var wheelPan: UIPanGestureRecognizer?
    private var wheelRemainder: CGFloat = 0
    private var pinchStartSize: CGFloat = 12
    private var requestingKeyboard = false
    var onTextSizeChanged: ((CGFloat) -> Void)?
    var onShortcutGesture: (() -> Void)?
    private lazy var editMenu = UIEditMenuInteraction(delegate: self)
    #if DEBUG && targetEnvironment(simulator)
    private(set) var copyActions = 0
    #endif

    func configureTouchInput() {
        // SwiftUI owns the one keyboard toolbar. SwiftTerm installs another by default.
        inputAccessoryView = nil
        // Own taps in both shell and TUI modes: SwiftTerm's taps require focus
        // and otherwise raise the keyboard instead of activating the target.
        for gesture in gestureRecognizers ?? [] where gesture is UILongPressGestureRecognizer || gesture is UITapGestureRecognizer {
            removeGestureRecognizer(gesture)
        }
        panGestureRecognizer.maximumNumberOfTouches = 1
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(zoomTerminal(_:)))
        addGestureRecognizer(pinch)
        for direction: UISwipeGestureRecognizer.Direction in [.up, .down] {
            let swipe = UISwipeGestureRecognizer(target: self, action: #selector(twoFingerSwipe(_:)))
            swipe.numberOfTouchesRequired = 2
            swipe.direction = direction
            // A pinch wins if the fingers move apart. Parallel two-finger
            // swipes stay local and never send mouse or keyboard input.
            swipe.require(toFail: pinch)
            addGestureRecognizer(swipe)
        }
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(selectText(_:)))
        hold.minimumPressDuration = 0.45
        hold.numberOfTouchesRequired = 1
        hold.delegate = self
        addGestureRecognizer(hold)
        let wheel = UIPanGestureRecognizer(target: self, action: #selector(scrollTerminal(_:)))
        wheel.maximumNumberOfTouches = 1
        wheel.delegate = self
        wheel.require(toFail: hold)
        addGestureRecognizer(wheel)
        wheelPan = wheel
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapTerminal(_:)))
        tap.require(toFail: hold)
        tap.require(toFail: wheel)
        tap.require(toFail: pinch)
        addGestureRecognizer(tap)
        addInteraction(editMenu)
        updateScrollGestures()
        accessibilityHint = "Tap controls and links. Swipe to scroll. Pinch to resize text. Hold to select. Use the keyboard button to type."
    }

    func toggleKeyboard() {
        if isFirstResponder { _ = resignFirstResponder(); return }
        requestingKeyboard = true
        defer { requestingKeyboard = false }
        _ = becomeFirstResponder()
    }

    @objc private func twoFingerSwipe(_ gesture: UISwipeGestureRecognizer) {
        let defaults = AppRuntime.defaults
        guard defaults.object(forKey: "terminal.twoFingerGestures.v1") as? Bool != false,
              gesture.state == .ended else { return }
        if gesture.direction == .down { _ = resignFirstResponder() }
        else if gesture.direction == .up { onShortcutGesture?() }
    }

    override func becomeFirstResponder() -> Bool {
        // UIKit text interactions must not resize the viewport on an ordinary
        // tap, link, or selection. Only the explicit toolbar button opts in.
        guard requestingKeyboard || isFirstResponder else { return false }
        return super.becomeFirstResponder()
    }

    func setTextSize(_ size: CGFloat) {
        guard size.isFinite else { return }
        let bounded = min(24, max(6, (size * 2).rounded() / 2))
        if font.pointSize != bounded { font = font.withSize(bounded) }
    }

    @objc private func zoomTerminal(_ gesture: UIPinchGestureRecognizer) {
        switch gesture.state {
        case .began:
            editMenu.dismissMenu()
            clearSelection()
            pinchStartSize = font.pointSize
        case .changed, .ended:
            // Resize the character grid, not a magnified/cropped bitmap. The
            // existing size delegate resizes the remote PTY so Herdr reflows.
            setTextSize(pinchStartSize * gesture.scale)
            if gesture.state == .ended { onTextSizeChanged?(font.pointSize) }
        case .cancelled:
            setTextSize(pinchStartSize)
        default: break
        }
    }

    override func mouseModeChanged(source: Terminal) {
        // Do not install SwiftTerm's desktop mouse-drag recognizer. Herdr interprets
        // those presses/motions as remote selection, including copy on release.
        updateScrollGestures()
    }

    override func selectionChanged(source: Terminal) {
        super.selectionChanged(source: source)
        updateScrollGestures()
    }

    private func updateScrollGestures() {
        guard wheelPan != nil else { return }
        // A tap dismissing local selection must not click a remote TUI control.
        allowMouseReporting = !hasActiveSelection
        panGestureRecognizer.isEnabled = getTerminal().mouseMode == .off && !hasActiveSelection
        wheelPan?.isEnabled = getTerminal().mouseMode != .off || hasActiveSelection
    }

    override func paste(_ sender: Any?) {
        super.paste(sender)
        clearSelection()
    }

    override func copy(_ sender: Any?) {
        #if DEBUG && targetEnvironment(simulator)
        copyActions += 1
        #endif
        super.copy(sender)
    }

    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration,
                             suggestedActions: [UIMenuElement]) -> UIMenu? {
        UIMenu(children: [
            UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc"),
                     attributes: hasActiveSelection ? [] : .disabled) { [weak self] _ in self?.copy(nil) },
            UIAction(title: "Paste", image: UIImage(systemName: "document.on.clipboard")) { [weak self] _ in self?.paste(nil) },
            UIAction(title: "Select All", attributes: .keepsMenuPresented) { [weak self] _ in
                self?.selection.selectAll()
            }
        ])
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer is UILongPressGestureRecognizer { return gestureRecognizer.numberOfTouches == 1 }
        guard gestureRecognizer === wheelPan, let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        if hasActiveSelection { return true }
        let velocity = pan.velocity(in: self)
        return !hasActiveSelection && abs(velocity.y) > abs(velocity.x)
    }

    private var cellSize: CGSize {
        // Use the terminal's point geometry, not the screen's Retina scale.
        // A UIWindow's contentScaleFactor can differ from UIScreen.scale.
        let core = getTerminal(), frame = getOptimalFrameSize()
        return CGSize(width: max(1, frame.width / CGFloat(max(1, core.cols))),
                      height: max(1, frame.height / CGFloat(max(1, core.rows))))
    }

    @objc private func tapTerminal(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended else { return }
        if hasActiveSelection {
            clearSelection()
            editMenu.dismissMenu()
            return
        }
        let core = getTerminal()
        let point = gesture.location(in: self)
        if let link = core.link(at: .buffer(bufferPosition(at: point)), mode: .explicitAndImplicit) {
            terminalDelegate?.requestOpenLink(source: self, link: link, params: [:])
            return
        }
        guard core.mouseMode != .off else { return }
        let viewport = CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY)
        let column = max(0, min(core.cols - 1, Int(viewport.x / cellSize.width)))
        let row = max(0, min(core.rows - 1, Int(viewport.y / cellSize.height)))
        for release in [false, true] {
            if release && core.mouseMode == .x10 { continue }
            let flags = core.encodeButton(button: 0, release: release, shift: false, meta: false, control: false)
            core.sendEvent(buttonFlags: flags, x: column, y: row,
                           pixelX: max(0, Int(viewport.x)), pixelY: max(0, Int(viewport.y)))
        }
    }

    @objc private func scrollTerminal(_ gesture: UIPanGestureRecognizer) {
        if hasActiveSelection {
            let point = gesture.location(in: self)
            let position = bufferPosition(at: point)
            switch gesture.state {
            case .began:
                editMenu.dismissMenu()
                let start = selection.start, end = selection.end
                let offset = position.row * getTerminal().cols + position.col
                let startOffset = start.row * getTerminal().cols + start.col
                let endOffset = end.row * getTerminal().cols + end.col
                selection.pivot = abs(offset - startOffset) < abs(offset - endOffset) ? end : start
            case .changed: selection.pivotExtend(bufferPosition: position)
            case .ended: editMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
            default: break
            }
            return
        }
        guard getTerminal().mouseMode != .off else { return }
        if gesture.state == .began { wheelRemainder = 0 }
        let delta = gesture.translation(in: self).y
        gesture.setTranslation(.zero, in: self)
        wheelRemainder += delta
        let lines = Int(wheelRemainder / cellSize.height)
        guard lines != 0 else { return }
        wheelRemainder -= CGFloat(lines) * cellSize.height
        let core = getTerminal()
        let point = gesture.location(in: self)
        let viewport = CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY)
        let column = max(0, min(core.cols - 1, Int(viewport.x / cellSize.width)))
        let row = max(0, min(core.rows - 1, Int(viewport.y / cellSize.height)))
        let flags = core.encodeButton(button: lines > 0 ? 4 : 5, release: false,
                                      shift: false, meta: false, control: false)
        for _ in 0..<abs(lines) {
            core.sendEvent(buttonFlags: flags, x: column, y: row,
                           pixelX: max(0, Int(viewport.x)), pixelY: max(0, Int(viewport.y)))
        }
    }

    @objc private func selectText(_ gesture: UILongPressGestureRecognizer) {
        let point = gesture.location(in: self)
        let core = getTerminal()
        let position = bufferPosition(at: point)
        switch gesture.state {
        case .began:
            editMenu.dismissMenu()
            selection.selectWordOrExpression(at: position, in: core.buffer)
            selection.selectionMode = .word
            UISelectionFeedbackGenerator().selectionChanged()
        case .changed:
            selection.dragExtend(bufferPosition: position)
        case .ended:
            editMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
        case .cancelled:
            clearSelection()
        default: break
        }
    }

    private func bufferPosition(at point: CGPoint) -> Position {
        let core = getTerminal()
        return Position(col: max(0, min(core.cols - 1, Int(point.x / cellSize.width))),
                        row: max(core.getTopVisibleRow(), min(core.getTopVisibleRow() + core.rows - 1,
                                                            Int(point.y / cellSize.height))))
    }
}
