import PhrenKit
import PhrenLive
import SwiftUI

/// The presenter's dismiss action can change during its one-second status
/// refresh. Keep that dependency out of the transcript and its open menus.
struct ChatDismissButton: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Button { dismiss() } label: {
            Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium)).frame(width: 36, height: 44).contentShape(Rectangle())
        }.accessibilityLabel("Back").accessibilityIdentifier("chat-close")
    }
}

struct ChatHistoryStalledNotice: View {
    let since: Date?
    let newThread: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text("Codex stopped recording this thread \(since.map { SessionRelativeTime.text(since: $0, at: context.date) } ?? "recently"). Start a new one to keep following it.")
                    .font(.footnote)
                Spacer(minLength: 4)
                Button("New thread", action: newThread).font(.footnote.weight(.semibold)).fixedSize()
            }
            .foregroundStyle(PhrenTheme.warning)
            .padding(10)
            .background(PhrenTheme.warning.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 12).padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-history-stalled")
        }
    }
}

#if DEBUG && targetEnvironment(simulator)
/// What the chat copied and selected, as a text tests can read.
struct ChatFixtureReport: View {
    var body: some View {
        Text(AgentChatFixture.report.json).font(.system(size: 1)).frame(width: 1, height: 1)
            .accessibilityIdentifier("chat-fixture-copied")
    }
}
#endif

/// The tab's panes when no conversation is open yet: agents to chat with,
/// shells to open as terminals.
struct ChatPanePicker: View {
    let panes: [AgentChatPanes.Pane]
    let isAgent: (AgentChatPanes.Pane) -> Bool
    let choose: (AgentChatPanes.Pane) -> Void
    let openTerminal: (AgentChatPanes.Pane) -> Void

    private var hasAgentPanes: Bool { panes.contains(where: isAgent) }

    var body: some View {
        Text(hasAgentPanes ? "Choose an agent" : "No agent in this tab").font(.title2.weight(.semibold))
        ForEach(panes) { pane in
            if isAgent(pane) {
                Button {
                    choose(pane)
                } label: {
                    HStack { VStack(alignment: .leading) { Text(pane.displayTitle); Text(pane.agent ?? "").font(.caption) }; Spacer(); Image(systemName: "chevron.right") }
                        .padding(16).phrenCard()
                }.buttonStyle(.plain).accessibilityIdentifier("chat-pane:\(pane.id)")
            } else {
                Button { openTerminal(pane) } label: {
                    HStack { VStack(alignment: .leading) { Text(pane.displayTitle); Text("Open terminal").font(.caption) }; Spacer(); Image(systemName: "terminal") }
                        .padding(16).phrenCard()
                }.buttonStyle(.plain).accessibilityIdentifier("chat-terminal-pane:\(pane.id)")
            }
        }
        Text(hasAgentPanes ? "Native chat supports Codex, Claude Code, and GitHub Copilot sessions recognized on this computer."
             : "Start Codex, Claude Code, or GitHub Copilot in the terminal and chat picks it up here.")
            .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
        if panes.contains(where: { $0.agent == "copilot" }) {
            Link("Set up Copilot chat", destination: URL(string: "https://alaarab.github.io/phren/phren-hook.html")!)
                .font(.footnote)
        }
    }
}
