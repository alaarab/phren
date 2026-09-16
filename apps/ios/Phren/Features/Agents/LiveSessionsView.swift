import PhrenKit
import PhrenLive
import SwiftUI

struct LiveSessionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var adding = false
    @State private var lastRefreshID = UUID()
    @State private var query = ""
    @State private var refreshID = UUID()
    private var overview: SessionOverviewMonitor { .shared }
    @State private var selected: OverviewSelection?
    @State private var sessionOpen: SessionOpen?
    @State private var closeRequest: SessionCloseRequest?
    @State private var closeError: String?
    @State private var focusFilter = AgentFocusFilterStore.load()
    private struct SessionOpen: Identifiable, Hashable {
        let session: LiveAgentSession
        let destination: AgentLaunch.Destination
        var draft = ""
        var attachments: [AgentAttachment] = []
        var id: String { "\(session.id.hostID)|\(session.id.muxID)|\(session.id.workspace)|\(session.id.tab)|\(destination.rawValue)" }
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id && lhs.draft == rhs.draft && lhs.attachments.count == rhs.attachments.count }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }

    private struct OverviewSelection: Identifiable, Hashable {
        let session: LiveAgentSession
        let monitor: LiveHostMonitor
        var id: LiveAgentSession.ID { session.id }
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id && lhs.monitor === rhs.monitor }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
    private struct PollID: Equatable { let hosts: [LiveHost]; let active: Bool; let refresh: UUID }
    private var configuration: SessionOverviewMonitor.Configuration {
        .init(query: query, preferences: preferences, projects: model.sessionProjects, focusFilter: focusFilter,
              metadataReady: model.phase != .loading && model.phase != .initialSync, memoryConnected: model.phase == .ready)
    }

    var body: some View {
        let screen = overview.screen
        Group {
            if !hosts.isEmpty && !overview.ready {
                ProgressView().tint(PhrenTheme.cyan)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(PhrenTheme.bg).accessibilityLabel("Loading sessions")
                    .accessibilityIdentifier("agents-loading")
                    .transition(.opacity)
            } else {
            PhrenList(plain: true) {
                sessionSections(screen)
                Section {
                    if screen.preferencesReadable {
                        ForEach(screen.computers) { computer in
                            NavigationLink { LiveHostView(hostID: computer.id) } label: {
                                PhrenMenuRow(title: computer.host.name, subtitle: computer.connecting ? "Connecting…" : computer.host.address, icon: "desktopcomputer")
                            }
                            .accessibilityIdentifier("live-host:\(computer.id)")
                            .plainListCardRow()
                        }
                        Button("Add computer", systemImage: "plus") { adding = true }
                            .plainListCardRow()
                    } else {
                        Text("Saved connections couldn't be read. They have been preserved; update phren before editing them.")
                            .foregroundStyle(.orange).plainListCardRow()
                    }
                } header: {
                    Text("Computers").plainListSectionLabel()
                } footer: {
                    Text("Keep Tailscale connected on both devices when you're away. Phren Hook connects your existing agents.")
                        .font(.caption).foregroundStyle(PhrenTheme.textMuted).padding(.horizontal, 14).padding(.top, 4)
                        .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                }
                Section {
                    if screen.memoryConnected {
                    NavigationLink { SkillsView() } label: {
                        PhrenMenuRow(title: "Skills", icon: "wand.and.stars", color: PhrenTheme.lavender)
                    }.plainListCardRow()
                    NavigationLink { AgentsView() } label: {
                        PhrenMenuRow(title: "Agent instructions", icon: "person.crop.rectangle.stack")
                    }.plainListCardRow()
                    } else {
                        Button {
                            model.showingMemoryConnection = true
                        } label: {
                            Label("Connect memory for skills & instructions", systemImage: "brain")
                        }.plainListCardRow()
                    }
                } header: { Text("Agent setup").plainListSectionLabel() }
            }
            .listSectionSpacing(6)
            .modifier(SessionCloseDialogs(request: $closeRequest, error: $closeError,
                                          monitor: { session in overview.computers.first { $0.id == session.host.id }?.monitor }))
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: overview.ready)
        .onChange(of: configuration, initial: true) { _, value in overview.configure(value) }
        .navigationTitle("Live sessions")
        // Keep the title in the navigation bar rather than the collapsible
        // large-title region when this list is hosted directly by a tab.
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search all sessions")
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .phrenScreen()
        .toolbar {
            AccountUsageRings(hosts: hosts)
            // Settings → Show on Agents chooses these.
            if IntegrationSettings.enabled(IntegrationSettings.showWebServersKey) {
                NavigationLink { WebServersView() } label: { Label("Web servers", systemImage: "globe") }
                    .accessibilityIdentifier("all-web-servers")
            }
            if IntegrationSettings.enabled(IntegrationSettings.showSimulatorsKey) {
                NavigationLink { SimulatorsView() } label: { Label("Simulators", systemImage: "iphone") }
                    .accessibilityIdentifier("all-simulators")
            }
            if IntegrationSettings.enabled(IntegrationSettings.showFilesKey) {
                NavigationLink { HostFilesView() } label: { Label("Files", systemImage: "folder") }
                    .accessibilityIdentifier("all-files")
            }
            Button("Refresh all sessions", systemImage: "arrow.clockwise") { refreshID = UUID() }
        }
        .onAppear { if IntegrationSettings.enabled(IntegrationSettings.agentsKeepScreenOnKey, default: false) { UIApplication.shared.isIdleTimerDisabled = true } }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .task(id: scenePhase) {
            if scenePhase == .active { focusFilter = await AgentFocusFilterStore.refreshFromSystem() }
        }
        .onReceive(NotificationCenter.default.publisher(for: AgentFocusFilterStore.changed)) { _ in
            focusFilter = AgentFocusFilterStore.load()
        }
        .refreshable { refreshID = UUID() }
        .sheet(isPresented: $adding) { NavigationStack { LiveHostEditor() } }
        .navigationDestination(item: $selected) { selection in
            LiveSessionDetailView(sessionID: selection.id, monitor: selection.monitor)
        }
        .navigationDestination(item: $sessionOpen) { open in
            switch open.destination {
            case .chat, .dictate:
                AgentChatSheet(session: open.session, attachments: open.attachments, draft: open.draft,
                               startsDictation: open.destination == .dictate).id(open.id)
            case .terminal: HerdrTerminalView(host: open.session.host, session: open.session).id(open.id)
            }
        }
        // Siri and Spotlight leave an exact session and destination here.
        .onChange(of: model.pendingChatVersion, initial: true) { _, _ in
            if let pending = AgentLaunch.takePendingOpen() {
                selected = nil
                let content = AgentLaunch.takePendingContent(for: pending.session)
                sessionOpen = SessionOpen(session: pending.session, destination: pending.destination,
                                          draft: content.draft, attachments: content.attachments)
            }
        }
        // The poll is a task this view owns, not a `.task` modifier: SwiftUI
        // cancels those when a pushed screen covers the list, which froze the
        // sessions behind an open chat. It runs while the app is active and
        // this list has appeared at least once; only leaving the foreground,
        // changing computers, or editing them restarts it.
        .onChange(of: PollID(hosts: hosts, active: scenePhase == .active && !adding, refresh: refreshID), initial: true) { _, id in
            guard id.active else { overview.stopRunning(); return }
            overview.configure(configuration)
            let currentHosts = hosts
            Task {
                await Task.yield()
                SpotlightIndex.shared.reconcileHosts(currentHosts)
                await WidgetBridge.reconcileSessionHosts(currentHosts)
            }
            // A manual refresh restarts the run; otherwise keep the one that's going.
            if id.refresh != lastRefreshID { lastRefreshID = id.refresh; overview.stopRunning() }
            overview.ensureRunning(hosts: currentHosts)
        }
        // Once the sessions are known, Siri can name them ("message phren on mini in phren").
        .onChange(of: overview.ready, initial: true) { _, ready in
            guard ready else { return }
            PhrenAppShortcuts.donateSessions(overview.computers.flatMap { computer in computer.monitor.snapshot?.sessions(on: computer.host) ?? [] })
        }
    }

    /// Only what needs saying above the sessions: the hint when there is no
    /// computer yet, a Focus filter when one is on. The connected count lives
    /// in the Computers section; the sections say the rest.
    @ViewBuilder
    private func caption(_ screen: SessionOverviewMonitor.Screen) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if screen.computers.isEmpty {
                Text("Connect a computer to see its sessions here.")
                    .accessibilityIdentifier("agents-introduction")
            }
            if let focusFilter = screen.focusFilter {
                HStack(spacing: 5) {
                    Text("Filtered by Focus · \(focusFilter.label)").accessibilityIdentifier("agents-focus-filter")
                    Button("Clear Focus filter", systemImage: "xmark.circle.fill") {
                        AgentFocusFilterStore.save(nil); self.focusFilter = nil
                    }.labelStyle(.iconOnly).accessibilityIdentifier("agents-focus-clear")
                }
            }
        }.font(.caption).foregroundStyle(PhrenTheme.textMuted).textCase(nil)
    }

    @ViewBuilder
    private func sessionSections(_ screen: SessionOverviewMonitor.Screen) -> some View {
        let groups = screen.groups
        if groups.isEmpty {
            Section {
                if screen.computers.isEmpty {
                    // Nothing to report yet; the caption header says what to do.
                } else if screen.computers.contains(where: \.connecting) {
                    HStack { ProgressView(); Text("Finding sessions…") }.font(.subheadline)
                } else {
                    Text(!screen.query.isEmpty ? "No matching sessions"
                         : screen.connectedCount == 0 && screen.computers.contains(where: { $0.message != nil })
                         ? "No computers connected" : "No sessions running on the connected computers")
                        .font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                }
            } header: { caption(screen) }
        }
        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
            Section {
                ForEach(group.sessions) { session in
                        LiveSessionCard(session: session, fresh: screen.computers.first { $0.id == session.host.id }?.fresh == true,
                                        showHost: true, resolvedProject: screen.projects[session.id], resolvedPin: screen.pinned.contains(session.id),
                                        onChat: { sessionOpen = SessionOpen(session: session, destination: .chat) }, onDetails: {
                            if let computer = overview.computers.first(where: { $0.id == session.host.id }) {
                                selected = OverviewSelection(session: session, monitor: computer.monitor)
                            }
                        }, onClose: { request, confirm in
                            if confirm { closeRequest = request }
                            else { SessionCloseDialogs.perform(request, monitor: overview.computers.first { $0.id == request.session.host.id }?.monitor) { closeError = $0 } }
                        })
                        .equatable().separatedSessionRow()
                }
            } header: {
                VStack(alignment: .leading, spacing: 6) {
                    if index == 0 { caption(screen) }
                    // Small, quiet, upper-case — the section label Moshi uses.
                    Text("\(group.title) · \(group.sessions.count)")
                        .font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted).textCase(.uppercase).tracking(0.6)
                        .padding(.leading, 14).padding(.top, 2)
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 2, trailing: 0))
            }
            footer: {
                if group.id == "previous" { Text("These computers aren't connected. Reconnect before opening a session.") }
            }
        }
        let problems = screen.computers.filter { $0.message != nil }
        if !problems.isEmpty {
            Section("Connections") {
                ForEach(problems) { computer in
                    NavigationLink { LiveHostView(hostID: computer.id) } label: {
                        HStack {
                            Text(computer.host.name)
                            Spacer()
                            Text(computer.needsVerification ? "Verify connection" : "Offline")
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
    @ObservationIgnored private var refreshRequested = false
    @ObservationIgnored private let fetchSnapshot: (LiveHost, Date?) async throws -> LiveWorkspaces
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored var onSnapshotChanged: (() -> Void)?
    @ObservationIgnored private var publishing: Task<Void, Never>?

    /// Fetch again now rather than at the end of the poll interval — after a
    /// close, a launch, anything the person just did to the computer.
    func refreshNow() { refreshRequested = true }

    /// For a screen pushed over the list: take over polling as soon as the
    /// list's own task is cancelled (that happens after this screen appears),
    /// and keep going until this screen leaves.
    func keepRunning(host: LiveHost) async {
        while !Task.isCancelled {
            if polling {
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            } else {
                await run(host: host)
            }
        }
    }

    /// Herdr confirmed a close: drop the tab (or workspace) from the snapshot
    /// at once, then fetch so the truth replaces the guess.
    func closed(workspace: String, tab: String?) {
        snapshot = snapshot?.closing(workspace: workspace, tab: tab)
        onSnapshotChanged?()
        refreshNow()
    }

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
                // UI publication must not wait for Spotlight/WidgetKit disk
                // writes or ActivityKit. Coalesce obsolete side effects.
                publishing?.cancel()
                publishing = Task {
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    let sessions = value.sessions(on: host)
                    SpotlightIndex.shared.refreshSessions(sessions, on: host)
                    await WidgetBridge.publishSessions(sessions, on: host)
                }
            } catch {
                guard !Task.isCancelled, generation == run else { return }
                message = (error as? LiveConnectionError)?.localizedDescription
                    ?? (error as? PhrenKitError)?.localizedDescription
                    ?? "Couldn't reach the computer. Check the address, Tailscale, SSH, and Phren Hook."
                if case LiveConnectionError.untrustedHost(let key) = error { fingerprint = key }
                #if DEBUG && targetEnvironment(simulator)
                if AppRuntime.isUITesting && ProcessInfo.processInfo.arguments.contains("--all-sessions-offline") {
                    lastUpdated = .now.addingTimeInterval(-91)
                }
                #endif
            }
            refreshing = false
            if first { first = false; onFirstRefresh?() }
            onSnapshotChanged?()
            if fingerprint != nil { return }
            // Sleep in slices so refreshNow() cuts the wait short.
            refreshRequested = false
            let slices = max(1, Int(pollInterval / .milliseconds(250)))
            for _ in 0..<slices where !refreshRequested {
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            }
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
            let changed = ProcessInfo.processInfo.arguments.contains("--session-relative-time-fixture")
                ? ",\"lastChangedAt\":\"\(UITestFixtures.sessionActivityDate.ISO8601Format())\"" : ""
            let closed = await UITestFixtures.closedTabs
            let tabs = [
                #"{"id":"w1:t1","label":"1","title":"\#(title)","agent":"codex","agentStatus":"\#(status)","cwd":"/work/phone","branch":"main","contextUsedPercent":\#(remote ? 62 : 37)\#(changed)}"#,
                #"{"id":"w1:t2","label":"2","title":"\#(other)","agent":"claude","agentStatus":"idle","cwd":"/work/phone","branch":"feature/settings"}"#,
            ].enumerated().filter { !closed.contains("\(host.id):w1:t\($0.offset + 1)") }.map(\.element)
            return try LiveWorkspaces.read(Data("""
            {"kind":"herdr","groups":[{"id":"w1","label":"Shared project","children":[\(tabs.joined(separator: ","))]}]}
            """.utf8))
        }
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--automatic-sessions-fixture") {
            if ProcessInfo.processInfo.arguments.contains("--session-discovery-offline") { throw LiveConnectionError.disconnected }
            if ProcessInfo.processInfo.arguments.contains("--session-details-fixture") {
                if previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--session-details-removed") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[]}"#.utf8))
                }
                if ProcessInfo.processInfo.arguments.contains("--starting-session-fixture") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"New session","agent":"codex","agentStatus":"idle","starting":true,"cwd":"/work/phone","agentPaneCount":1,"paneCount":1}]}]}"#.utf8))
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
    @State private var closeRequest: SessionCloseRequest?
    @State private var closeError: String?
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
        .modifier(SessionCloseDialogs(request: $closeRequest, error: $closeError, monitor: { _ in monitor }))
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
                    NavigationLink { SimulatorsView(hostID: host.id) } label: { Label("Simulators", systemImage: "iphone") }
                        .accessibilityIdentifier("host-simulators")
                    NavigationLink { HostFilesView(hostID: host.id) } label: { Label("Files", systemImage: "folder") }
                        .accessibilityIdentifier("host-files")
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
        .navigationDestination(item: $selected) { selection in
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
                LiveSessionCard(session: session, fresh: monitor.isFresh(at: context.date), onDetails: { selected = session }, onClose: { request, confirm in
                    if confirm { closeRequest = request } else { SessionCloseDialogs.perform(request, monitor: monitor) { closeError = $0 } }
                })
                .equatable().separatedSessionRow()
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
        lastUpdated.map { date.timeIntervalSince($0) < 90 } == true
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

/// A close asked for from a card, answered by the list that owns the dialog.
struct SessionCloseRequest: Identifiable {
    enum Scope { case tab, workspace }
    let session: LiveAgentSession
    let scope: Scope
    var id: String { "\(session.id.hostID):\(session.workspaceID):\(scope == .tab ? session.tab.id : "*")" }
}

/// The one confirmation dialog for closing sessions from a list, plus the
/// error alert. On Herdr's confirmation the card leaves at once and the
/// computer is asked again right away.
private struct SessionCloseDialogs: ViewModifier {
    @Binding var request: SessionCloseRequest?
    @Binding var error: String?
    let monitor: (LiveAgentSession) -> LiveHostMonitor?

    /// Close on the computer, then take the card out of the list at once and
    /// ask that computer again so the truth replaces the guess.
    static func perform(_ what: SessionCloseRequest, monitor: LiveHostMonitor?, failed: @escaping (String) -> Void) {
        let session = what.session, tab = what.scope == .tab ? session.tab.id : nil
        Task { @MainActor in
            do {
                #if DEBUG && targetEnvironment(simulator)
                if AppModel.isUITesting {
                    for id in tab.map({ [$0] }) ?? ["w1:t1", "w1:t2"] { UITestFixtures.closedTabs.insert("\(session.host.id):\(id)") }
                } else {
                    try await PhrenConnection.herdrAction(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), operation: .close,
                                                         workspaceID: session.workspaceID, tabID: tab)
                }
                #else
                try await PhrenConnection.herdrAction(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), operation: .close,
                                                     workspaceID: session.workspaceID, tabID: tab)
                #endif
                withAnimation { monitor?.closed(workspace: session.workspaceID, tab: tab) }
            } catch let failure { failed(failure.localizedDescription) }
        }
    }

    func body(content: Content) -> some View {
        content
            .confirmationDialog(request?.scope == .workspace ? "Close the whole workspace?" : "Close this tab?",
                                isPresented: $request.isPresent(), titleVisibility: .visible, presenting: request) { what in
                Button(what.scope == .workspace ? "Close workspace" : "Close tab", role: .destructive) {
                    Self.perform(what, monitor: monitor(what.session)) { error = $0 }
                }
            } message: { what in
                Text(what.scope == .workspace
                     ? "Every tab in \u{201C}\(what.session.workspaceName)\u{201D} on \(what.session.host.name) closes; running agents in them stop."
                     : "\u{201C}\(what.session.tab.displayTitle)\u{201D} on \(what.session.host.name) closes; an agent running in it stops.")
            }
            .alert("Couldn't close", isPresented: $error.isPresent()) { Button("OK") { error = nil } } message: { Text(error ?? "") }
    }
}

