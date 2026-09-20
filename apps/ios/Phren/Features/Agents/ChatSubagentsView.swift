import PhrenKit
import PhrenLive
import SwiftUI

struct ChatSubagentsView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agents: [AgentChild]
    @Environment(\.dismiss) private var dismiss
    @State private var diffChild: String?

    private var rows: [AgentTreeRow] { AgentTreeRow.flatten(agents) }
    private var total: Int { agents.reduce(0) { $0 + $1.agentCount } }
    private var running: Int { agents.reduce(0) { $0 + $1.runningCount } }
    private var providers: [String] { Array(Set(rows.map { $0.agent.providerName })).sorted() }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    AgentTreeSummary(total: total, running: running, providers: providers)
                    ForEach(rows) { row in
                        NavigationLink {
                            ChildAgentTranscriptView(session: session, target: target, agent: row.agent)
                        } label: {
                            AgentTreeRowView(row: row)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("child-agent:\(row.agent.id)")
                        .contextMenu {
                            Button("Changes", systemImage: "plus.forwardslash.minus") { diffChild = row.agent.id }
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .background(PhrenTheme.chatCanvas)
            .navigationTitle("Agent work")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $diffChild) { child in
                AgentDiffView(session: session, target: target, paths: [], child: child)
            }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct AgentTreeRow: Identifiable, Equatable {
    let agent: AgentChild
    let depth: Int
    let isLastSibling: Bool
    var id: String { agent.id }

    static func flatten(_ agents: [AgentChild], depth: Int = 0) -> [Self] {
        agents.enumerated().flatMap { index, agent in
            [Self(agent: agent, depth: depth, isLastSibling: index == agents.count - 1)]
                + flatten(agent.children, depth: depth + 1)
        }
    }
}

private extension AgentChild {
    var providerName: String {
        switch provider.lowercased() {
        case "claude": return "Claude"
        case "opencode": return "OpenCode"
        case "phren": return "Phren"
        case "copilot": return "Copilot"
        default: return "Codex"
        }
    }
    /// The model is what the owner wants to know; the provider is already
    /// the glyph, so it only stands in when no model was recorded.
    var providerAndModel: String { model ?? providerName }
    var checkoutDisplayLabel: String? {
        guard let checkoutLabel else { return nil }
        if let branch, let worktreeName { return "\(branch) · \(worktreeName)" }
        return checkoutLabel
    }
    var descendantLabel: String? {
        let count = children.reduce(0) { $0 + $1.agentCount }
        guard count > 0 else { return nil }
        return "\(count) \(count == 1 ? "agent" : "agents") below"
    }
}

private struct AgentTreeSummary: View {
    let total: Int
    let running: Int
    let providers: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(PhrenTheme.phrenCardAccent.opacity(0.16))
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.title3.weight(.semibold)).foregroundStyle(PhrenTheme.phrenCardAccent)
                }.frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Agent tree").font(.headline).foregroundStyle(PhrenTheme.text)
                    Text("\(total) \(total == 1 ? "agent" : "agents") · \(running) running")
                        .font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                }
                Spacer()
                if running > 0 {
                    Label("Live", systemImage: "circle.fill").labelStyle(AgentLiveLabelStyle())
                }
            }
            if !providers.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(providers, id: \.self) { ToolCardChip(text: $0) }
                    }
                }
            }
        }
        .padding(16).phrenPanel()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("agent-tree-summary")
    }
}

private struct AgentLiveLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon.font(.system(size: 7)).foregroundStyle(PhrenTheme.cyan)
            configuration.title.font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.cyan)
        }.padding(.horizontal, 9).padding(.vertical, 5)
            .background(PhrenTheme.cyan.opacity(0.12), in: Capsule())
    }
}

private struct AgentTreeRowView: View {
    let row: AgentTreeRow
    private var stateColor: Color { row.agent.state == .running ? PhrenTheme.cyan : PhrenTheme.success }
    private var stateName: String { row.agent.state == .running ? "Running" : "Completed" }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            if row.depth > 0 {
                treeGuide.frame(width: CGFloat(row.depth) * 22 + 8)
            }
            HStack(spacing: 12) {
                // The glyph sits in the middle of the tile; only the state dot
                // hangs off the corner.
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(PhrenTheme.surfaceRaised)
                    AgentProviderGlyph(source: row.agent.provider.lowercased(), size: 24)
                }
                .frame(width: 42, height: 42)
                .overlay(alignment: .bottomTrailing) {
                    Circle().fill(stateColor).frame(width: 9, height: 9)
                        .overlay(Circle().stroke(PhrenTheme.toolPanel, lineWidth: 2))
                        .offset(x: 2, y: 2)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(row.agent.name).font(.body.weight(.semibold)).foregroundStyle(PhrenTheme.text).lineLimit(2)
                    HStack(spacing: 6) {
                        Text(row.agent.providerAndModel)
                        Text("·")
                        Text(stateName).foregroundStyle(stateColor)
                        if let descendants = row.agent.descendantLabel {
                            Text("·"); Text(descendants)
                        }
                    }.font(.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                    if let checkout = row.agent.checkoutDisplayLabel {
                        AgentCheckoutLine(label: checkout)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textDim)
            }
            .padding(14).phrenPanel(tool: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.agent.name), \(row.agent.providerName)" + (row.agent.model.map { ", \($0)" } ?? "") + ", \(stateName)" + (row.agent.descendantLabel.map { ", \($0)" } ?? "") + (row.agent.branch.map { ", \($0)" } ?? ""))
    }

