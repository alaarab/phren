import PhrenKit
import PhrenLive
import SwiftUI

struct ChatSubagentsView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agents: [AgentChild]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @State private var selected: AgentWorkNavigation?
    /// A worker whose own worktree the Hook knows, opened straight into Changes.
    @State private var changesChild: String?
    static let historyKey = "agent-work.history.v1"
    @AppStorage(Self.historyKey) private var historyData = Data()
    @State private var now = Date.now
    @State private var finishedExpanded = false
    @State private var cleared: Set<String> = []
    @State private var clearing = false
    @State private var clearError: String?
    private var scope: String { target.id }
    /// Decoded once per change of the stored bytes; rows read this, never the JSON.
    @State private var history = AgentWorkHistory()
    private static func decodeHistory(_ data: Data) -> AgentWorkHistory {
        (try? JSONDecoder().decode(AgentWorkHistory.self, from: data)) ?? AgentWorkHistory()
    }
    private var overview: SessionOverviewMonitor { .shared }

    private var rows: [AgentTreeRow] {
        let visible = history.rows(agents, scope: scope, now: now)
        let completedWorkers = AgentChild.rows(agents, includeCompleted: true).filter {
            $0.agent.messageDestination == .worker && $0.agent.displayState == .completed
        }
        return AgentTreeRow.project(visible + completedWorkers).filter { !cleared.contains($0.id) }
    }
    /// Finished workers fold into one row so a long fan-out does not bury
    /// what is still running; failed and refused ones stay in view.
    private var finishedRows: [AgentTreeRow] { rows.filter { $0.depth == 0 && $0.agent.isFinishedLocalWorker } }
    private var activeRows: [AgentTreeRow] { rows.filter { !($0.depth == 0 && $0.agent.isFinishedLocalWorker) } }
    private var running: Int { rows.filter { $0.agent.displayState == .running }.count }
    private var refused: Int { rows.filter(\.agent.permissionRefused).count }
    private var failed: Int { rows.filter { $0.agent.displayState == .failed && !$0.agent.permissionRefused }.count }
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
                        ForEach(activeRows) { row in treeRow(row) }
                        if !finishedRows.isEmpty {
                            finishedGroup
                            if finishedExpanded {
                                ForEach(finishedRows) { row in treeRow(row) }
                            }
                        }
                    }
                    #if DEBUG && targetEnvironment(simulator)
                    if AgentChatFixture.enabled {
                        Text(AgentChatFixture.report.childDelivery).font(.caption2).frame(height: 1).clipped()
                            .accessibilityIdentifier("child-agents-fixture-delivery")
                    }
                    #endif
                    }.padding(.horizontal, 16).padding(.vertical, 8)
                }
            }
            .background(PhrenTheme.chatCanvas)
            .navigationDestination(item: $selected) { AgentWorkDestinationView(navigation: $0) }
            .navigationDestination(item: $changesChild) { AgentChangesView(session: session, target: target, child: $0) }
            .toolbar(.hidden, for: .navigationBar)
        }
        .onChange(of: historyData, initial: true) { _, data in history = Self.decodeHistory(data) }
        .onChange(of: agents, initial: true) { _, fresh in
            var next = Self.decodeHistory(historyData)
            next.observe(fresh, scope: scope, now: .now)
            historyData = (try? JSONEncoder().encode(next)) ?? historyData
        }
        // Ages and the finished linger move every thirty seconds.
        .task { await LiveRefresh.shared.every(.seconds(30), key: "subagents-age:\(target.id)") { now = .now } }
    }

    private func treeRow(_ row: AgentTreeRow) -> some View {
        let navigation = navigation(for: row.agent)
        let showsChanges = row.agent.computer == nil && row.agent.worktreeName != nil
        let failed = row.agent.displayState == .failed
        // The actions sit inside the card's trailing edge, so the card keeps
        // the full width and saves room for them.
        let actions = CGFloat((showsChanges ? 1 : 0) + (failed ? 1 : 0))
        return ZStack(alignment: .trailing) {
            Button { selected = navigation } label: {
                AgentTreeRowView(row: row, resolution: navigation?.resolution,
                    age: failed ? history.age(row.agent, scope: scope, now: now) : nil,
                    trailingInset: actions * 44)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("child-agent:\(row.agent.computer == nil ? row.agent.id : row.agent.navigationID)")
            HStack(spacing: 0) {
            if showsChanges {
                // Its edits live in its own worktree, which the pane's diff never shows.
                Button { changesChild = row.agent.id } label: {
                    Image(systemName: "plus.forwardslash.minus").font(.system(size: 16))
                        .foregroundStyle(PhrenTheme.textMuted).frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Changes")
                .accessibilityIdentifier("child-agent-changes:\(row.agent.id)")
            }
            if failed {
                Button {
                    var next = Self.decodeHistory(historyData)
                    next.dismissed.insert(scope + "/" + row.agent.navigationID)
                    historyData = (try? JSONEncoder().encode(next)) ?? historyData
                } label: {
                    // The whole 44 pt square takes the tap: it sits over the
                    // row's own button, which the glyph's gaps would open.
                    Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityLabel("Dismiss failed worker")
                    .accessibilityIdentifier("dismiss-child-agent:\(row.agent.id)")
            }
            }
            .padding(.trailing, 4)
        }
    }

    private var finishedGroup: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Button { withAnimation(.snappy(duration: 0.2)) { finishedExpanded.toggle() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .rotationEffect(.degrees(finishedExpanded ? 90 : 0))
                            .accessibilityHidden(true)
                        Text("\(finishedRows.count) finished")
                            .font(.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.textSecondary)
                        Spacer(minLength: 8)
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(finishedRows.count) finished \(finishedRows.count == 1 ? "worker" : "workers")")
                .accessibilityValue(finishedExpanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("child-agents-finished")
                Button { Task { await clearFinished() } } label: {
                    Text(clearing ? "Clearing" : "Clear finished")
                        .font(.caption.weight(.medium)).foregroundStyle(PhrenTheme.accent)
                        .padding(.horizontal, 12).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(clearing)
                .accessibilityIdentifier("child-agents-clear-finished")
            }
            .sessionCard()
            if let clearError {
                Text(clearError).font(.caption).foregroundStyle(PhrenTheme.warning)
                    .accessibilityIdentifier("child-agents-clear-error")
            }
        }
    }

    /// Asks this chat's Hook to archive its finished workers now, then hides
    /// the rows it had shown until the next tree read drops them.
    @MainActor private func clearFinished() async {
        guard !clearing else { return }
        let finished = Set(finishedRows.map(\.id))
        clearing = true; clearError = nil
        defer { clearing = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { _ = AgentChatFixture.archiveFinishedChildren(target) }
            else {
                _ = try await PhrenConnection.archiveFinishedChildAgents(host: session.host,
                    privateKey: DeviceSSHKey.load(session.host.id), target: target)
            }
            #else
            _ = try await PhrenConnection.archiveFinishedChildAgents(host: session.host,
                privateKey: DeviceSSHKey.load(session.host.id), target: target)
            #endif
            cleared.formUnion(finished)
            finishedExpanded = false
        } catch {
            clearError = "Could not clear finished workers: \(error.localizedDescription)"
        }
    }

    private func navigation(for agent: AgentChild) -> AgentWorkNavigation? {
        let hosts = preferencesStore.preferences?.hosts ?? []
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
                Text("\(running) running" + (refused > 0 ? " · \(refused) refused" : "") + (failed > 0 ? " · \(failed) failed" : ""))
                    .font(.caption).foregroundStyle(refused > 0 ? PhrenTheme.warning : PhrenTheme.textMuted)
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
        return project(childRows)
    }

    static func project(_ childRows: [AgentChildTreeRow]) -> [Self] {
        childRows.indices.map { index in
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
    var age: String? = nil
    /// Room kept at the card's trailing edge for the buttons drawn over it.
    var trailingInset: CGFloat = 0
    private var stateName: String {
        switch row.agent.displayState {
        case .running: return "Running"
        case .completed: return "Completed"
        case .failed: return "Failed"
        }
    }
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
                AgentProviderAvatar(provider: row.agent.provider, state: row.agent.displayState)
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
                    HStack(spacing: 6) {
                        Text(row.agent.displayName)
                            .font(.body.weight(.medium))
                            .foregroundStyle(row.agent.permissionRefused ? PhrenTheme.warning : PhrenTheme.text)
                            .lineLimit(2)
                        if row.agent.permissionRefused {
                            PhrenChip(text: "FAILED", icon: "exclamationmark", color: PhrenTheme.warning)
                        }
                    }
                    if let age {
                        Text(age).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                    if let detail = row.agent.refusedDetail {
                        Text(detail).font(.caption).foregroundStyle(PhrenTheme.warning).lineLimit(2)
                    }
                    if let computer = row.agent.computer {
                        AgentComputerChip(computer: computer, unavailable: unavailable, unknown: unknown, starting: starting)
                    }
                }
                Spacer(minLength: 8)
            }
            .padding(12).padding(.trailing, trailingInset).sessionCard()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(rowLabel)
    }

    private var rowLabel: String {
        var parts: [String] = [row.agent.displayName, row.agent.providerName]
        if let model = row.agent.model { parts.append(model) }
        parts.append(stateName)
        if let age { parts.append(age) }
        if let detail = row.agent.refusedDetail { parts.append(detail) }
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

    private var stateColor: Color {
        switch state {
        case .running: return PhrenTheme.cyan
        case .completed: return PhrenTheme.success
        case .failed: return PhrenTheme.warning
        }
    }

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
            } else if state == .completed {
                Image(systemName: "checkmark").font(.system(size: 7.5, weight: .bold))
                    .foregroundStyle(Color.black.opacity(0.85))
                    .frame(width: 15, height: 15)
                    .background(PhrenTheme.success, in: Circle())
                    .overlay(Circle().strokeBorder(PhrenTheme.surface, lineWidth: 1.5))
                    .offset(x: 1, y: 1)
            } else {
                Image(systemName: "exclamationmark").font(.system(size: 7.5, weight: .bold))
                    .foregroundStyle(Color.black.opacity(0.85))
                    .frame(width: 15, height: 15)
                    .background(PhrenTheme.warning, in: Circle())
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

/// A session's sub-agent tree, read once for every view that shows it (its
/// card, its row in the agent drawer, its details) through `LiveRefresh`.
/// Every ten seconds while the session has running children or conducts,
/// every thirty otherwise.
@Observable @MainActor
final class SessionSubagentStore {
    static let shared = SessionSubagentStore()
    struct Entry: Equatable {
        var target: AgentChatTarget?
        var agents: [AgentChild] = []
    }
    private(set) var entries: [LiveAgentSession.ID: Entry] = [:]

    func entry(_ session: LiveAgentSession) -> Entry { entries[session.id] ?? Entry() }

    /// Keeps this session's tree current while the calling task lives.
    func follow(_ session: LiveAgentSession) async {
        let busy = session.tab.runningChildren > 0 || session.tab.isConductor
        await LiveRefresh.shared.every(.seconds(busy ? 10 : 30), key: "subagents:\(session.id)") { [weak self] in
            await self?.load(session)
        }
    }

    private func load(_ session: LiveAgentSession) async {
        let loaded: SessionSubagentSnapshot?
        do { loaded = try await SessionSubagentSnapshot.load(session) } catch { loaded = nil }
        let entry = loaded.map { Entry(target: $0.target, agents: $0.agents) } ?? Entry()
        if entries[session.id] != entry { entries[session.id] = entry }
        if let loaded {
            let computers = AgentChild.runningRows(loaded.agents).compactMap { $0.agent.computer?.name }
            await SessionWorkingActivityController.shared.observeSubagents(
                session: session, count: loaded.agents.reduce(0) { $0 + $1.runningCount }, computers: computers)
        } else {
            await SessionWorkingActivityController.shared.observeSubagents(session: session, count: session.tab.runningChildren)
        }
    }
}

struct SessionSubagentsCard: View {
    let session: LiveAgentSession
    @State private var showing = false
    private var store: SessionSubagentStore { .shared }
    private var target: AgentChatTarget? { store.entry(session).target }
    private var agents: [AgentChild] { store.entry(session).agents }

    private var total: Int { agents.reduce(0) { $0 + $1.agentCount } }
    private var running: Int { agents.reduce(0) { $0 + $1.runningCount } }
    private var refused: Int { agents.reduce(0) { $0 + $1.refusedCount } }

    var body: some View {
        Group {
            if let target, !agents.isEmpty {
                Button { showing = true } label: {
                    HStack(spacing: 12) {
                        AgentProviderAvatar(provider: agents[0].provider,
                                            state: running > 0 ? .running : refused > 0 ? .failed : .completed)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(total) \(total == 1 ? "agent" : "agents") · \(running) running"
                                 + (refused > 0 ? " · \(refused) refused" : ""))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(refused > 0 ? PhrenTheme.warning : PhrenTheme.sessionProject)
                            Text("Spawned agents").font(.body.weight(.medium)).foregroundStyle(PhrenTheme.text)
                        }
                        Spacer(minLength: 8)
                        if running > 0 { AgentRunningCapsule() }
                    }.padding(12).sessionCard()
                }
                .buttonStyle(.plain)
                    .accessibilityLabel("Spawned agents, \(total) \(total == 1 ? "agent" : "agents"), \(running) running"
                                        + (refused > 0 ? ", \(refused) refused" : ""))
                    .accessibilityIdentifier("session-spawned-agents")
                    .sheet(isPresented: $showing) { ChatSubagentsView(session: session, target: target, agents: agents) }
            }
        }
        .task(id: session.id) { await store.follow(session) }
    }
}

/// A child's transcript with explicit worker continuation or parent delivery.
/// Pane-backed children use their full session chat through AgentWorkDestinationView.
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
    @State private var nearTop = false
    @State private var pagingReady = false
    @State private var error: String?
    @State private var fullToolOutput: FullToolOutput?
    @State private var textSelection = ChatTextSelection()
    @State private var refresh = UUID()
    @State private var draft = ""
    @State private var sending = false
    @State private var sendError: String?
    @State private var delivery: String?
    @State private var messages: [AgentFanoutMessage] = []

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
            ScrollViewReader { proxy in
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
                            // Scrolling to the top loads the earlier page, as in chat;
                            // the first row stays where it was.
                            ProgressView().frame(maxWidth: .infinity, minHeight: 32)
                                .accessibilityLabel("Loading earlier activity")
                        }
                        if history.messages.isEmpty {
                            Text(agent.permissionRefused ? "The worker was refused before it ran." : agent.state == .running ? "Nothing recorded yet." : "This agent recorded no conversation.")
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
            .defaultScrollAnchor(.bottom)
            .modifier(ChatHistoryScrollObserver { near in
                nearTop = near
                if near { Task { await loadOlder(proxy) } }
            })
            .task(id: loaded) {
                // Let the first page settle at the bottom before deciding
                // whether the reader is at the top.
                pagingReady = false
                guard loaded else { return }
                do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
                pagingReady = true
                if nearTop { await loadOlder(proxy) }
            }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { childComposer }
        .background(PhrenTheme.chatCanvas)
        .environment(\.openToolOutput) { fullToolOutput = $0 }
        .environment(textSelection)
        .navigationDestination(item: $fullToolOutput) {
            FullToolOutputView(output: $0).toolbar(.visible, for: .navigationBar)
        }
        .toolbar(.hidden, for: .navigationBar)
        .task(id: "\(agent.navigationID)/\(target.id)/\(child)/\(refresh)") { await follow() }
        .task(id: "messages/\(agent.navigationID)") { await followMessages() }
    }

    private var childComposer: some View {
        VStack(alignment: .leading, spacing: 8) {
            let pending = messages.filter { $0.status == .queued || $0.status == .failed }
            if !pending.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(pending) { message in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(message.text).font(.body).foregroundStyle(PhrenTheme.text)
                                Text(message.status == .queued ? "Queued until this worker finishes" : "Worker continuation failed")
                                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading).sessionCard()
                            .accessibilityIdentifier("child-message:\(message.id.uuidString.lowercased())")
                        }
                    }
                }.frame(maxHeight: 160)
            }
            if let delivery {
                Text(delivery).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityIdentifier("child-message-delivery")
            }
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                Text(AgentChatFixture.report.childDelivery).font(.caption2).frame(height: 1).clipped()
                    .accessibilityIdentifier("child-fixture-delivery")
            }
            #endif
            if let sendError {
                Text(sendError).font(.caption).foregroundStyle(PhrenTheme.warning)
                    .accessibilityIdentifier("child-message-error")
            }
            Text(agent.messageNote).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                .accessibilityIdentifier("child-composer-note")
            HStack(alignment: .bottom, spacing: 8) {
                PhrenChildMessageField(text: $draft,
                    placeholder: agent.messageDestination == .parent ? "Message parent…" : "Message worker…")
                PhrenIconButton(icon: "arrow.up", label: sending ? "Sending" : "Send message") {
                    Task { await sendMessage() }
                }
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || agent.messageDestination == .unavailableWorker)
                .accessibilityIdentifier("child-composer-send")
            }
            .disabled(sending || agent.messageDestination == .unavailableWorker)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(PhrenTheme.chatCanvas)
    }

    @MainActor private func sendMessage() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, !text.isEmpty else { return }
        sending = true; sendError = nil
        defer { sending = false }
        do {
            if agent.messageDestination == .worker {
                let receipt: AgentFanoutMessage
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled {
                    receipt = try AgentChatFixture.resumeChild(agent, target: target, child: child, text: text)
                } else {
                    receipt = try await PhrenConnection.resumeChildAgent(host: session.host,
                        privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, text: text)
                }
                #else
                receipt = try await PhrenConnection.resumeChildAgent(host: session.host,
                    privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, text: text)
                #endif
                messages.removeAll { $0.id == receipt.id }
                messages.append(receipt)
                switch receipt.status {
                case .queued: delivery = "Queued for this worker"
                case .running: delivery = "Continuing this worker"
                case .completed: delivery = "Worker finished"
                case .failed: delivery = "Worker continuation failed"; return
                }
            } else if agent.messageDestination == .parent {
                let labeled = agent.parentMessage(text)
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled { try await AgentChatFixture.send(target, text: labeled) }
                else { try await PhrenConnection.sendChat(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, text: labeled) }
                #else
                try await PhrenConnection.sendChat(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, text: labeled)
                #endif
                delivery = "Sent to parent: \(labeled)"
            } else { return }
            draft = ""
        } catch {
            sendError = error.localizedDescription + " Check delivery before sending again."
        }
    }

    @MainActor private func followMessages() async {
        guard agent.messageDestination == .worker else { return }
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { return }
        #endif
        await LiveRefresh.shared.every(.seconds(2), key: "worker-messages:\(target.id):\(child)") {
            do {
                messages = try await PhrenConnection.childAgentMessages(host: session.host,
                    privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child)
                if messages.contains(where: { $0.status == .running }) { delivery = "Continuing this worker" }
                else if messages.last?.status == .completed { delivery = "Worker finished" }
            } catch { /* Keep acknowledged receipts through a transient disconnect. */ }
        }
    }

    private var workerDisplayState: AgentChild.State {
        guard let latest = messages.last else { return agent.displayState }
        switch latest.status {
        case .queued, .running: return .running
        case .completed: return .completed
        case .failed: return .failed
        }
    }

    private var stateLine: String {
        if let latest = messages.last {
            switch latest.status {
            case .queued: return "Working now · follow-up queued"
            case .running: return "Working now · continuing worker"
            case .completed: return "Completed"
            case .failed: return "Continuation failed"
            }
        }
        if agent.permissionRefused {
            return [agent.displayName, agent.refusedDetail].compactMap { $0 }.joined(separator: " · ")
        }
        if agent.state != .running { return "Completed" }
        return live ? "Working now · following live" : "Working now"
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
            AgentProviderAvatar(provider: agent.provider, state: workerDisplayState)
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.displayName)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(agent.permissionRefused ? PhrenTheme.warning : PhrenTheme.text).lineLimit(1)
                Text(transcriptMeta)
                    .font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                if let detail = agent.refusedDetail {
                    Text(detail).font(.caption2).foregroundStyle(PhrenTheme.warning).lineLimit(1)
                }
                if let computer { AgentComputerChip(computer: computer) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(agent.displayName), \(agent.providerName)" + (agent.model.map { ", \($0)" } ?? "") + (computer.map { ", \($0.name)" } ?? "") + ", \(stateLine)")
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

    @MainActor private func loadOlder(_ proxy: ScrollViewProxy) async {
        guard pagingReady, history.hasMore, let before = history.startLine, before > 0, !loadingOlder else { return }
        loadingOlder = true; defer { loadingOlder = false }
        let anchor = entries.first?.id
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                guard let page = AgentChatFixture.childHistory(child: child, before: before) else { return }
                history.receive(page)
                keep(anchor, proxy)
                return
            }
            #endif
            let page = try await PhrenConnection.childAgentHistory(host: session.host, privateKey: DeviceSSHKey.load(session.host.id),
                target: target, child: child, provider: agent.provider, beforeLine: before)
            history.receive(page)
            keep(anchor, proxy)
        } catch { /* Scrolling back to the top tries again; the live tail keeps flowing. */ }
    }

    /// Holds the row that was first before the older page arrived at the top.
    @MainActor private func keep(_ anchor: String?, _ proxy: ScrollViewProxy) {
        guard let anchor else { return }
        let row = entries.first { $0.id == anchor || $0.messages.contains { $0.id == anchor } }?.id ?? anchor
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(row, anchor: .top) }
    }
}

/// Phren's plain, growing message field, using the same field surface and spacing as chat.
private struct PhrenChildMessageField: View {
    @Binding var text: String
    let placeholder: String
    var body: some View {
        PhrenTextField(placeholder, text: $text, identifier: "child-composer-field", axis: .vertical)
            .lineLimit(1...6)
    }
}
