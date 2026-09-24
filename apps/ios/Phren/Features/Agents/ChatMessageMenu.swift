import SwiftUI

/// Geometry updates do not invalidate the rich message subtree on scrolling.
@MainActor final class ChatMessageMenuAnchor { var frame: CGRect = .zero }

/// The conversation owns one presentation above its transcript and composer.
@Observable @MainActor
final class ChatMessageMenu {
    struct Request: Identifiable {
        let id = UUID()
        let owner: String
        let frame: CGRect
        let preview: AnyView
        let paragraph: Int?
        let actions: [PhrenControlAction]
    }
    var request: Request?
    var sharedText: String?
    var reduceMotion = false
    @ObservationIgnored private var lastUserScroll = Date.distantPast

    /// A deliberate hold: long enough that reading is not one, and still.
    static let holdDuration = 0.5
    static let holdTolerance: CGFloat = 6

    func noteUserScroll() { lastUserScroll = .now }

    @ObservationIgnored private var pressStart: Date?
    @ObservationIgnored private var lastHoldEnd = Date.distantPast

    /// Where a message press is, as its hold gesture reports it.
    func notePress(_ pressing: Bool, now: Date = .now) {
        if pressing { pressStart = now; return }
        if let start = pressStart, now.timeIntervalSince(start) >= Self.holdDuration { lastHoldEnd = now }
        pressStart = nil
    }

    /// The transcript's tap also fires when a hold lifts, in no fixed order
    /// with the hold's own action. Such a tap must not dismiss the keyboard.
    func tapEndsAHold(now: Date = .now) -> Bool {
        if request != nil { return true }
        if let start = pressStart, now.timeIntervalSince(start) >= Self.holdDuration { return true }
        return now.timeIntervalSince(lastHoldEnd) < 0.3
    }

    /// A hold counts only when the transcript stayed still for all of it and
    /// a moment before, so the touch that stops a fling never opens a menu.
    func acceptsHold(now: Date = .now) -> Bool {
        request == nil && now.timeIntervalSince(lastUserScroll) >= Self.holdDuration + 0.15
    }

    func present(_ request: Request) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { self.request = request }
    }
    func dismiss(then action: @escaping () -> Void = {}) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
            request = nil
        } completion: { action() }
    }
}

/// Paragraphs supply their actions; the enclosing bubble supplies the preview.
struct ChatMessageMenuSource {
    let open: (_ paragraph: Int?, _ actions: [PhrenControlAction]) -> Void
}
private struct ChatMessageMenuSourceKey: EnvironmentKey {
    static let defaultValue: ChatMessageMenuSource? = nil
}
extension EnvironmentValues {
    var chatMessageMenuSource: ChatMessageMenuSource? {
        get { self[ChatMessageMenuSourceKey.self] }
        set { self[ChatMessageMenuSourceKey.self] = newValue }
    }
}

/// Opens the message menu on a deliberate hold only: half a second, moving
/// no more than a few points, with the transcript still, and never while
/// native text selection is up.
struct ChatMessageMenuHold: ViewModifier {
    let open: () -> Void
    @Environment(ChatMessageMenu.self) private var menu: ChatMessageMenu?
    @Environment(ChatTextSelection.self) private var selection: ChatTextSelection?

    func body(content: Content) -> some View {
        content.onLongPressGesture(minimumDuration: ChatMessageMenu.holdDuration,
                                   maximumDistance: ChatMessageMenu.holdTolerance) {
            guard selection?.active == nil, selection?.preventsTranscriptScrolling != true,
                  menu?.acceptsHold() ?? true else { return }
            open()
        } onPressingChanged: { menu?.notePress($0) }
    }
}
extension View {
    func chatMessageMenuHold(_ open: @escaping () -> Void) -> some View {
        modifier(ChatMessageMenuHold(open: open))
    }
}

/// Frames never intersect, including an oversized message or accessibility text.
struct ChatMessageMenuLayout {
    let preview: CGRect
    let menu: CGRect

