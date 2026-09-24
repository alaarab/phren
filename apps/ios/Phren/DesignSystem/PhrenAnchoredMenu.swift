import SwiftUI

/// One row of a `phrenAnchoredMenu` card. A disabled row still shows, dimmed
/// and not tappable, so the whole set stays visible.
struct PhrenMenuItem: Identifiable {
    let id: String
    let title: String
    let systemImage: String
    var isEnabled: Bool
    let action: () -> Void

    init(id: String, title: String, systemImage: String, isEnabled: Bool = true, action: @escaping () -> Void) {
        self.id = id
        self.title = title
        self.systemImage = systemImage
        self.isEnabled = isEnabled
        self.action = action
    }
}

/// A compact card of actions that opens just above (or below) the view it is
/// attached to, aligned to that view's leading edge. The anchor only reports
/// its bounds; the card is drawn by `phrenAnchoredMenuHost()` on a screen's
/// root, because a parent's content shape (a composer row's, say) also bounds
/// its children's hit testing and would swallow taps on a card drawn outside
/// it. Tapping a row runs its action then closes; tapping anywhere else closes.
struct PhrenAnchoredMenuRequest {
    let anchor: Anchor<CGRect>
    let items: [PhrenMenuItem]
    let edge: VerticalEdge
    let identifier: String
    let dismiss: () -> Void
}

struct PhrenAnchoredMenuKey: PreferenceKey {
    static let defaultValue: [PhrenAnchoredMenuRequest] = []
    static func reduce(value: inout [PhrenAnchoredMenuRequest], nextValue: () -> [PhrenAnchoredMenuRequest]) {
        value.append(contentsOf: nextValue())
    }
}

private struct PhrenAnchoredMenuHost: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.overlayPreferenceValue(PhrenAnchoredMenuKey.self) { requests in
            GeometryReader { proxy in
                if let request = requests.last {
                    let anchor = proxy[request.anchor]
                    let above = request.edge == .top
                    let gap: CGFloat = 8
                    let height = Self.cardHeight(request.items)
                    let x = min(max(anchor.minX, 8), max(8, proxy.size.width - Self.width - 8))
                    ZStack(alignment: .topLeading) {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { request.dismiss() }
                            .accessibilityHidden(true)
                        card(request)
                            .offset(x: x, y: above ? anchor.minY - height - gap : anchor.maxY + gap)
                            .transition(.scale(scale: 0.95, anchor: above ? .bottomLeading : .topLeading)
                                .combined(with: .opacity))
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: requests.count)
        }
    }

    static let width: CGFloat = 240
    /// Rows plus the hairlines between them, so the card sits exactly `gap` off the anchor.
    static func cardHeight(_ items: [PhrenMenuItem]) -> CGFloat {
        CGFloat(items.count) * 44 + CGFloat(max(0, items.count - 1)) * 0.5
    }

    private func card(_ request: PhrenAnchoredMenuRequest) -> some View {
        PhrenMenuCard(items: request.items, identifier: request.identifier, width: Self.width, dismiss: request.dismiss)
    }
}

/// The compact card every phren menu uses (the composer's +, a message's
/// actions): 44-point rows of icon and title, hairlines between them, no
/// title bar and no close button. A row closes the menu, then runs.
struct PhrenMenuCard: View {
    let items: [PhrenMenuItem]
    let identifier: String
    var width: CGFloat = 240
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Rectangle().fill(PhrenTheme.border).frame(height: 0.5) }
                row(item)
            }
        }
        .frame(width: width)
        .background(PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(PhrenTheme.border, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        // A marker, not an identifier on the card: a container identifier
        // would replace the rows' own.
        .phrenContainerMarker(identifier, label: "Menu")
    }

    private func row(_ item: PhrenMenuItem) -> some View {
        Button {
            dismiss()
            item.action()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: item.systemImage)
                    .font(PhrenTypography.icon(17))
                    .foregroundStyle(PhrenTheme.textMuted)
                    .frame(width: 24)
                Text(item.title)
                    .font(PhrenTypography.body)
                    .foregroundStyle(PhrenTheme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!item.isEnabled)
        .opacity(item.isEnabled ? 1 : 0.4)
        .accessibilityIdentifier("\(identifier):\(item.id)")
    }
}

extension View {
    /// Marks this view as the anchor of a menu; a screen root with
    /// `phrenAnchoredMenuHost()` draws the card.
    func phrenAnchoredMenu(isPresented: Binding<Bool>, items: [PhrenMenuItem], edge: VerticalEdge = .top,
                           identifier: String) -> some View {
        anchorPreference(key: PhrenAnchoredMenuKey.self, value: .bounds) { anchor in
            isPresented.wrappedValue
                ? [PhrenAnchoredMenuRequest(anchor: anchor, items: items, edge: edge, identifier: identifier,
                                            dismiss: { isPresented.wrappedValue = false })]
                : []
        }
    }

    /// Draws any open `phrenAnchoredMenu` inside this view, above everything
    /// in it. Put it on the screen's root.
    func phrenAnchoredMenuHost() -> some View { modifier(PhrenAnchoredMenuHost()) }
}
