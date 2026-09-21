import PhrenKit
import PhrenLive
import SwiftUI

struct ChatSubagentsView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agents: [AgentChild]
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var selected: AgentWorkNavigation?
    private var overview: SessionOverviewMonitor { .shared }

    /// Finished agents are out of scope here: the sheet is about work in
    /// progress, and a finished worker's result lives in the transcript.
    private var rows: [AgentTreeRow] { AgentTreeRow.rows(agents, includeCompleted: false) }
    private var running: Int { rows.count }
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
                ScrollView {
                    LazyVStack(spacing: 6) {
                    if rows.isEmpty {
                        Text("No agents running")
                            .font(.caption)
                            .foregroundStyle(PhrenTheme.textMuted)
                            .accessibilityIdentifier("chat-subagents-empty")
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    } else {
                        ForEach(rows) { row in
                            let navigation = navigation(for: row.agent)
                            Button { selected = navigation } label: {
                                AgentTreeRowView(row: row, resolution: navigation?.resolution)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("child-agent:\(row.agent.computer == nil ? row.agent.id : row.agent.navigationID)")
                        }
                    }
                    }.padding(.horizontal, 16).padding(.vertical, 8)
                }
            }
            .background(PhrenTheme.chatCanvas)
            .navigationDestination(item: $selected) { AgentWorkDestinationView(navigation: $0) }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private func navigation(for agent: AgentChild) -> AgentWorkNavigation? {
        let hosts = (try? LiveSessionPreferences.read(hostData))?.hosts ?? []
        let offline = Set(overview.computers.compactMap { computer in
            computer.monitor.message != nil || computer.monitor.isStale(at: .now)
                ? computer.host.id : nil
        })
        return AgentWorkNavigation.resolve(agent: agent, session: session, target: target,
                                           hosts: hosts, offlineHostIDs: offline)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("chat-subagents-back")
            VStack(alignment: .leading, spacing: 1) {
                Text("Agent work").font(.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text)
                Text("\(running) running")
                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            Spacer(minLength: 8)
        }
        .foregroundStyle(PhrenTheme.text)
        .padding(.horizontal, 4).padding(.vertical, 2)
        // A marker rather than an identifier on the row, so Back keeps its own id.
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityIdentifier("chat-subagents-header")
        }
    }

}

struct AgentTreeRow: Identifiable, Equatable {
    let agent: AgentChild
    let depth: Int
    let isLastSibling: Bool
    var id: String { agent.navigationID }

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
    let resolution: AgentDestinationResolution?
    private var stateName: String { row.agent.state == .running ? "Running" : "Completed" }
    private var unavailable: Bool {
        if case .offline? = resolution { return true }
        return false
    }
    private var unknown: Bool {
        if case .unknown? = resolution { return true }
        return false
    }
    private var starting: Bool {
        if case .starting? = resolution { return true }
        return false
    }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            if row.depth > 0 {
                treeGuide.frame(width: CGFloat(row.depth) * 16 + 4)
            }
            HStack(spacing: 12) {
                AgentProviderAvatar(provider: row.agent.provider, state: row.agent.state)
                VStack(alignment: .leading, spacing: 3) {
                    // The branch names the checkout; the worktree folder
                    // repeats it, and the task name repeats it again below.
                    HStack(spacing: 5) {
                        Text(row.agent.providerAndModel).foregroundStyle(PhrenTheme.sessionProject).layoutPriority(1)
                        if let checkout = row.agent.checkoutLabel, !checkout.isEmpty {
                            Text("⑂ \(checkout)")
                        }
                    }
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(PhrenTheme.sessionMeta)
                    .lineLimit(1).truncationMode(.tail)
                    Text(row.agent.name).font(.body.weight(.medium)).foregroundStyle(PhrenTheme.text).lineLimit(2)
                    if let computer = row.agent.computer {
                        AgentComputerChip(computer: computer, unavailable: unavailable, unknown: unknown, starting: starting)
                    }
                }
                Spacer(minLength: 8)
            }
            .padding(12).sessionCard()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(rowLabel)
    }

    private var rowLabel: String {
        var parts: [String] = [row.agent.name, row.agent.providerName]
        if let model = row.agent.model { parts.append(model) }
        parts.append(stateName)
        if let computer = row.agent.computer { parts.append(computer.name) }
        if unavailable { parts.append("unavailable") }
        if unknown { parts.append("add computer") }
        if starting { parts.append("starting") }
        if let descendants = row.agent.descendantLabel { parts.append(descendants) }
        if let branch = row.agent.branch { parts.append(branch) }
        return parts.joined(separator: ", ")
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
    let child: String
    let computer: AgentComputer?
    @Environment(\.dismiss) private var dismiss
    @State private var history = AgentChatHistory()
    @State private var loaded = false
    @State private var live = false
    @State private var loadingOlder = false
    @State private var error: String?
    @State private var fullToolOutput: FullToolOutput?
    @State private var textSelection = ChatTextSelection()
    @State private var refresh = UUID()

    init(destination: AgentDestination, agent: AgentChild) {
        session = destination.session(for: agent)
        target = destination.target
        self.agent = agent
        child = destination.child ?? agent.id
        computer = destination.computer
    }

    init(session: LiveAgentSession, target: AgentChatTarget, agent: AgentChild) {
        self.session = session; self.target = target; self.agent = agent
        child = agent.id; computer = nil
    }

    private var entries: [ChatTimelineEntry] { ChatTimelineEntry.group(history.messages) }

    var body: some View {
        VStack(spacing: 0) {
            transcriptHeader
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let error {
                        VStack(spacing: 12) {
                            ContentUnavailableView("Transcript unavailable", systemImage: "bubble.left.and.exclamationmark.bubble.right",
                                                   description: Text(error))
                            Button("Try again") {
                                self.error = nil; loaded = false; refresh = UUID()
                            }
                            .buttonStyle(.bordered).frame(minHeight: 44)
                            .accessibilityIdentifier("child-agent-retry")
                        }.frame(maxWidth: .infinity).padding(.vertical, 40)
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
        .task(id: "\(agent.navigationID)/\(target.id)/\(child)/\(refresh)") { await follow() }
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
                if let computer { AgentComputerChip(computer: computer) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(agent.name), \(agent.providerName)" + (agent.model.map { ", \($0)" } ?? "") + (computer.map { ", \($0.name)" } ?? "") + ", \(stateLine)")
            .accessibilityIdentifier("child-agent-header")
            Spacer(minLength: 0)
            NavigationLink {
                AgentChangesView(session: session, target: target, child: child)
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
            if let frame = try? AgentChatFixture.childTranscript(child: child) { history.receive(frame); loaded = true }
            else { error = "This agent's activity is not available yet." }
            return
        }
        #endif
        do {
            let key = try DeviceSSHKey.load(session.host.id)
            let updates = PhrenConnection.childAgentUpdates(host: session.host, privateKey: key, target: target, child: child, provider: agent.provider)
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
                privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, provider: agent.provider)
            history.receive(frame); loaded = true; error = nil
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor private func loadOlder() async {
        guard let before = history.startLine, before > 0, !loadingOlder else { return }
        loadingOlder = true; defer { loadingOlder = false }
        do {
            let page = try await PhrenConnection.childAgentHistory(host: session.host, privateKey: DeviceSSHKey.load(session.host.id),
                target: target, child: child, provider: agent.provider, beforeLine: before)
            history.receive(page)
        } catch { /* The earlier rows stay one tap away; the live tail keeps flowing. */ }
    }
}
