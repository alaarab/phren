import PhrenKit
import PhrenLive
import SwiftUI

struct ChatSubagentsView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agents: [AgentChild]
    @Environment(\.dismiss) private var dismiss
    @State private var diffChild: String?
    @AppStorage("chat.subagents.showCompleted") private var showingCompleted = false

    private var allRows: [AgentTreeRow] { AgentTreeRow.rows(agents, includeCompleted: true) }
    private var rows: [AgentTreeRow] { AgentTreeRow.rows(agents, includeCompleted: showingCompleted) }
    private var total: Int { allRows.count }
    private var running: Int { allRows.filter { $0.agent.state == .running }.count }
    private var hasCompleted: Bool { total > running }
    private var providers: [String] { Array(Set(rows.map { $0.agent.providerName })).sorted() }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                if providers.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(providers, id: \.self) { ToolCardChip(text: $0) }
                        }
                    }
                    .contentMargins(.horizontal, 16, for: .scrollContent)
                    .padding(.bottom, 6)
                }
                List {
                    if rows.isEmpty && !showingCompleted {
                        HStack(spacing: 8) {
                            Text("No agents running")
                                .font(.caption)
                                .foregroundStyle(PhrenTheme.textMuted)
                            if hasCompleted {
                                Button("Show completed") {
                                    withAnimation(.easeInOut(duration: 0.15)) { showingCompleted = true }
                                }
                                .font(.caption.weight(.medium))
                                .buttonStyle(.bordered)
                                .buttonBorderShape(.capsule)
                                .controlSize(.small)
                                .frame(minHeight: 44)
                            }
                        }
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    } else {
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
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 3, leading: 16, bottom: 3, trailing: 16))
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
            .background(PhrenTheme.chatCanvas)
            .navigationDestination(item: $diffChild) { child in
                AgentDiffView(session: session, target: target, paths: [], child: child)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Agent work").font(.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text)
                Text(showingCompleted ? "\(total) agents · \(running) running" : "\(running) running")
                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            Spacer(minLength: 8)
            Button(showingCompleted ? "Hide completed" : "Show completed") {
                withAnimation(.easeInOut(duration: 0.15)) { showingCompleted.toggle() }
            }
                .font(.caption.weight(.medium))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .frame(minHeight: 44)
                .accessibilityIdentifier("chat-subagents-show-completed")
            Button("Done") { dismiss() }
                .font(.caption.weight(.medium))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .frame(minHeight: 44)
                .accessibilityIdentifier("chat-subagents-done")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        // A marker rather than an identifier on the row, so Done keeps its own id.
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityIdentifier("chat-subagents-header")
        }
    }

}

struct AgentTreeRow: Identifiable, Equatable {
    let agent: AgentChild
    let depth: Int
    let isLastSibling: Bool
    var id: String { agent.id }

    static func flatten(_ agents: [AgentChild], depth: Int = 0) -> [Self] {
        rows(agents, includeCompleted: true).map { row in
            Self(agent: row.agent, depth: row.depth + depth, isLastSibling: row.isLastSibling)
        }
    }

    static func rows(_ agents: [AgentChild], includeCompleted: Bool) -> [Self] {
        let childRows = includeCompleted ? AgentChild.rows(agents, includeCompleted: true)
                                         : AgentChild.runningRows(agents)
        return childRows.indices.map { index in
            let row = childRows[index]
            let following = childRows.dropFirst(index + 1).first { $0.depth <= row.depth }
            return Self(agent: row.agent, depth: row.depth,
                        isLastSibling: following.map { $0.depth != row.depth } ?? true)
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

private struct AgentTreeRowView: View {
    let row: AgentTreeRow
    private var stateName: String { row.agent.state == .running ? "Running" : "Completed" }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            if row.depth > 0 {
                treeGuide.frame(width: CGFloat(row.depth) * 16 + 4)
            }
            HStack(spacing: 12) {
                AgentProviderAvatar(provider: row.agent.provider, state: row.agent.state)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        Text(row.agent.providerAndModel).foregroundStyle(PhrenTheme.sessionProject)
                        if let branch = row.agent.branch, !branch.isEmpty {
                            Text("⑂ \(branch)")
                        }
                        if let worktree = row.agent.worktreeName, !worktree.isEmpty {
                            Text("· \(worktree)")
                        }
                    }
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(PhrenTheme.sessionMeta)
                    .lineLimit(1).truncationMode(.middle)
                    Text(row.agent.name).font(.body.weight(.medium)).foregroundStyle(PhrenTheme.text).lineLimit(2)
                }
                Spacer(minLength: 8)
                if row.agent.state == .running { AgentRunningCapsule() }
            }
            .padding(12).sessionCard()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.agent.name), \(row.agent.providerName)" + (row.agent.model.map { ", \($0)" } ?? "") + ", \(stateName)" + (row.agent.descendantLabel.map { ", \($0)" } ?? "") + (row.agent.branch.map { ", \($0)" } ?? ""))
    }

    private var treeGuide: some View {
        GeometryReader { proxy in
            let x = proxy.size.width - 10
            Path { path in
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: row.isLastSibling ? proxy.size.height / 2 : proxy.size.height))
                path.move(to: CGPoint(x: x, y: proxy.size.height / 2))
                path.addLine(to: CGPoint(x: proxy.size.width - 2, y: proxy.size.height / 2))
            }.stroke(PhrenTheme.border, style: StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round))
        }.accessibilityHidden(true)
    }
}

