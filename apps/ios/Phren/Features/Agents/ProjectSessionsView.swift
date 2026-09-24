import PhrenKit
import PhrenLive
import SwiftUI

extension AppModel {
    /// Session matching includes every attached store, independent of list filters.
    var sessionProjects: [SessionProject] {
        storeDescriptors.flatMap { store in
            snapshot(for: store.id).projects.filter { $0.name != "global" }
                .map { SessionProject(storeID: store.id, name: $0.name) }
        }
    }
}

/// The project's candidate sessions, read from the shared overview rather than
/// fetched again: the overview already keeps every computer's snapshot live
/// (over the Hook's overview stream, or its poll where a Hook predates it).
@MainActor
private struct ProjectSessionDiscovery {
    var sessions: [LiveAgentSession] = []
    var problems: [String] = []
    var refreshing = false
    /// The newest answer from any of the computers.
    var updated: Date?
    private var fresh: Set<UUID> = []

    init(hosts: [LiveHost], overview: SessionOverviewMonitor) {
        var found: [LiveAgentSession] = []
        var failures: [String] = []
        for host in hosts {
            guard host.fingerprint != nil else {
                failures.append("\(host.name): finish verifying the computer in Agents.")
                continue
            }
            guard let monitor = overview.computers.first(where: { $0.host == host })?.monitor else {
                refreshing = true
                continue
            }
            if let message = monitor.message {
                failures.append("\(host.name): \(message)")
            } else if let snapshot = monitor.snapshot {
                found += snapshot.sessions(on: host)
            }
            if monitor.snapshot == nil && monitor.message == nil { refreshing = true }
            if monitor.fresh { fresh.insert(host.id) }
            if let date = monitor.lastUpdated, updated.map({ date > $0 }) ?? true { updated = date }
        }
        sessions = found.sorted { ($0.host.name, $0.workspaceName, $0.tab.label, $0.tab.id) < ($1.host.name, $1.workspaceName, $1.tab.label, $1.tab.id) }
        problems = failures.sorted()
    }

    func isFresh(_ session: LiveAgentSession) -> Bool { fresh.contains(session.host.id) }
}

