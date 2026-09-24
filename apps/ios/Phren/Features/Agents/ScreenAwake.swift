import SwiftUI
import UIKit

/// Keeps the screen from sleeping while any screen that asks is showing.
/// Each screen holds its own claim: a chat pushed over Agents, or opened from
/// the terminal, used to switch auto-lock back on as the screen under it
/// disappeared, so the screen slept mid-chat.
@MainActor enum ScreenAwake {
    private static var claims: Set<String> = []

    static func hold(_ id: String, _ wanted: Bool) {
        if wanted { claims.insert(id) } else { claims.remove(id) }
        let awake = !claims.isEmpty
        if UIApplication.shared.isIdleTimerDisabled != awake { UIApplication.shared.isIdleTimerDisabled = awake }
    }

    /// Settings: "Keep screen on" under Agents covers the Agents list, chats
    /// and the terminal; the terminal's own switch covers the terminal.
    static func wanted(terminal: Bool = false) -> Bool {
        IntegrationSettings.enabled(IntegrationSettings.agentsKeepScreenOnKey, default: false)
            || (terminal && TerminalSettings.keepsScreenOn)
    }
}

private struct KeepsScreenAwake: ViewModifier {
    let terminal: Bool
    @State private var id = UUID().uuidString
    @AppStorage(IntegrationSettings.agentsKeepScreenOnKey) private var agentsSetting = false
    func body(content: Content) -> some View {
        content
            .onAppear { ScreenAwake.hold(id, ScreenAwake.wanted(terminal: terminal)) }
            .onDisappear { ScreenAwake.hold(id, false) }
            .onChange(of: agentsSetting) { _, _ in ScreenAwake.hold(id, ScreenAwake.wanted(terminal: terminal)) }
    }
}

extension View {
    /// Holds the screen awake while this view shows, when Settings says to.
    func keepsScreenAwake(terminal: Bool = false) -> some View { modifier(KeepsScreenAwake(terminal: terminal)) }
}
