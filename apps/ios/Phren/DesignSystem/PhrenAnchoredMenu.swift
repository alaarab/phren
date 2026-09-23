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
/// attached to, aligned to that view's leading edge. It overlays the anchor,
/// so it changes neither the anchor's nor its parents' layout, and it draws
/// above the rest of the screen. Tapping a row runs its action then closes;
/// tapping anywhere else closes.
private struct PhrenAnchoredMenuModifier: ViewModifier {
    @Binding var isPresented: Bool
    let items: [PhrenMenuItem]
    let edge: VerticalEdge
    let identifier: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Rows plus the hairlines between them, so the card sits exactly `gap` off the anchor.
    private var cardHeight: CGFloat { CGFloat(items.count) * 44 + CGFloat(max(0, items.count - 1)) * 0.5 }

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topLeading) {
                if isPresented {
                    GeometryReader { geometry in
                        let above = edge == .top
                        let gap: CGFloat = 8
                        // Far larger than any screen, centered over the
                        // anchor, so a tap anywhere outside dismisses.
                        let spread: CGFloat = 2048
                        ZStack(alignment: .topLeading) {
                            Color.clear
                                .frame(width: spread * 2, height: spread * 2)
                                .offset(x: -spread, y: -spread)
                                .contentShape(Rectangle())
                                .onTapGesture { isPresented = false }
                            menuCard
                                .offset(x: 0, y: above ? -cardHeight - gap : geometry.size.height + gap)
                                .transition(.scale(scale: 0.95, anchor: above ? .bottomLeading : .topLeading)
                                    .combined(with: .opacity))
                        }
                    }
                    .zIndex(50)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: isPresented)
    }

    private var menuCard: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Rectangle().fill(PhrenTheme.border).frame(height: 0.5) }
                row(item)
            }
        }
        .frame(width: 240)
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
            isPresented = false
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
    func phrenAnchoredMenu(isPresented: Binding<Bool>, items: [PhrenMenuItem], edge: VerticalEdge = .top,
                           identifier: String) -> some View {
        modifier(PhrenAnchoredMenuModifier(isPresented: isPresented, items: items, edge: edge, identifier: identifier))
    }
}
