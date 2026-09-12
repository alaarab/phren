import PhrenKit
import PhrenLive
import SwiftUI

struct LiveSessionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var adding = false
    @State private var visible = false
    @State private var query = ""
    @State private var refreshID = UUID()
    @State private var overview = SessionOverviewMonitor()
    @State private var selected: OverviewSelection?
    @State private var chatSession: LiveAgentSession?
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }

    private struct OverviewSelection: Identifiable {
        let session: LiveAgentSession
        let monitor: LiveHostMonitor
        var id: LiveAgentSession.ID { session.id }
    }
    private struct PollID: Equatable { let hosts: [LiveHost]; let active: Bool; let refresh: UUID }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            PhrenList {
                Section {
                    let connected = overview.connectedCount(at: context.date)
                    Text(hosts.isEmpty ? "Connect a computer to see its sessions here."
                         : "Sessions across your computers · \(connected)/\(hosts.count) connected")
                        .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                        .accessibilityIdentifier("agents-introduction")
                        .padding(.vertical, 2)
                        .listRowBackground(Color.clear)
                }
                sessionSections(at: context.date)
                Section {
                    if let preferences = try? LiveSessionPreferences.read(data) {
                        ForEach(preferences.hosts) { host in
                            NavigationLink { LiveHostView(hostID: host.id) } label: {
                                let monitor = overview.computers.first { $0.id == host.id }?.monitor
                                PhrenMenuRow(title: host.name, subtitle: monitor?.snapshot == nil && monitor?.message == nil ? "Connecting…" : host.address, icon: "desktopcomputer")
                            }
                            .accessibilityIdentifier("live-host:\(host.id)")
                        }
                        Button("Add computer", systemImage: "plus") { adding = true }
                    } else {
                        Text("Saved connections couldn't be read. They have been preserved; update phren before editing them.")
                            .foregroundStyle(.orange)
                    }
                } header: {
                    Text("Computers")
                } footer: {
                    Text("Keep Tailscale connected on both devices when you're away. Phren Hook connects your existing agents.")
                }
                Section("Agent setup") {
                    if model.phase == .ready {
                    NavigationLink { SkillsView() } label: {
                        PhrenMenuRow(title: "Skills", icon: "wand.and.stars", color: PhrenTheme.lavender)
                    }
                    NavigationLink { AgentsView() } label: {
                        PhrenMenuRow(title: "Agent instructions", icon: "person.crop.rectangle.stack")
                    }
                    } else {
                        Button {
                            model.showingMemoryConnection = true
                        } label: {
                            Label("Connect memory for skills & instructions", systemImage: "brain")
                        }
                    }
                }
            }
            .listSectionSpacing(12)
            .opacity(hosts.isEmpty || overview.ready ? 1 : 0)
            .allowsHitTesting(hosts.isEmpty || overview.ready)
            .accessibilityHidden(!hosts.isEmpty && !overview.ready)
            .overlay {
                if !hosts.isEmpty && !overview.ready {
                    VStack(spacing: 14) {
                        ProgressView().tint(PhrenTheme.cyan)
                        Text("Connecting your sessions").font(.subheadline.weight(.medium))
                        Text("Across \(hosts.count) \(hosts.count == 1 ? "computer" : "computers")")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(PhrenTheme.bg).accessibilityIdentifier("agents-loading")
                }
            }
        }
        .navigationTitle("Live sessions")
        // Keep the title in the navigation bar rather than the collapsible
        // large-title region when this list is hosted directly by a tab.
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search all sessions")
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .phrenScreen()
        .toolbar {
            NavigationLink { WebServersView() } label: { Label("Web servers", systemImage: "globe") }
                .accessibilityIdentifier("all-web-servers")
            Button("Refresh all sessions", systemImage: "arrow.clockwise") { refreshID = UUID() }
        }
        .refreshable { refreshID = UUID() }
        .sheet(isPresented: $adding) { NavigationStack { LiveHostEditor() } }
        .sheet(item: $selected) { selection in
            LiveSessionDetailView(sessionID: selection.id, monitor: selection.monitor)
        }
        .sheet(item: $chatSession) { AgentChatSheet(session: $0) }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .task(id: PollID(hosts: hosts, active: visible && scenePhase == .active && !adding, refresh: refreshID)) {
            guard visible, scenePhase == .active, !adding else { return }
            await overview.run(hosts: hosts)
        }
    }

    @ViewBuilder
    private func sessionSections(at date: Date) -> some View {
        let groups = overview.groups(at: date, query: query, preferences: preferences, projects: model.sessionProjects)
        if !hosts.isEmpty && groups.isEmpty {
            Section {
                if overview.computers.isEmpty || overview.computers.contains(where: { $0.monitor.snapshot == nil && $0.monitor.refreshing }) {
                    HStack { ProgressView(); Text("Finding sessions…") }.font(.subheadline)
                } else {
                    Text(!query.isEmpty ? "No matching sessions"
                         : overview.connectedCount(at: date) == 0 && overview.computers.contains(where: { $0.monitor.message != nil })
                         ? "No computers connected" : "No sessions running on the connected computers")
                        .font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                }
            }
        }
        ForEach(groups) { group in
            Section {
                ForEach(group.sessions) { session in
                    LiveSessionCard(session: session, fresh: overview.isFresh(session, at: date), showHost: true, onChat: { chatSession = session }) {
                        if let computer = overview.computers.first(where: { $0.id == session.host.id }) {
                            selected = OverviewSelection(session: session, monitor: computer.monitor)
                        }
                    }
                    .separatedSessionRow()
                }
            } header: { Text("\(group.title) · \(group.sessions.count)") }
            footer: {
                if group.id == "previous" { Text("These computers aren't connected. Reconnect before opening a session.") }
            }
        }
        let problems = overview.computers.filter { $0.monitor.message != nil }
        if !problems.isEmpty {
            Section("Connections") {
                ForEach(problems) { computer in
                    NavigationLink { LiveHostView(hostID: computer.id) } label: {
                        HStack {
                            Text(computer.host.name)
                            Spacer()
                            Text(computer.monitor.fingerprint != nil ? "Verify connection" : "Offline")
                                .font(.caption).foregroundStyle(PhrenTheme.warning)
                        }
                    }.accessibilityIdentifier("overview-reconnect:\(computer.id)")
                }
            }
        }
    }
}