private struct LiveSessionCard: View, Equatable {
    @Environment(AppModel.self) private var model
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    let session: LiveAgentSession
    let fresh: Bool
    var showHost = false
    var resolvedProject: String? = nil
    var resolvedPin: Bool? = nil
    var onChat: (() -> Void)? = nil
    let onDetails: () -> Void
    /// The swipe's red Close acts at once, the way Mail's does — the person
    /// already swiped and hit a red button. Hold → Close tab / Close
    /// workspace confirm first, through the one dialog the list owns: a dialog
    /// per row inside a list that re-renders every second presented for the
    /// wrong row, and deleting a row after its swipe action ran under a dialog
    /// tripped UIKit's batch-update check.
    let onClose: (SessionCloseRequest, _ confirm: Bool) -> Void
    @State private var assigningProject = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.session == rhs.session && lhs.fresh == rhs.fresh && lhs.showHost == rhs.showHost
            && lhs.resolvedProject == rhs.resolvedProject && lhs.resolvedPin == rhs.resolvedPin
    }

    var body: some View {
        let preferences = try? LiveSessionPreferences.read(data)
        let project = showHost ? resolvedProject : preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd,
                                                projects: model.sessionProjects)?.project.name
        let prefix = showHost ? "overview" : "live"
        HStack(spacing: 0) {
            AgentConversationLink(session: session, onOpenInPhren: onChat) {
                SessionCardContent(session: session, fresh: fresh, project: project,
                                   computer: showHost ? session.host.name : nil, identifierPrefix: prefix, onDetails: onDetails)
                    .equatable()
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(showHost ? "overview-chat:\(session.accessibilityKey)"
                                     : "live-chat:\(session.workspaceID):\(session.tab.id)")
            .disabled(!fresh)
            SessionPinButton(session: session, pinned: resolvedPin ?? (preferences?.isPinned(session.id) == true),
                             identifierPrefix: prefix, data: $data)
        }
        .sessionCard()
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Close", systemImage: "xmark", role: .destructive) { onClose(.init(session: session, scope: .tab), false) }
                .accessibilityIdentifier("\(prefix)-close:\(session.accessibilityKey)")
        }
        .contextMenu {
            if project == nil, session.tab.cwd != nil {
                Button("Link to project", systemImage: "link") { assigningProject = true }
            }
            Button("Close tab", systemImage: "xmark", role: .destructive) { onClose(.init(session: session, scope: .tab), true) }
            Button("Close workspace \u{201C}\(session.workspaceName)\u{201D}", systemImage: "xmark.square", role: .destructive) { onClose(.init(session: session, scope: .workspace), true) }
        }
        .sheet(isPresented: $assigningProject) {
            NavigationStack { LiveProjectPicker(hostID: session.host.id, cwd: session.tab.cwd ?? "",
                                                existing: preferences?.mapping(hostID: session.host.id, cwd: session.tab.cwd)) }
        }
    }
}