    init(bounds: CGRect, source: CGRect, menuSize: CGSize) {
        let gap: CGFloat = 12
        let height = min(menuSize.height, bounds.height * 0.6)
        let previewHeight = min(source.height, max(1, bounds.height - height - gap))
        let width = min(source.width, bounds.width)
        let x = min(max(source.minX, bounds.minX), bounds.maxX - width)
        let below = bounds.maxY - source.maxY
        let above = source.minY - bounds.minY
        let placeBelow = below >= height + gap || (above < height + gap && below >= above)
        let low = bounds.minY + (placeBelow ? 0 : height + gap)
        let high = bounds.maxY - previewHeight - (placeBelow ? height + gap : 0)
        let y = min(max(source.minY, low), max(low, high))
        preview = CGRect(x: x, y: y, width: width, height: previewHeight)
        let menuWidth = min(menuSize.width, bounds.width)
        menu = CGRect(x: min(x, bounds.maxX - menuWidth),
                      y: placeBelow ? preview.maxY + gap : preview.minY - gap - height,
                      width: menuWidth, height: height)
    }
}

struct ChatMessageMenuPresenter: ViewModifier {
    @Bindable var menu: ChatMessageMenu
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .environment(menu)
            .allowsHitTesting(menu.request == nil)
            .accessibilityHidden(menu.request != nil)
            .overlay {
                if let request = menu.request {
                    ChatMessageMenuOverlay(menu: menu, request: request)
                        .transition(.opacity).zIndex(100)
                }
            }
            .onAppear { menu.reduceMotion = reduceMotion }
            .onChange(of: reduceMotion) { _, value in menu.reduceMotion = value }
            .sheet(isPresented: Binding(get: { menu.sharedText != nil }, set: { if !$0 { menu.sharedText = nil } })) {
                if let text = menu.sharedText { ActivityView(activityItems: [text]) }
            }
    }
}

/// A pressed message's actions: the message stays exactly where it is,
/// softly highlighted, and a compact card opens just above or below it.
/// Nothing in the chat moves; a tap or drag outside closes the card.
private struct ChatMessageMenuOverlay: View {
    let menu: ChatMessageMenu
    let request: ChatMessageMenu.Request
    private let width: CGFloat = 240

    var body: some View {
        GeometryReader { geometry in
            let origin = geometry.frame(in: .global).origin
            let bounds = CGRect(origin: .zero, size: geometry.size).insetBy(dx: 8, dy: 8)
            let source = request.frame.offsetBy(dx: -origin.x, dy: -origin.y)
            let height = CGFloat(request.actions.count) * 44 + CGFloat(max(0, request.actions.count - 1)) * 0.5
            let gap: CGFloat = 8
            let below = bounds.maxY - source.maxY >= height + gap
            let y = below ? source.maxY + gap : max(bounds.minY, source.minY - gap - height)
            let x = min(max(source.minX, bounds.minX), bounds.maxX - width)
            ZStack(alignment: .topLeading) {
                // A tap, or the start of a drag, anywhere outside closes the card.
                Color.black.opacity(0.18).ignoresSafeArea()
                    .contentShape(Rectangle()).onTapGesture { menu.dismiss() }
                    .gesture(DragGesture(minimumDistance: 12).onChanged { _ in
                        if menu.request?.id == request.id { menu.dismiss() }
                    })
                    .accessibilityElement()
                    .accessibilityLabel("Dismiss message actions")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("chat-message-menu-backdrop")
                // The pressed message itself, marked in place (not a copy).
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(PhrenTheme.accent.opacity(0.10))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(PhrenTheme.accent.opacity(0.35), lineWidth: 1))
                    .frame(width: source.width + 8, height: min(source.height, bounds.height) + 8)
                    .offset(x: source.minX - 4, y: max(bounds.minY, source.minY) - 4)
                    .allowsHitTesting(false).accessibilityHidden(true)
                PhrenMenuCard(items: request.actions.map { action in
                    // Close first, then act: selection and copying take focus
                    // only once the whole screen is back.
                    PhrenMenuItem(id: action.id, title: action.title, systemImage: action.icon ?? "circle", isEnabled: action.isEnabled) {
                        menu.dismiss(then: action.handler)
                    }
                }, identifier: "chat-message-menu", width: width, dismiss: {})
                .offset(x: x, y: y)
                .transition(.scale(scale: 0.96, anchor: below ? .top : .bottom).combined(with: .opacity))
            }
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { menu.dismiss() }
        }
    }
}