@Observable @MainActor
final class LiveHostMonitor {
    var snapshot: LiveWorkspaces?
    var lastUpdated: Date?
    var message: String?
    var fingerprint: String?
    var refreshing = false
    var polling = false
    private var generation = UUID()
    @ObservationIgnored private let fetchSnapshot: (LiveHost, Date?) async throws -> LiveWorkspaces
    @ObservationIgnored private let pollInterval: Duration

    init(pollInterval: Duration = .seconds(10), fetch: @escaping (LiveHost, Date?) async throws -> LiveWorkspaces = { try await LiveHostMonitor.fetch($0, previousUpdate: $1) }) {
        self.pollInterval = pollInterval; self.fetchSnapshot = fetch
    }

    func run(host: LiveHost, onFirstRefresh: (@MainActor () -> Void)? = nil) async {
        let run = UUID()
        generation = run
        polling = true
        var first = true
        defer { if generation == run { polling = false; refreshing = false } }
        while !Task.isCancelled {
            refreshing = true
            do {
                let value = try await fetchSnapshot(host, lastUpdated)
                try Task.checkCancellation()
                guard generation == run else { return }
                snapshot = value
                lastUpdated = Date()
                message = nil
                fingerprint = nil
            } catch {
                guard !Task.isCancelled, generation == run else { return }
                message = (error as? LiveConnectionError)?.localizedDescription
                    ?? (error as? PhrenKitError)?.localizedDescription
                    ?? "Couldn't reach the computer. Check the address, Tailscale, SSH, and Phren Hook."
                if case LiveConnectionError.untrustedHost(let key) = error { fingerprint = key }
            }
            refreshing = false
            if first { first = false; onFirstRefresh?() }
            if fingerprint != nil { return }
            do { try await Task.sleep(for: pollInterval) } catch { return }
        }
    }