private struct AgentProviderAvatar: View {
    let provider: String
    let state: AgentChild.State

    private var stateColor: Color { state == .running ? PhrenTheme.cyan : PhrenTheme.success }

    var body: some View {
        ZStack {
            Circle().stroke(stateColor.opacity(0.22), lineWidth: 2).frame(width: 36, height: 36)
            AgentProviderGlyph(source: provider.lowercased(), size: 20)
        }
        .frame(width: 44, height: 44)
        .overlay(alignment: .bottomTrailing) {
            if state == .running {
                Circle().fill(PhrenTheme.cyan).frame(width: 10, height: 10)
                    .overlay(Circle().strokeBorder(PhrenTheme.surface, lineWidth: 1.5))
                    .offset(x: 1, y: 1)
            } else {
                Image(systemName: "checkmark").font(.system(size: 7.5, weight: .bold))
                    .foregroundStyle(Color.black.opacity(0.85))
                    .frame(width: 15, height: 15)
                    .background(PhrenTheme.success, in: Circle())
                    .overlay(Circle().strokeBorder(PhrenTheme.surface, lineWidth: 1.5))
                    .offset(x: 1, y: 1)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct AgentRunningCapsule: View {
    var body: some View {
        Text("Running").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.cyan)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(PhrenTheme.cyan.opacity(0.12), in: Capsule())
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

    private var total: Int { agents.reduce(0) { $0 + $1.agentCount } }
    private var running: Int { agents.reduce(0) { $0 + $1.runningCount } }

    var body: some View {
        Group {
            if let target, !agents.isEmpty {
                Button { showing = true } label: {
                    HStack(spacing: 12) {
                        AgentProviderAvatar(provider: agents[0].provider, state: running > 0 ? .running : .completed)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(total) \(total == 1 ? "agent" : "agents") · \(running) running")
                                .font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.sessionProject)
                            Text("Spawned agents").font(.body.weight(.medium)).foregroundStyle(PhrenTheme.text)
                        }
                        Spacer(minLength: 8)
                        if running > 0 { AgentRunningCapsule() }
                    }.padding(12).sessionCard()
                }
                .buttonStyle(.plain)
                    .accessibilityLabel("Spawned agents, \(total) \(total == 1 ? "agent" : "agents"), \(running) running")
                    .accessibilityIdentifier("session-spawned-agents")
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
    @Environment(\.dismiss) private var dismiss
    @State private var history = AgentChatHistory()
    @State private var loaded = false
    @State private var live = false
    @State private var loadingOlder = false
    @State private var error: String?
    @State private var fullToolOutput: FullToolOutput?
    @State private var textSelection = ChatTextSelection()

    private var entries: [ChatTimelineEntry] { ChatTimelineEntry.group(history.messages) }

    var body: some View {
        VStack(spacing: 0) {
            transcriptHeader
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
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
        }
        .background(PhrenTheme.chatCanvas)
        .environment(\.openToolOutput) { fullToolOutput = $0 }
        .environment(textSelection)
        .navigationDestination(item: $fullToolOutput) {
            FullToolOutputView(output: $0).toolbar(.visible, for: .navigationBar)
        }
        .toolbar(.hidden, for: .navigationBar)
        .task(id: agent.id) { await follow() }
    }

    private var stateLine: String {
        if agent.state != .running { return "Completed · read-only view" }
        return live ? "Working now · following live" : "Working now · read-only view"
    }

    private var transcriptMeta: String {
        var parts = [agent.providerName]
        if let model = agent.model { parts.append(model) }
        if let checkout = agent.checkoutDisplayLabel { parts.append(checkout) }
        return parts.joined(separator: " · ")
    }

    private var transcriptHeader: some View {
        HStack(spacing: 8) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("child-agent-back")
            AgentProviderAvatar(provider: agent.provider, state: agent.state)
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.name).font(.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text).lineLimit(1)
                Text(transcriptMeta)
                    .font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(agent.name), \(agent.providerName)" + (agent.model.map { ", \($0)" } ?? "") + ", \(stateLine)")
            .accessibilityIdentifier("child-agent-header")
            Spacer(minLength: 0)
            NavigationLink {
                AgentDiffView(session: session, target: target, paths: [], child: agent.id)
            } label: {
                Image(systemName: "plus.forwardslash.minus").font(.system(size: 17))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Changes")
            .accessibilityIdentifier("chat-subagent-diff")
        }
        .foregroundStyle(PhrenTheme.text)
        .padding(.horizontal, 4).padding(.vertical, 2)
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