/// Opened by an explicit request to resume a project's session. Resolve once
/// before opening the native chat or terminal on that exact computer.
struct ProjectSessionsView: View {
    let storeID: String
    let project: String
    var openChat = false
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveSessionPreferences) private var livePreferences
    private var discovery: ProjectSessionDiscovery {
        ProjectSessionDiscovery(hosts: preferences?.hosts ?? [], overview: .shared)
    }
    @State private var visible = false
    @State private var refreshID = UUID()
    @State private var error: String?
    @State private var chatSession: LiveAgentSession?
    @State private var terminalSession: LiveAgentSession?
    @State private var launching = false
    @State private var launchingWorktree: WorktreeLaunchRequest?
    @State private var agentChoice: ProjectAgentChoice?

    private var preferences: LiveSessionPreferences? { livePreferences.preferences }
    private var target: SessionProject { SessionProject(storeID: storeID, name: project) }
    private var matches: [LiveAgentSession] {
        let preferences = preferences
        let projects = model.sessionProjects
        return discovery.sessions.filter {
            preferences?.projectMatch(hostID: $0.host.id, cwd: $0.tab.cwd, projects: projects)?.project == target
        }
    }

    var body: some View {
        PhrenList {
                ProjectComputerRows(storeID: storeID, project: project, showsWorkspaces: true, choice: $agentChoice)
                Section {
                    Text("\(project) · \(storeID)").font(.caption).foregroundStyle(.secondary)
                    if discovery.refreshing { ProgressView("Finding project sessions…") }
                    if preferences == nil {
                        Text("Saved connections couldn't be read. They have been preserved.").foregroundStyle(.orange)
                    } else if preferences?.hosts.isEmpty == true {
                        Text("Connect your computer once in Agents. Phren can then find this project's sessions for you.")
                    } else if discovery.updated != nil {
                        Text(matches.isEmpty ? "No session matched this project's directory. You can choose one below."
                             : matches.count == 1 ? "Found this project's session."
                             : "Several sessions are working in this project. Choose the one you want.")
                    }
                    ForEach(discovery.problems, id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
                    Button("Open on a computer…", systemImage: "desktopcomputer.and.arrow.down") { launching = true }
                        .accessibilityIdentifier("sessions-open-on-computer")
                    Button("New session in a worktree", systemImage: "arrow.branch") {
                        launchingWorktree = WorktreeLaunchRequest(storeID: storeID, project: project)
                    }
                    .accessibilityIdentifier("sessions-open-in-worktree")
                    NavigationLink("Manage computers") { LiveSessionsView() }
                }
                if !matches.isEmpty {
                    Section("Project sessions") {
                        ForEach(preferences?.pinnedFirst(matches) ?? matches) { session in
                            sessionRow(session, assign: false).separatedSessionRow()
                        }
                    }
                }
                if matches.isEmpty && !discovery.sessions.isEmpty {
                    Section {
                        ForEach(preferences?.pinnedFirst(discovery.sessions) ?? discovery.sessions) { session in
                            sessionRow(session, assign: true).separatedSessionRow()
                        }
                    } header: { Text("Choose a session") } footer: {
                        Text("Opening a chosen session remembers its directory for this project on this iPhone.")
                    }
                }
                if discovery.updated != nil && discovery.sessions.isEmpty && discovery.problems.isEmpty {
                    Text("No Herdr sessions are running on the connected computers. \"Open on a computer…\" can still open a terminal over SSH.").foregroundStyle(.secondary)
                }
            }
            .listSectionSpacing(12)
            .navigationTitle("Project sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Refresh sessions", systemImage: "arrow.clockwise") { refreshID = UUID() }
                        .disabled(discovery.refreshing)
                }
            }
            .phrenScreen()
            .modifier(SessionLaunchAlert(error: $error))
            .navigationDestination(item: $chatSession) { AgentChatSheet(session: $0) }
            .navigationDestination(item: $terminalSession) { HerdrTerminalView(host: $0.host, session: $0) }
            .sheet(isPresented: $launching) { LaunchSessionView(storeID: storeID, project: project) }
            .sheet(item: $launchingWorktree) { LaunchSessionView(worktree: $0) }
            .projectAgentSheet(choice: $agentChoice)
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .task(id: DiscoveryIdentity(hosts: preferences?.hosts ?? [], active: visible && scenePhase == .active, refresh: refreshID)) {
                guard visible, scenePhase == .active, let preferences, !preferences.hosts.isEmpty else { return }
                let overview = SessionOverviewMonitor.shared
                overview.ensureRunning(hosts: preferences.hosts)
                for computer in overview.computers { computer.monitor.refreshNow() }
            }
    }

    private func sessionRow(_ session: LiveAgentSession, assign: Bool) -> some View {
        let fresh = discovery.isFresh(session)
        return HStack(spacing: 0) {
                Button { open(session, assign: assign) } label: {
                    SessionCardContent(session: session, fresh: fresh, stale: !fresh, project: assign ? nil : project,
                                       projectStoreId: assign ? nil : storeID,
                                       computer: session.host, identifierPrefix: "discovered")
                }
                .buttonStyle(.plain)
                .openAgentHold { agentChoice = .computer(session.host) }
                .accessibilityHint(openChat ? (assign ? "Use for \(project) and chat" : "Chat with agent")
                                   : (assign ? "Use for \(project) and open terminal" : "Open terminal"))
                .disabled(!fresh || (assign && session.tab.cwd == nil))
                .accessibilityIdentifier("discovered-session:\(session.host.id):\(session.workspaceID):\(session.tab.id)")
                SessionPinButton(session: session, pinned: preferences?.isPinned(session.id) == true,
                                 identifierPrefix: "discovered", data: livePreferences.binding)
            }
            .sessionCard()
    }

    private func open(_ session: LiveAgentSession, assign: Bool) {
        do {
            let discovery = discovery
            let answeredAt = SessionOverviewMonitor.shared.computers.first { $0.host == session.host }?.monitor.lastUpdated
            guard scenePhase == .active, visible,
                  answeredAt.map({ Date().timeIntervalSince($0) < 25 }) == true,
                  let current = discovery.sessions.first(where: { $0.id == session.id }),
                  current.host == session.host, current.tab.cwd == session.tab.cwd,
                  model.sessionProjects.contains(target) else {
                error = "This session changed or needs a refresh. Choose it again from the current list."
                return
            }
            if assign, let cwd = current.tab.cwd {
                try livePreferences.update {
                    try LiveSessionPreferences.assigning(hostID: session.host.id, directory: cwd,
                                                         storeID: storeID, project: project, in: $0)
                }
            }
            if openChat { chatSession = current; return }
            terminalSession = current
        } catch { self.error = error.localizedDescription }
    }

    private struct DiscoveryIdentity: Equatable {
        let hosts: [LiveHost]
        let active: Bool
        let refresh: UUID
    }
}
