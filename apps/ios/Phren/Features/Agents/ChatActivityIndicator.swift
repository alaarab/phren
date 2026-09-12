import PhrenKit
import SwiftUI

struct ChatActivityIndicator: View {
    let connected: Bool
    let reconnecting: Bool
    let waiting: Bool
    let revealing: Bool
    let needsAnswer: Bool
    let phase: AgentChatProgress.Phase?
    private var busy: Bool { connected && !needsAnswer && (waiting || revealing || phase == .working) }
    private var label: String {
        if reconnecting { return "Reconnecting" }
        if !connected { return "Disconnected" }
        if needsAnswer { return "Waiting for your answer" }
        if waiting { return "Waiting for agent…" }
        if revealing { return "Receiving reply…" }
        if phase == .working { return "Agent is working" }
        if phase == .stopped { return "Stopped" }
        if phase == .finished { return "Finished" }
        return "Ready"
    }
    var body: some View {
        Group {
            if busy { ProgressView().controlSize(.mini).tint(PhrenTheme.success) }
            else { Image(systemName: reconnecting ? "wifi.exclamationmark" : needsAnswer ? "pause.circle" : "circle.fill").font(.system(size: 9)) }
        }
        .frame(width: 12, height: 12)
        .foregroundStyle(reconnecting || needsAnswer ? PhrenTheme.warning : connected ? PhrenTheme.success : PhrenTheme.textDim)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label).accessibilityIdentifier("chat-activity")
    }
}