    private var treeGuide: some View {
        GeometryReader { proxy in
            let x = proxy.size.width - 16
            Path { path in
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: row.isLastSibling ? proxy.size.height / 2 : proxy.size.height))
                path.move(to: CGPoint(x: x, y: proxy.size.height / 2))
                path.addLine(to: CGPoint(x: proxy.size.width - 3, y: proxy.size.height / 2))
            }.stroke(PhrenTheme.border, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }.accessibilityHidden(true)
    }
}

private struct AgentCheckoutLine: View {
    let label: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrow.triangle.branch").font(.caption2)
            Text(label).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
        }
        .foregroundStyle(PhrenTheme.textMuted)
        .lineLimit(1)
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

/// A child agent's own conversation, read-only. Follows the transcript live
/// while the agent works, and pages back through what it did earlier.
struct ChildAgentTranscriptView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agent: AgentChild
    @State private var history = AgentChatHistory()
    @State private var loaded = false
    @State private var live = false
    @State private var loadingOlder = false
    @State private var error: String?
    @State private var fullToolOutput: FullToolOutput?
    @State private var textSelection = ChatTextSelection()

    private var entries: [ChatTimelineEntry] { ChatTimelineEntry.group(history.messages) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                transcriptHeader
                if let error {
                    ContentUnavailableView("Transcript unavailable", systemImage: "bubble.left.and.exclamationmark.bubble.right",
                                           description: Text(error))
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                } else if loaded {
                    if history.hasMore {
                        Button {
                            Task { await loadOlder() }
                        } label: {
                            Label(loadingOlder ? "Loading earlier activity…" : "Show earlier activity", systemImage: "clock.arrow.circlepath")
                                .font(.caption).foregroundStyle(PhrenTheme.accent)
                                .padding(12).frame(maxWidth: .infinity, alignment: .leading).phrenPanel(tool: true)
                        }
                        .buttonStyle(.plain).disabled(loadingOlder)
                        .accessibilityIdentifier("child-agent-older")
                    }
                    if history.messages.isEmpty {
                        Text(agent.state == .running ? "Nothing recorded yet." : "This agent recorded no conversation.")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading).phrenPanel(tool: true)
                    }
                    ChatTranscriptRows(revision: history.messages.count, entries: entries, revealed: [:], revealRevision: 0,
                                       images: [:], session: session, target: nil, active: false, preview: { _ in })
                        .accessibilityIdentifier("child-agent-transcript")
                } else {
                    ProgressView("Loading agent transcript…").frame(maxWidth: .infinity).padding(.vertical, 48)
                }
            }.padding(.horizontal, 16).padding(.vertical, 12)
        }
        .background(PhrenTheme.chatCanvas)
        .environment(\.openToolOutput) { fullToolOutput = $0 }
        .environment(textSelection)
        .navigationDestination(item: $fullToolOutput) { FullToolOutputView(output: $0) }
        .navigationTitle(agent.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            NavigationLink {
                AgentDiffView(session: session, target: target, paths: [], child: agent.id)
            } label: {
                Label("Changes", systemImage: "plus.forwardslash.minus")
            }
            .accessibilityIdentifier("chat-subagent-diff")
        }
        .task(id: agent.id) { await follow() }
    }

    private var stateLine: String {
        if agent.state != .running { return "Completed · read-only view" }
        return live ? "Working now · following live" : "Working now · read-only view"
    }

    private var transcriptHeader: some View {
        HStack(spacing: 12) {
            AgentProviderGlyph(source: agent.provider.lowercased(), size: 25)
                .frame(width: 42, height: 42).background(PhrenTheme.phrenCardAccent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 3) {
                Text(agent.providerName + " subagent" + (agent.model.map { " · \($0)" } ?? ""))
                    .font(.headline).foregroundStyle(PhrenTheme.text)
                if let checkout = agent.checkoutDisplayLabel {
                    AgentCheckoutLine(label: checkout)
                }
                Text(stateLine).font(.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            Spacer()
            Circle().fill(agent.state == .running ? PhrenTheme.cyan : PhrenTheme.success).frame(width: 9, height: 9)
        }.padding(14).phrenPanel()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("child-agent-header")
    }

    /// Stream through the parent's socket; a computer whose Hook predates
    /// child streaming still answers the one-shot snapshot.
    @MainActor private func follow() async {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            if let frame = try? AgentChatFixture.childTranscript(child: agent.id) { history.receive(frame); loaded = true }
            else { error = "This agent's activity is not available yet." }
            return
        }
        #endif
        do {
            let key = try DeviceSSHKey.load(session.host.id)
            let updates = PhrenConnection.childAgentUpdates(host: session.host, privateKey: key, target: target, child: agent.id, provider: agent.provider)
            for try await frame in updates {
                if frame.kind != .append || !frame.messages.isEmpty { history.receive(frame) }
                loaded = true; live = true; error = nil
            }
            live = false
        } catch is CancellationError {
            live = false
        } catch {
            live = false
            guard !loaded else { return }
            await loadSnapshot()
        }
    }

    @MainActor private func loadSnapshot() async {
        do {
            let frame = try await PhrenConnection.childAgentTranscript(host: session.host,
                privateKey: DeviceSSHKey.load(session.host.id), target: target, child: agent.id, provider: agent.provider)
            history.receive(frame); loaded = true; error = nil
        } catch is CancellationError {
        } catch {
            self.error = "This agent's activity is not available yet."
        }
    }

    @MainActor private func loadOlder() async {
        guard let before = history.startLine, before > 0, !loadingOlder else { return }
        loadingOlder = true; defer { loadingOlder = false }
        do {
            let page = try await PhrenConnection.childAgentHistory(host: session.host, privateKey: DeviceSSHKey.load(session.host.id),
                target: target, child: agent.id, provider: agent.provider, beforeLine: before)
            history.receive(page)
        } catch { /* The earlier rows stay one tap away; the live tail keeps flowing. */ }
    }
}
