import PhrenKit
import SwiftUI

/// A subagent the agent delegated to: who it was, what it was asked in one
/// line, the model, whether it is still out there, and its report — the
/// first screenful, the rest in the reader. The prompt can be enormous, so it
/// stays behind Show prompt.
struct ChatAgentCard: View {
    let agent: AgentSubagentPresentation
    let entry: ChatTimelineEntry
    @Environment(\.openToolOutput) private var openOutput
    @Environment(\.chatChildAgents) private var childAgents
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var showPrompt = false

    /// The child conversation this card launched, once the computer has
    /// matched its transcript to the call.
    private var child: (agent: AgentChild, target: AgentChatTarget)? {
        guard let childAgents, let agent = childAgents.agent(forCall: entry.callID) else { return nil }
        return (agent, childAgents.target)
    }

    private var status: ToolCardStatus {
        switch agent.state {
        case .running: return .running
        case .done: return .done
        case .failed: return .failed
        }
    }
    private var stateLabel: String {
        switch agent.state {
        case .running: return "running"
        case .done: return "done"
        case .failed: return "failed"
        }
    }
    private var details: String {
        var sections = ["# \(agent.name)"]
        if !agent.description.isEmpty { sections.append("## Task\n\(agent.description)") }
        sections.append(agent.promptAvailable
            ? "## Instructions\n\(agent.prompt.isEmpty ? "No instructions were recorded in the parent conversation." : agent.prompt)"
            : "## Instructions\nCodex protected these instructions, so they are not readable from the parent conversation.")
        if !agent.report.isEmpty { sections.append("## Report\n\(agent.report)") }
        else if let summary = agent.summary { sections.append("## Status\n\(summary)") }
        else { sections.append("## Status\nThe agent is still working or has not returned a report to this conversation.") }
        sections.append("Phren can show the instructions and report recorded in this conversation. Codex does not currently expose the child agent's private reasoning or full tool transcript here.")
        return sections.joined(separator: "\n\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            ToolCardHeader(icon: "person.2", title: agent.name, status: status)
            if !agent.description.isEmpty {
                Text(agent.description).font(.subheadline).foregroundStyle(PhrenTheme.textSecondary)
                    .lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
            }
            if agent.model != nil || agent.background {
                HStack(spacing: 6) {
                    if let model = agent.model { ToolCardChip(text: model) }
                    if agent.background { ToolCardChip(text: "background") }
                }
            }
            if let summary = agent.summary {
                Text(summary).font(.caption.weight(.medium)).lineLimit(2)
                    .foregroundStyle(agent.state == .failed ? PhrenTheme.danger : PhrenTheme.phrenCardAccent)
            }
            if let preview = entry.card?.markdownPreview {
                ChatRichText(text: preview.text, cacheKey: entry.cardMarkdownKey).equatable()
                if preview.truncated {
                    Button("Read full report") { openOutput(.init(title: agent.name, text: agent.report)) }
                        .font(.caption).foregroundStyle(PhrenTheme.accent)
                        .accessibilityIdentifier("chat-agent-report:\(entry.callID)")
                }
            } else if agent.state == .running {
                Text(agent.background ? "Working in the background…" : "Working…")
                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            if let child, let session = childAgents?.session,
               let navigation = navigation(agent: child.agent, session: session, target: child.target) {
                NavigationLink {
                    AgentWorkDestinationView(navigation: navigation)
                } label: {
                    Label(child.agent.state == .running ? "Follow transcript" : "Open transcript", systemImage: "text.bubble")
                        .font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.accent)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-agent-transcript:\(entry.callID)")
            }
            Button("Inspect agent") { openOutput(.init(title: agent.name, text: details)) }
                .font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.accent)
                .accessibilityIdentifier("chat-agent-details:\(entry.callID)")
            if !agent.prompt.isEmpty {
                Button(showPrompt ? "Hide prompt" : "Show prompt") {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { showPrompt.toggle() }
                }
                .font(.caption).foregroundStyle(PhrenTheme.accent)
                .accessibilityIdentifier("chat-agent-prompt:\(entry.callID)")
                if showPrompt {
                    let prompt = ToolOutputPreview(agent.prompt, lines: 12, characters: 2_000)
                    Text(prompt.text).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                        .lineLimit(12).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    if prompt.truncated {
                        Button("Read full prompt") { openOutput(.init(title: "Prompt for \(agent.name)", text: agent.prompt)) }
                            .font(.caption).foregroundStyle(PhrenTheme.accent)
                    }
                }
            }
        }
        .toolCard()
        .toolCardMarker("chat-agent-card:\(entry.callID)", label: "\(agent.name), \(agent.description), \(stateLabel)")
    }

    private func navigation(agent: AgentChild, session: LiveAgentSession,
                            target: AgentChatTarget) -> AgentWorkNavigation? {
        let hosts = (try? LiveSessionPreferences.read(hostData))?.hosts ?? []
        let offline = Set(SessionOverviewMonitor.shared.computers.compactMap { computer in
            computer.monitor.message != nil || (computer.monitor.snapshot != nil && !computer.monitor.isFresh(at: .now))
                ? computer.host.id : nil
        })
        return AgentWorkNavigation.resolve(agent: agent, session: session, target: target,
                                           hosts: hosts, offlineHostIDs: offline)
    }
}
