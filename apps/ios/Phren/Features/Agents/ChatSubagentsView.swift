import PhrenKit
import PhrenLive
import SwiftUI

struct ChatSubagentsView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agents: [AgentChild]
    @Environment(\.dismiss) private var dismiss

    private struct Row: Identifiable {
        let agent: AgentChild
        let depth: Int
        var id: String { agent.id }
    }

    private var rows: [Row] {
        func flatten(_ agents: [AgentChild], depth: Int) -> [Row] {
            agents.flatMap { [Row(agent: $0, depth: depth)] + flatten($0.children, depth: depth + 1) }
        }
        return flatten(agents, depth: 0)
    }

    var body: some View {
        NavigationStack {
            List(rows) { row in
                NavigationLink {
                    ChildAgentTranscriptView(session: session, target: target, agent: row.agent)
                } label: {
                    HStack(spacing: 10) {
                        Color.clear.frame(width: CGFloat(row.depth) * 16)
                        Image(systemName: row.agent.state == .running ? "ellipsis.circle" : "checkmark.circle")
                            .foregroundStyle(row.agent.state == .running ? PhrenTheme.phrenCardAccent : PhrenTheme.success)
                        VStack(alignment: .leading) {
                            Text(row.agent.name).font(.body.weight(.medium))
                            Text(row.agent.state == .running ? "Running" : "Completed").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                        }
                    }
                }
            }
            .navigationTitle("Agent work")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct SessionSubagentSnapshot {
    let target: AgentChatTarget
    let agents: [AgentChild]

    static func load(_ session: LiveAgentSession) async throws -> Self? {
        let panes = try await AgentChatModel.fetchPanes(session)
        guard let pane = panes.panes.first(where: { $0.agent != nil }), let sessionID = pane.sessionId else { return nil }
        let target = try AgentChatTarget(hostID: session.host.id, workspaceID: session.workspaceID,
            tabID: session.tab.id, paneID: pane.id, source: pane.agent ?? session.tab.agent ?? "codex",
            sessionID: sessionID, muxID: session.host.muxID)
        let tree = try await PhrenConnection.childAgents(host: session.host,
            privateKey: DeviceSSHKey.load(session.host.id), target: target)
        return Self(target: target, agents: tree.agents)
    }
}

struct SessionSubagentsCard: View {
    let session: LiveAgentSession
    @State private var target: AgentChatTarget?
    @State private var agents: [AgentChild] = []
    @State private var showing = false

    var body: some View {
        Group {
            if let target, !agents.isEmpty {
                Button { showing = true } label: {
                    HStack {
                        Label("Spawned agents", systemImage: "person.2.wave.2")
                        Spacer()
                        Text("\(agents.reduce(0) { $0 + $1.runningCount }) running").foregroundStyle(PhrenTheme.textMuted)
                        Image(systemName: "chevron.right").foregroundStyle(PhrenTheme.textDim)
                    }.padding(16).phrenPanel(tool: true)
                }.buttonStyle(.plain)
                    .sheet(isPresented: $showing) { ChatSubagentsView(session: session, target: target, agents: agents) }
            }
        }
        .task(id: session.id) {
            while !Task.isCancelled {
                if let snapshot = try? await SessionSubagentSnapshot.load(session) {
                    target = snapshot.target; agents = snapshot.agents
                }
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }
}

private struct ChildAgentTranscriptView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agent: AgentChild
    @State private var transcript: AgentChatTranscript?
    @State private var error: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let error { Text(error).foregroundStyle(PhrenTheme.warning) }
                else if let transcript {
                    ForEach(transcript.messages) { message in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(message.title ?? message.role.rawValue.capitalized).font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                            Text(message.text).font(.system(.caption, design: message.role == .tool ? .monospaced : .default)).textSelection(.enabled)
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading).phrenPanel(tool: message.role == .tool)
                    }
                    if transcript.hasMore {
                        Label("Showing the latest activity. Older activity remains available in the parent conversation.",
                              systemImage: "clock.arrow.circlepath")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted).padding(.top, 4)
                    }
                } else { ProgressView("Loading agent transcript…") }
            }.padding()
        }
        .navigationTitle(agent.name).navigationBarTitleDisplayMode(.inline)
        .task {
            do { transcript = try await PhrenConnection.childAgentTranscript(host: session.host,
                privateKey: DeviceSSHKey.load(session.host.id), target: target, child: agent.id, provider: agent.provider) }
            catch { self.error = "This agent transcript is not available yet." }
        }
    }
}