private struct LiveSessionDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var assigning = false
    @State private var copiedFolder = false
    @State private var closingSession = false
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
        TimelineView(.periodic(from: .now, by: 1)) { context in
                let fresh = monitor.isFresh(at: context.date)
                if let session {
                    let project = match?.project
                    ScrollView {
                        VStack(spacing: 14) {
                            // The hero: who is running, what it is doing, in its state's tint.
                            VStack(spacing: 12) {
                                AgentProviderGlyph(source: session.tab.agent, size: 44)
                                    .frame(width: 88, height: 88)
                                    .background(session.tab.activity.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                                Text(session.tab.displayTitle).font(.title2.weight(.bold)).multilineTextAlignment(.center)
                                    .fixedSize(horizontal: false, vertical: true)
                                HStack(spacing: 6) {
                                    if project == nil { Image(systemName: "folder").foregroundStyle(PhrenTheme.textMuted) }
                                    Text(session.projectDisplayName(project?.name)).font(.system(.subheadline, design: .monospaced)).foregroundStyle(project == nil ? PhrenTheme.textMuted : PhrenTheme.success)
                                    if let branch = session.tab.branch, !branch.isEmpty {
                                        Text("·").foregroundStyle(PhrenTheme.textDim)
                                        Label(branch, systemImage: "arrow.triangle.branch").font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral)
                                    }
                                    Text("·").foregroundStyle(PhrenTheme.textDim)
                                    Text(session.host.name).font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                                    if let date = session.tab.lastChangedAt {
                                        SessionRelativeTimeLabel(changedAt: date)
                                    }
                                }.lineLimit(1).minimumScaleFactor(0.8)
                                Text((session.tab.status + (fresh ? "" : " · stale")).uppercased())
                                    .font(.caption.weight(.bold)).tracking(1.2)
                                    .foregroundStyle(fresh ? session.tab.activity.color : PhrenTheme.textMuted)
                                    .padding(.horizontal, 14).padding(.vertical, 6)
                                    .background((fresh ? session.tab.activity.color : PhrenTheme.textMuted).opacity(0.14), in: Capsule())
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 28).padding(.horizontal, 20)
                            .background(session.tab.activity.color.opacity(fresh ? 0.08 : 0.03), in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large, style: .continuous))

                            // The two ways in.
                            AgentConversationLink(session: session) {
                                Label("Chat with agent", systemImage: "bubble.left.and.bubble.right").font(.body.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 54)
                                    .background(PhrenTheme.accent.opacity(0.9), in: Capsule()).foregroundStyle(.black)
                            }
                            .buttonStyle(.plain).disabled(!fresh).accessibilityIdentifier("session-detail-chat")
                            NavigationLink { HerdrTerminalView(host: session.host, session: session) } label: {
                                Label("Open terminal", systemImage: "terminal").font(.body.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 54)
                                    .background(PhrenTheme.surface, in: Capsule()).foregroundStyle(PhrenTheme.text)
                            }
                            .buttonStyle(.plain).disabled(!fresh)
                            if !fresh { Text("Reconnect this computer to resume its session.").font(.caption).foregroundStyle(PhrenTheme.textMuted) }

                            SessionAwaySummaryCard(
                                session: session,
                                project: session.projectDisplayName(project?.name),
                                state: session.tab.activity.rawValue
                            )

                            SessionUsageCard(host: session.host, source: session.tab.agent)

                            // The facts, one per row.
                            VStack(spacing: 0) {
                                factRow("Computer", session.host.name)
                                if let agent = session.tab.agent { factRow("Agent", agent.capitalized) }
                                factRow("Workspace", session.workspaceName)
                                factRow("Tab", session.tab.label)
                                if let count = session.tab.agentPaneCount, count >= 0 { factRow("Agent panes", "\(count)") }
                                if let count = session.tab.paneCount, count >= 0 { factRow("Total panes", "\(count)") }
                                if let cwd = session.tab.cwd {
                                    factRow("Folder", cwd, monospaced: true, copy: { UIPasteboard.general.string = cwd; copiedFolder = true }, copied: copiedFolder)
                                        .accessibilityIdentifier("session-detail-folder")
                                }
                                if let project {
                                    NavigationLink { ProjectDetailView(storeId: project.storeID, project: project.name) } label: {
                                        factRow("Project memory", project.name, chevron: true)
                                    }.buttonStyle(.plain).accessibilityIdentifier("session-detail-project")
                                } else if session.tab.cwd != nil {
                                    Button { assigning = true } label: { factRow("Project memory", "Link to a project", chevron: true) }
                                        .buttonStyle(.plain).accessibilityLabel("Link to project")
                                }
                            }
                            .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                            if let project, model.sessionProjects.contains(project) {
                                HStack(spacing: 10) {
                                    NavigationLink { GraphView(focusProject: project.name, initialStoreId: project.storeID) } label: {
                                        Label("Graph", systemImage: "circle.hexagongrid").frame(maxWidth: .infinity, minHeight: 44)
                                            .background(PhrenTheme.surface, in: Capsule())
                                    }.buttonStyle(.plain).accessibilityLabel("Explore graph")
                                    if session.tab.cwd != nil {
                                        Button { assigning = true } label: {
                                            Label("Change project", systemImage: "link").frame(maxWidth: .infinity, minHeight: 44)
                                                .background(PhrenTheme.surface, in: Capsule())
                                        }.buttonStyle(.plain).accessibilityLabel("Change project link")
                                    }
                                }.font(.subheadline).foregroundStyle(PhrenTheme.text)
                            }

                            Button(role: .destructive) { closingSession = true } label: {
                                Text("Close session").font(.body.weight(.medium)).frame(maxWidth: .infinity, minHeight: 48)
                            }
                            .foregroundStyle(PhrenTheme.danger).padding(.top, 6)
                            .accessibilityIdentifier("session-detail-close")
                        }
                        .padding(16)
                    }
                    .background(PhrenTheme.bg)
                    .confirmationDialog("Close this session?", isPresented: $closingSession, titleVisibility: .visible) {
                        Button("Close tab", role: .destructive) {
                            Task {
                                try? await PhrenConnection.herdrAction(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), operation: .close, workspaceID: session.workspaceID, tabID: session.tab.id)
                                dismiss()
                            }
                        }
                    } message: { Text("\u{201C}\(session.tab.displayTitle)\u{201D} on \(session.host.name) closes; an agent running in it stops.") }
                } else {
                    PhrenEmptyState(title: "Session no longer available", message: "It was closed or its computer was removed. Return to the list for current sessions.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity).background(PhrenTheme.bg)
                }
            }
            .navigationTitle("Session details")
            .navigationBarTitleDisplayMode(.inline)
            // Pushed over the list, this page is what's on screen, and SwiftUI
            // cancels the list's polling task when it disappears. Keep the
            // computer's monitor running from here; the list picks it back up
            // when it reappears.
            .task(id: host) {
                guard let host else { return }
                await monitor.keepRunning(host: host)
            }
            .onChange(of: session?.tab.cwd) { _, _ in
                copiedFolder = false
                assigning = false
            }
            .sheet(isPresented: $assigning) {
                NavigationStack {
                    LiveProjectPicker(hostID: sessionID.hostID, cwd: session?.tab.cwd ?? "",
                                      existing: preferences?.mapping(hostID: sessionID.hostID, cwd: session?.tab.cwd))
                }
            }
    }
}

