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