    static func fetch(_ host: LiveHost, previousUpdate: Date? = nil) async throws -> LiveWorkspaces {
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--all-sessions-fixture") {
            if ProcessInfo.processInfo.arguments.contains("--all-sessions-empty") {
                return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[]}"#.utf8))
            }
            let remote = host.id.uuidString.hasSuffix("000002")
            if remote && previousUpdate == nil && ProcessInfo.processInfo.arguments.contains("--all-sessions-delayed") {
                try await Task.sleep(for: .seconds(4))
            }
            if remote && previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--all-sessions-offline") {
                throw LiveConnectionError.disconnected
            }
            let title = remote ? "Review Linux deployment" : "Build the iPhone overview"
            let finished = previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--all-sessions-change")
            let status = remote ? "waiting" : finished ? "done" : "working"
            let other = remote ? "Inspect logs" : "Check project status"
            return try LiveWorkspaces.read(Data("""
            {"kind":"herdr","groups":[{"id":"w1","label":"Shared project","children":[
            {"id":"w1:t1","label":"1","title":"\(title)","agent":"codex","agentStatus":"\(status)","cwd":"/work/phone","contextUsedPercent":\(remote ? 62 : 37)},
            {"id":"w1:t2","label":"2","title":"\(other)","agent":"codex","agentStatus":"idle","cwd":"/work/phone"}]}]}
            """.utf8))
        }
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--automatic-sessions-fixture") {
            if ProcessInfo.processInfo.arguments.contains("--session-discovery-offline") { throw LiveConnectionError.disconnected }
            if ProcessInfo.processInfo.arguments.contains("--session-details-fixture") {
                if previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--session-details-removed") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[]}"#.utf8))
                }
                if ProcessInfo.processInfo.arguments.contains("--terminal-uploads-fixture") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","focus":{"workspaceID":"w8","tabID":"w8:t1","paneID":"w8:p1"},"groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"Original tab","agent":"codex"}]},{"id":"w8","label":"Other work","children":[{"id":"w8:t1","label":"1","title":"Current terminal tab","agent":"codex"}]}]}"#.utf8))
                }
                return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"Polish the phone app","agent":"codex","agentStatus":"working","cwd":"/work/phone/src","agentPaneCount":2,"paneCount":3}]},{"id":"w8","label":"Other work","children":[{"id":"w8:t1","label":"1","title":"Choose the deployment target","agent":"claude","agentStatus":"waiting","cwd":"/work/other"}]},{"id":"w9","label":"Shell","children":[{"id":"w9:t1","label":"1"}]}]}"#.utf8))
            }
            if ProcessInfo.processInfo.arguments.contains("--observed-live-session-ids") {
                // Match the reported shape: every workspace's first tab is
                // labelled "1", IDs include uppercase letters, and order changes.
                var groups = [
                    #"{"id":"w7","label":"Phone work","children":[{"id":"w7:t1","label":"1","cwd":"/work/phone"}]}"#,
                    #"{"id":"wC","label":"Other work","children":[{"id":"wC:t1","label":"1","cwd":"/work/other"}]}"#,
                    #"{"id":"w2","label":"Third work","children":[{"id":"w2:t1","label":"1","cwd":"/work/third"}]}"#,
                ]
                if previousUpdate != nil { groups.reverse() }
                return try LiveWorkspaces.read(Data((#"{"kind":"herdr","groups":["# + groups.joined(separator: ",") + "]}").utf8))
            }
            let extra = ProcessInfo.processInfo.arguments.contains("--multiple-project-sessions")
                ? #",{"id":"w7:t10","label":"Review phone changes","agent":"claude","agentStatus":"waiting","cwd":"/work/phone"}"# : ""
            return try LiveWorkspaces.read(Data((#"{"kind":"herdr","groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"Build phone app","agent":"codex","agentStatus":"working","cwd":"/work/phone/src","sessionId":"not-a-server"}"# + extra + #"]},{"id":"w8","label":"Other work","children":[{"id":"w8:t1","label":"Unrelated session","cwd":"/work/other"}]}]}"#).utf8))
        }
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--live-sessions-fixture") {
            if previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--live-sessions-offline") {
                throw LiveConnectionError.disconnected
            }
            return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w1","label":"Phone project","children":[{"id":"w1:t1","label":"Build graph","agent":"codex","agentStatus":"working","cwd":"/work/demo","agentPaneCount":1}]}]}"#.utf8))
        }
        #endif
        return try await PhrenConnection.fetch(host: host, privateKey: DeviceSSHKey.load(host.id))
    }
}

private struct LiveHostView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var monitor = LiveHostMonitor()
    @State private var editing = false
    @State private var refreshID = UUID()
    @State private var localError: String?
    @State private var query = ""
    @State private var mode: SessionViewMode = .workspaces
    @State private var selected: LiveAgentSession?
    let hostID: UUID

    private enum SessionViewMode: String, CaseIterable {
        case workspaces = "Workspaces", activity = "Activity"
    }
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var host: LiveHost? { preferences?.hosts.first { $0.id == hostID } }
    private var sessions: [LiveAgentSession] {
        guard let host else { return [] }
        return monitor.snapshot?.sessions(on: host) ?? []
    }
    private var visible: [LiveAgentSession] {
        let preferences = preferences
        let projects = model.sessionProjects
        return sessions.filter { session in
            let project = preferences?.projectMatch(hostID: hostID, cwd: session.tab.cwd, projects: projects)
            return session.matches(query, projectName: project?.project.name)
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                connectionCard
                if monitor.snapshot != nil && host != nil {
                    Picker("Session view", selection: $mode) {
                        ForEach(SessionViewMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.vertical, 4)

                    let visible = visible
                    let preferences = preferences
                    let pinned = visible.filter { preferences?.isPinned($0.id) == true }
                    let unpinned = visible.filter { preferences?.isPinned($0.id) != true }
                    if !pinned.isEmpty {
                        sectionHeading("Pinned", count: pinned.count)
                        sessionCards(pinned)
                    }
                    if visible.isEmpty {
                        PhrenEmptyState(title: sessions.isEmpty ? "No sessions running" : "No matching sessions",
                                        message: sessions.isEmpty ? "Open a workspace on this computer to see it here." : "Try a title, project, agent, or folder name.")
                            .frame(maxWidth: .infinity)
                    } else {
                        switch mode {
                        case .workspaces:
                            ForEach(monitor.snapshot?.groups ?? []) { group in
                                let entries = unpinned.filter { $0.workspaceID == group.id }
                                if !entries.isEmpty {
                                    sectionHeading(group.label, count: entries.count)
                                    sessionCards(entries)
                                }
                            }
                        case .activity:
                            ForEach(LiveWorkspaces.Tab.Activity.allCases, id: \.self) { activity in
                                let entries = unpinned.filter { $0.tab.activity == activity }
                                if !entries.isEmpty {
                                    sectionHeading(activity.rawValue, count: entries.count)
                                    sessionCards(entries)
                                }
                            }
                        }
                    }
                }

            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .background(PhrenTheme.bg)
        .navigationTitle(host?.name ?? "Computer removed")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search sessions")
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let host {
                    NavigationLink { WebServersView(hostID: host.id) } label: { Label("Web servers", systemImage: "globe") }
                        .accessibilityIdentifier("host-web-servers")
                    NavigationLink { HerdrWorkspacesView(hostID: host.id) } label: {
                        Label("Herdr workspaces & terminal", systemImage: "terminal")
                    }
                }
                Button("Connection settings", systemImage: "gearshape") { editing = true }.disabled(host == nil)
            }
        }
        .onChange(of: host) { _, _ in
            monitor.snapshot = nil
            monitor.lastUpdated = nil
            monitor.message = nil
            monitor.fingerprint = nil
        }
        .sheet(isPresented: $editing) {
            if let host { NavigationStack { LiveHostEditor(existing: host) } }
        }
        .sheet(item: $selected) { selection in
            LiveSessionDetailView(sessionID: selection.id, monitor: monitor)
        }
        .task(id: PollIdentity(host: host, active: scenePhase == .active && !editing, refresh: refreshID)) {
            guard scenePhase == .active, !editing, let host else { return }
            await monitor.run(host: host)
        }
    }

    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let fresh = monitor.isFresh(at: context.date)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Circle().fill(fresh ? PhrenTheme.cyan : PhrenTheme.textDim).frame(width: 5, height: 5)
                            Text(fresh ? "Live" : monitor.refreshing ? "Connecting…" : "Disconnected")
                            if let date = monitor.lastUpdated {
                                Text("· updated \(date, style: .relative) ago").lineLimit(1)
                            }
                        }
                        if monitor.snapshot != nil {
                            Text(fresh
                                 ? "\(sessions.count) tabs · \(sessions.filter { $0.tab.activity == .working }.count) working · \(sessions.filter { $0.tab.activity == .waiting }.count) waiting"
                                 : "Showing previous status")
                        }
                    }.font(.caption).foregroundStyle(PhrenTheme.textMuted)
                }
                Spacer(minLength: 0)
                Button { refreshID = UUID() } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }.buttonStyle(.plain).foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityLabel("Refresh now").disabled(monitor.refreshing)
            }
            if let message = monitor.message { Text(message).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            if let localError { Text(localError).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            if let fingerprint = monitor.fingerprint, host?.fingerprint == nil {
                Text(fingerprint).font(.caption.monospaced()).textSelection(.enabled)
                Text("Compare this fingerprint with the computer's SSH host key before trusting it. On the computer, run ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub (or the matching ECDSA host key).")
                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                Button("Trust verified fingerprint") { trust(fingerprint) }
            }
        }
        .padding(.horizontal, 4)
        .accessibilityIdentifier("live-connection-status")
    }

    private func sectionHeading(_ title: String, count: Int) -> some View {
        HStack {
            Text(title).font(.subheadline.weight(.semibold))
            Spacer()
            Text("\(count)").font(.caption.monospacedDigit())
        }
        .foregroundStyle(PhrenTheme.textMuted)
        .padding(.horizontal, 4).padding(.top, 6)
        .accessibilityAddTraits(.isHeader)
    }

    private func sessionCards(_ entries: [LiveAgentSession]) -> some View {
        ForEach(entries) { session in
            TimelineView(.periodic(from: .now, by: 1)) { context in
                LiveSessionCard(session: session, fresh: monitor.isFresh(at: context.date)) { selected = session }
            }
        }
    }

    private func trust(_ fingerprint: String) {
        guard var host, host.fingerprint == nil else { return }
        do {
            host.fingerprint = fingerprint
            data = try LiveSessionPreferences.saving(host, in: data)
            monitor.fingerprint = nil
        } catch { localError = error.localizedDescription }
    }

    private struct PollIdentity: Equatable {
        let host: LiveHost?
        let active: Bool
        let refresh: UUID
    }
}

