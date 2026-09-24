import PhrenKit
import SwiftUI

/// The confirmation behind the "Pause all agents" control: it names the
/// working agents first, pauses only on an explicit tap, then says how many
/// stopped. Waits for the overview so the count is never a guess.
struct PauseAllAgentsFlow: ViewModifier {
    @Binding var requested: Bool
    let ready: Bool
    let sessions: [LiveAgentSession]
    @State private var confirming = false
    @State private var result: String?

    func body(content: Content) -> some View {
        let working = AgentFleetPause.candidates(sessions)
        content
            .onChange(of: requested && ready, initial: true) { _, show in
                guard show else { return }
                requested = false
                confirming = true
            }
            .phrenDialog(isPresented: $confirming, title: working.isEmpty ? "No agents are working" : "Pause all agents?",
                         message: Self.message(working), actions: actions(working), identifier: "pause-all")
            .phrenDialog(isPresented: Binding(get: { result != nil }, set: { if !$0 { result = nil } }),
                         title: "Pause all agents", message: result ?? "",
                         actions: [.init(id: "done", title: "Done", role: .cancel) {}], identifier: "pause-all-result")
    }

    static func message(_ working: [LiveAgentSession]) -> String {
        guard !working.isEmpty else { return "Nothing to pause on your computers right now." }
        let names = working.prefix(4).map { "\($0.tab.displayTitle) on \($0.host.name)" }
        let more = working.count > 4 ? ", and \(working.count - 4) more" : ""
        return "Interrupts \(names.joined(separator: ", "))\(more). They stay open and wait for your next message."
    }

    private func actions(_ working: [LiveAgentSession]) -> [PhrenControlAction] {
        guard !working.isEmpty else { return [.init(id: "cancel", title: "OK", role: .cancel) {}] }
        let title = working.count == 1 ? "Pause 1 agent" : "Pause \(working.count) agents"
        return [
            .init(id: "confirm", title: title, role: .destructive) {
                Task { @MainActor in
                    let outcome = await AgentFleetPause.pause(working)
                    result = outcome.summary
                }
            },
            .init(id: "cancel", title: "Cancel", role: .cancel) {},
        ]
    }
}
