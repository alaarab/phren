import PhrenKit
import SwiftUI

struct ChatBottomPosition: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct ChatContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct ChatHistoryPosition: PreferenceKey {
    static var defaultValue: CGFloat = -CGFloat.greatestFiniteMagnitude
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct ChatHistoryScrollObserver: ViewModifier {
    let changed: (Bool) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top < 140
            } action: { _, near in changed(near) }
        } else {
            content.onPreferenceChange(ChatHistoryPosition.self) { position in changed(position >= -140) }
        }
    }
}

enum ChatFollow {
    static let threshold: CGFloat = 60
}

struct ChatPinRequest: Equatable {
    let id = UUID()
    let animated: Bool
}

private extension ChatScrollMetrics {
    @available(iOS 18.0, *)
    init(_ geometry: ScrollGeometry) {
        self.init(contentHeight: geometry.contentSize.height,
                  viewportHeight: geometry.containerSize.height,
                  offsetY: geometry.contentOffset.y)
    }
}

struct ChatFollowScroll: ViewModifier {
    let viewport: CGFloat
    let contentHeight: CGFloat
    let following: Bool
    let pinRequest: ChatPinRequest?
    let selectionActive: Bool
    let changed: (ChatScrollMetrics, ChatScrollMetrics, Bool) -> Void

    @State private var userDriven = false
    @State private var legacyMetrics = ChatScrollMetrics(contentHeight: 0, viewportHeight: 0, offsetY: 0)
    @State private var legacyBottomPosition: CGFloat = 0

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            ModernChatFollowScroll(content: content, following: following, pinRequest: pinRequest,
                                   selectionActive: selectionActive, userDriven: $userDriven, changed: changed)
        } else {
            content
                .simultaneousGesture(DragGesture(minimumDistance: 12).onChanged { value in
                    let driving = abs(value.translation.height) > 12
                    if driving != userDriven { userDriven = driving }
                }.onEnded { _ in userDriven = false })
                .onPreferenceChange(ChatBottomPosition.self) { position in
                    // Before ScrollGeometry, combine the measured stack with
                    // its end marker to recover the same real offset.
                    legacyBottomPosition = position
                    let new = ChatScrollMetrics(contentHeight: contentHeight,
                                                viewportHeight: viewport,
                                                offsetY: contentHeight - position)
                    changed(legacyMetrics, new, userDriven)
                    legacyMetrics = new
                }
                .onChange(of: contentHeight) { _, height in
                    let new = ChatScrollMetrics(contentHeight: height,
                                                viewportHeight: viewport,
                                                offsetY: height - legacyBottomPosition)
                    changed(legacyMetrics, new, userDriven)
                    legacyMetrics = new
                }
        }
    }
}

@available(iOS 18.0, *)
private struct ModernChatFollowScroll<Content: View>: View {
    let content: Content
    let following: Bool
    let pinRequest: ChatPinRequest?
    let selectionActive: Bool
    @Binding var userDriven: Bool
    let changed: (ChatScrollMetrics, ChatScrollMetrics, Bool) -> Void
    @State private var position = ScrollPosition()
    @State private var metrics = ChatScrollMetrics(contentHeight: 0, viewportHeight: 0, offsetY: 0)
    @State private var handledPinID: UUID?
    /// A pin keeps following the viewport for a moment after it is applied:
    /// the keyboard changes the container over several frames, and a pin
    /// resolved against the first of them lands short of, or past, the end.
    @State private var settlingUntil: Date?
    var body: some View {
        content
            // When the keyboard (or an interactive drag of it) resizes the
            // viewport, keep the message at the bottom edge where it is, in
            // the keyboard's own animation: the transcript rises and falls
            // with the composer, whether following the end or reading history.
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .scrollPosition($position)
            .onScrollPhaseChange { _, phase in
                let driving = phase == .tracking || phase == .interacting || phase == .decelerating
                if driving != userDriven { userDriven = driving }
                ScrollHitchProbe.shared.moving(phase != .idle, name: "chat")
            }
            .onScrollGeometryChange(for: ChatScrollMetrics.self) { ChatScrollMetrics($0) } action: { old, new in
                metrics = new
                changed(old, new, userDriven)
                guard !selectionActive else { return }
                if !userDriven, let corrected = ChatScrollMetrics.correctiveOffset(new) {
                    position.scrollTo(y: corrected)
                    return
                }
                if let settlingUntil, settlingUntil > .now, !userDriven {
                    // An estimate that corrected downward (or content that
                    // shrank) leaves the offset past the new bottom; the
                    // corrective check above already scrolled to it. Here the
                    // only question is whether the bottom just moved because
                    // the transcript grew.
                    let target = ChatScrollMetrics.clamp(new.bottomOffset, in: new)
                    if target > 0.5, abs(new.offsetY - target) > 0.5 { position.scrollTo(y: target) }
                    return
                }
                guard following,
                      let target = ChatScrollMetrics.shouldRepin(old: old, new: new, userDriven: userDriven) else { return }
                position.scrollTo(y: ChatScrollMetrics.clamp(target, in: new))
            }
            .onChange(of: pinRequest) { _, request in
                guard let request else { return }
                guard !selectionActive else { handledPinID = request.id; return }
                apply(request, to: metrics)
            }
            .onChange(of: metrics) { _, metrics in
                guard !selectionActive, let request = pinRequest else { return }
                apply(request, to: metrics)
            }
            .onChange(of: selectionActive) { _, selecting in
                if selecting {
                    settlingUntil = nil
                    handledPinID = pinRequest?.id
                }
            }
    }

    private func apply(_ request: ChatPinRequest, to metrics: ChatScrollMetrics) {
        guard handledPinID != request.id, metrics.viewportHeight > 0.5 else { return }
        handledPinID = request.id
        // Loaded rows and distant placeholders both have measured heights.
        // Clamp the numeric target to that real end as the viewport changes.
        let target = ChatScrollMetrics.clamp(metrics.bottomOffset, in: metrics)
        guard target > 0.5 else { return }
        settlingUntil = .now + (request.animated ? 0.6 : 0.3)
        if request.animated {
            withAnimation { position.scrollTo(y: target) }
        } else {
            position.scrollTo(y: target)
        }
    }
}
