import SwiftUI

/// Mascot-led empty state replacing the system ContentUnavailableView —
/// the little phren keeps the empty screens on-brand.
struct PhrenEmptyState<Actions: View>: View {
    let title: String
    let message: String
    /// Optional next steps under the message — what the person can do about
    /// the empty screen, when there is something.
    @ViewBuilder let actions: () -> Actions

    init(title: String, message: String, @ViewBuilder actions: @escaping () -> Actions) {
        self.title = title; self.message = message; self.actions = actions
    }

    var body: some View {
        VStack(spacing: 12) {
            PhrenMascotView(size: 76, bobbing: false, glow: false)
                .opacity(0.8)
            Text(title)
                .font(.headline)
                .foregroundStyle(PhrenTheme.text)
            Text(message)
                .font(.footnote)
                .foregroundStyle(PhrenTheme.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
            VStack(spacing: 8) { actions() }
                .padding(.top, 8)
        }
        .padding(32)
    }
}

extension PhrenEmptyState where Actions == EmptyView {
    init(title: String, message: String) {
        self.init(title: title, message: message) { EmptyView() }
    }
}
