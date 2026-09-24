import SwiftUI
import WidgetKit

/// Control Center and lock screen: talk to the conductor hands-free. A
/// control can only be tapped, not held, so it starts talk mode, which sends
/// when you stop talking and listens again after the reply.
@available(iOS 18.0, *)
struct TalkToConductorControl: ControlWidget {
    static let kind = "com.phren.ios.widgets.talk-to-conductor"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: TalkToConductorIntent()) {
                Label("Talk to conductor", systemImage: "waveform.circle")
            }
            .tint(WidgetTheme.accent)
        }
        .displayName("Talk to Conductor")
        .description("Talk with your conductor hands-free, and keep talking with the screen locked.")
    }
}

/// Opens phren on a confirmation that lists the working agents; nothing
/// stops until you confirm there.
@available(iOS 18.0, *)
struct PauseAllAgentsControl: ControlWidget {
    static let kind = "com.phren.ios.widgets.pause-all-agents"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: PauseAllAgentsIntent()) {
                Label("Pause all agents", systemImage: "pause.circle")
            }
            .tint(WidgetTheme.accent)
        }
        .displayName("Pause All Agents")
        .description("Interrupt every working agent on your computers, after you confirm in phren.")
    }
}
