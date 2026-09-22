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

private struct ChatMessageMenuOverlay: View {
    let menu: ChatMessageMenu
    let request: ChatMessageMenu.Request
    @State private var menuHeight: CGFloat = 292

    var body: some View {
        GeometryReader { geometry in
            let origin = geometry.frame(in: .global).origin
            let bounds = CGRect(origin: .zero, size: geometry.size).insetBy(dx: 8, dy: 8)
            let source = request.frame.offsetBy(dx: -origin.x, dy: -origin.y)
            let width = min(320, bounds.width)
            let layout = ChatMessageMenuLayout(bounds: bounds, source: source,
                                               menuSize: CGSize(width: width, height: menuHeight))
            ZStack(alignment: .topLeading) {
                Color.black.opacity(0.5).ignoresSafeArea()
                    .contentShape(Rectangle()).onTapGesture { menu.dismiss() }
                    .accessibilityElement()
                    .accessibilityLabel("Dismiss message actions")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("chat-message-menu-backdrop")
                ScrollViewReader { proxy in
                    ScrollView {
                        request.preview.frame(width: layout.preview.width).allowsHitTesting(false)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .onAppear {
                        if source.height > layout.preview.height, let paragraph = request.paragraph {
                            proxy.scrollTo(paragraph, anchor: .center)
                        }
                    }
                }
                .frame(width: layout.preview.width, height: layout.preview.height)
                .background(PhrenTheme.chatCanvas, in: RoundedRectangle(cornerRadius: 20))
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-message-menu-preview")
                .offset(x: layout.preview.minX, y: layout.preview.minY)
                .transition(menu.reduceMotion ? .opacity : .offset(y: source.minY - layout.preview.minY).combined(with: .opacity))

                panel.frame(width: width).fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { menuHeight = $0 }
                    .hidden().accessibilityHidden(true).allowsHitTesting(false)
                panel.frame(width: layout.menu.width, height: layout.menu.height)
                    .offset(x: layout.menu.minX, y: layout.menu.minY)
            }
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { menu.dismiss() }
        }
    }

    private var panel: some View {
        PhrenActionSheet(title: "Message", actions: request.actions.map { action in
            // Restore the whole screen before selection or sharing takes focus.
            PhrenControlAction(id: action.id, title: action.title, icon: action.icon, dismisses: false) {
                menu.dismiss(then: action.handler)
            }
        }, identifier: "chat-message-menu", dismiss: { menu.dismiss() })
    }
}