struct LiveProjectPicker: View {
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

/// A key on the left, its value on the right — the plain rows the details
/// sheet is made of.
private func factRow(_ key: String, _ value: String, monospaced: Bool = false, chevron: Bool = false,
                     copy: (() -> Void)? = nil, copied: Bool = false) -> some View {
    HStack(spacing: 10) {
        Text(key).foregroundStyle(PhrenTheme.textMuted)
        Spacer(minLength: 12)
        Text(value).foregroundStyle(PhrenTheme.text).lineLimit(1).truncationMode(.middle)
            .font(monospaced ? .system(.subheadline, design: .monospaced) : .body)
        if let copy {
            Button { copy() } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc").foregroundStyle(copied ? PhrenTheme.success : PhrenTheme.textMuted).frame(width: 32, height: 32) }
                .buttonStyle(.plain).accessibilityLabel(copied ? "Folder copied" : "Copy folder")
        }
        if chevron { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textDim) }
    }
    .font(.body).padding(.horizontal, 16).frame(minHeight: 50)
    .overlay(alignment: .bottom) { Rectangle().fill(PhrenTheme.border).frame(height: 0.5).padding(.leading, 16) }
    .contentShape(Rectangle())
    .accessibilityElement(children: copy == nil ? .combine : .contain)
    .accessibilityLabel(copy == nil ? "\(key), \(value)" : key)
}