extension LiveHostMonitor {
    func isFresh(at date: Date) -> Bool {
        polling && message == nil && lastUpdated.map { date.timeIntervalSince($0) < 25 } == true
    }
}

private struct SessionStatusIcon: View {
    let activity: LiveWorkspaces.Tab.Activity
    let fresh: Bool
    private var color: Color { fresh ? activity.color : PhrenTheme.textMuted }
    var body: some View {
        Image(systemName: activity.icon)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(color)
            .frame(width: 44, height: 44)
            .background(color.opacity(0.12), in: Circle())
            .overlay(Circle().strokeBorder(color.opacity(0.35), lineWidth: 1))
            .accessibilityHidden(true)
    }
}

private struct LiveSessionCard: View {
    @Environment(AppModel.self) private var model
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    let session: LiveAgentSession
    let fresh: Bool
    var showHost = false
    var onChat: (() -> Void)? = nil
    let onDetails: () -> Void

    var body: some View {
        let preferences = try? LiveSessionPreferences.read(data)
        let project = preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd,
                                                projects: model.sessionProjects)?.project.name
        let subtitle = [showHost ? session.host.name : nil, project ?? session.workspaceName,
                        session.tab.agent, session.tab.status + (fresh ? "" : " · stale")]
            .compactMap { $0 }.joined(separator: " · ")
        let prefix = showHost ? "overview" : "live"
        HStack(spacing: 0) {
            AgentConversationLink(session: session, onOpenInPhren: onChat) {
                SessionCardContent(session: session, fresh: fresh, subtitle: subtitle, identifierPrefix: prefix)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(showHost ? "overview-chat:\(session.accessibilityKey)"
                                     : "live-chat:\(session.workspaceID):\(session.tab.id)")
            .disabled(!fresh)
            SessionPinButton(session: session, pinned: preferences?.isPinned(session.id) == true,
                             identifierPrefix: prefix, data: $data)
            Button(action: onDetails) {
                Image(systemName: "info.circle").font(.system(size: 15))
                    .foregroundStyle(PhrenTheme.textMuted).frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("Session details")
            .accessibilityIdentifier(showHost ? "overview-detail:\(session.accessibilityKey)"
                                     : "live-detail:\(session.workspaceID):\(session.tab.id)")
        }
        .sessionCard()
    }
}

private struct LiveSessionDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var assigning = false
    @State private var copiedFolder = false
    let sessionID: LiveAgentSession.ID
    let monitor: LiveHostMonitor

    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var host: LiveHost? { preferences?.hosts.first { $0.id == sessionID.hostID } }
    private var session: LiveAgentSession? {
        guard let host else { return nil }
        return monitor.snapshot?.sessions(on: host).first { $0.id == sessionID }
    }
    private var match: SessionProjectMatch? {
        preferences?.projectMatch(hostID: sessionID.hostID, cwd: session?.tab.cwd, projects: model.sessionProjects)
    }

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let fresh = monitor.isFresh(at: context.date)
                if let session {
                    PhrenList {
                        Section {
                            VStack(alignment: .leading, spacing: 14) {
                                SessionStatusIcon(activity: session.tab.activity, fresh: fresh)
                                Text(session.tab.displayTitle).font(.title2.weight(.semibold))
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(session.tab.status + (fresh ? "" : " · stale"))
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(fresh ? session.tab.activity.color : PhrenTheme.textMuted)
                                if let date = monitor.lastUpdated {
                                    Text("Last received \(date, style: .relative) ago")
                                        .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                                }
                            }.padding(.vertical, 10)
                        }
                        .listRowBackground(session.tab.activity.color.opacity(0.10))
                        Section {
                            NavigationLink { HerdrTerminalView(host: session.host, session: session) } label: {
                                Label("Herdr terminal", systemImage: "terminal")
                            }.disabled(!fresh)
                            AgentConversationLink(session: session) {
                                Label("Chat with agent", systemImage: "bubble.left.and.bubble.right")
                                    .frame(minHeight: 44)
                            }
                            .accessibilityIdentifier("session-detail-chat")
                            .disabled(!fresh)
                        } footer: {
                            Text(fresh ? "Chat and terminal stay connected to this computer's session."
                                 : "Reconnect this computer to resume its session.")
                        }
                        Section("Project memory") {
                            if let project = match?.project, model.sessionProjects.contains(project) {
                                NavigationLink { ProjectDetailView(storeId: project.storeID, project: project.name) } label: {
                                    Label("Open \(project.name)", systemImage: "folder")
                                }.accessibilityIdentifier("session-detail-project")
                                NavigationLink { GraphView(focusProject: project.name, initialStoreId: project.storeID) } label: {
                                    Label("Explore graph", systemImage: "circle.hexagongrid")
                                }
                                Text(project.storeID).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            } else {
                                Text("Choose a project to connect this session to its findings, tasks, and graph.")
                                    .font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                            }
                            if session.tab.cwd != nil {
                                Button(match == nil ? "Link to project" : "Change project link") { assigning = true }
                            }
                        }
                        Section("Session") {
                            LabeledContent("Computer", value: session.host.name)
                            LabeledContent("Workspace", value: session.workspaceName)
                            LabeledContent("Tab", value: session.tab.label)
                            if let agent = session.tab.agent { LabeledContent("Agent", value: agent) }
                            if let count = session.tab.agentPaneCount, count >= 0 {
                                LabeledContent("Agent panes", value: "\(count)")
                            }
                            if let count = session.tab.paneCount, count >= 0 {
                                LabeledContent("Total panes", value: "\(count)")
                            }
                        }
                        if let cwd = session.tab.cwd {
                            Section("Folder") {
                                Text(cwd).font(.footnote.monospaced()).textSelection(.enabled)
                                Button(copiedFolder ? "Folder copied" : "Copy folder", systemImage: "doc.on.doc") {
                                    UIPasteboard.general.string = cwd
                                    copiedFolder = true
                                }
                            }
                        }
                    }
                } else {
                    PhrenEmptyState(title: "Session no longer available", message: "It was closed or its computer was removed. Return to the list for current sessions.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity).background(PhrenTheme.bg)
                }
            }
            .navigationTitle("Session details")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: ArchiveRoute.self) { route in
                ArchiveBrowserView(storeId: route.storeId, project: route.project)
            }
            .navigationDestination(for: ArchiveTopicRoute.self) { route in
                ArchiveTopicView(storeId: route.storeId, topic: route.topic)
            }
            .onChange(of: session?.tab.cwd) { _, _ in
                copiedFolder = false
                assigning = false
            }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $assigning) {
                NavigationStack {
                    LiveProjectPicker(hostID: sessionID.hostID, cwd: session?.tab.cwd ?? "",
                                      existing: preferences?.mapping(hostID: sessionID.hostID, cwd: session?.tab.cwd))
                }
            }
        }
    }
}

private struct LiveProjectPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var error: String?
    let hostID: UUID
    let cwd: String
    let existing: LiveSessionPreferences.Mapping?

    var body: some View {
        PhrenList {
            Section {
                Text(cwd).font(.caption.monospaced())
                Text("Link this directory and its subdirectories to a project on this iPhone.").foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.orange) }
            }
            ForEach(model.storeDescriptors) { store in
                Section(store.id) {
                    ForEach(model.snapshot(for: store.id).projects.filter { $0.name != "global" }, id: \.name) { project in
                        Button(project.name) { assign(storeID: store.id, project: project.name, directory: cwd) }
                            .accessibilityIdentifier("live-project:\(store.id):\(project.name)")
                    }
                }
            }
            if let existing {
                Button("Remove directory link", role: .destructive) {
                    assign(storeID: nil, project: nil, directory: existing.directory)
                }
            }
        }
        .navigationTitle("Link project")
        .toolbar { Button("Cancel") { dismiss() } }
        .phrenScreen()
    }
    private func assign(storeID: String?, project: String?, directory: String) {
        do {
            data = try LiveSessionPreferences.assigning(hostID: hostID, directory: directory,
                                                       storeID: storeID, project: project, in: data)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
