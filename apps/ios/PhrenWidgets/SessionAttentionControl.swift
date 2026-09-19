import Foundation
import SwiftUI
import WidgetKit

@available(iOS 18.0, *)
struct SessionAttentionControl: ControlWidget {
    static let kind = "com.phren.ios.widgets.session-attention"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind, provider: SessionAttentionProvider()) { value in
            ControlWidgetButton(action: OpenAttentionSessionIntent()) {
                Label {
                    Text("Phren session")
                } icon: {
                    Image("PhrenMark")
                }
            }
            .tint(value?.state == "waiting" ? .orange : WidgetTheme.accent)
            .disabled(value == nil)
        }
        .displayName("Open Agent Session")
        .description("Open the waiting session, or the most recently active working session.")
    }
}

/// The agents Live Activity as a switch: off when you want a quiet island.
@available(iOS 18.0, *)
struct WorkingActivityControl: ControlWidget {
    static let kind = "com.phren.ios.widgets.working-activity"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind, provider: WorkingActivityProvider()) { enabled in
            ControlWidgetToggle("Agents activity", isOn: enabled, action: ToggleWorkingActivityIntent()) { on in
                Label(on ? "Shown" : "Hidden", systemImage: on ? "waveform.path" : "waveform.path.badge.minus")
            }
            .tint(WidgetTheme.accent)
        }
        .displayName("Agents Live Activity")
        .description("Show or hide the Live Activity that counts your working agents.")
    }
}

@available(iOS 18.0, *)
private struct WorkingActivityProvider: ControlValueProvider {
    var previewValue: Bool { true }
    func currentValue() async throws -> Bool { WorkingActivityPreference.load().enabled }
}

@available(iOS 18.0, *)
private struct SessionAttentionProvider: ControlValueProvider {
    var previewValue: SessionControlSnapshot? {
        SessionControlSnapshot(sessionID: "preview", displayName: "phren · Codex", computer: "Mac",
                               state: "working", hostID: UUID(), muxID: "default",
                               workspaceID: "preview", tabID: "preview:1", label: "phren",
                               agent: "codex", cwd: "/work/phren")
    }

    func currentValue() async throws -> SessionControlSnapshot? {
        WidgetDataStore.loadControl()
    }
}