/// This computer's account limits for the session's harness, as bars.
private struct SessionUsageCard: View {
    let host: LiveHost
    let source: String?
    private let cache = AccountUsageCache.shared
    var body: some View {
        Group {
            if let account = cache.snapshot(for: host)?.accounts.first(where: { $0.source == source }), !account.windows.isEmpty {
                VStack(spacing: 10) {
                    HStack { Text("Account").foregroundStyle(PhrenTheme.textMuted); Spacer(); Text(account.source.capitalized).foregroundStyle(PhrenTheme.text) }
                    ForEach(account.windows) { window in
                        HStack(spacing: 12) {
                            Text(Self.short(window.name)).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted).frame(width: 40, alignment: .leading)
                            GeometryReader { geometry in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(PhrenTheme.surfaceRaised)
                                    Capsule().fill(window.usedPercent >= 90 ? PhrenTheme.warning : PhrenTheme.success)
                                        .frame(width: max(8, geometry.size.width * min(1, window.usedPercent / 100)))
                                }
                            }.frame(height: 8)
                            Text("\(Int(window.usedPercent.rounded()))%").font(.caption).monospacedDigit().foregroundStyle(PhrenTheme.textSecondary).frame(width: 36, alignment: .trailing)
                            Text(window.resetDate.map { Self.until($0) } ?? "").font(.caption).monospacedDigit().foregroundStyle(PhrenTheme.textMuted).frame(width: 60, alignment: .trailing)
                        }
                    }
                }
                .padding(16).background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
        .task {
            _ = try? await cache.refresh(host)
        }
    }
    private static func short(_ name: String) -> String {
        let lower = name.lowercased()
        if lower.contains("5") { return "5h" }
        if lower.contains("7") { return "7d" }
        return String(name.split(separator: " ").first ?? "").capitalized
    }
    private static func until(_ date: Date) -> String {
        let seconds = max(0, date.timeIntervalSinceNow)
        let days = Int(seconds / 86_400), hours = Int(seconds.truncatingRemainder(dividingBy: 86_400) / 3_600), minutes = Int(seconds.truncatingRemainder(dividingBy: 3_600) / 60)
        return days > 0 ? "\(days)d \(hours)h" : "\(hours)h \(minutes)m"
    }
}
