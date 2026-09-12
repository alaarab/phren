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

@Observable @MainActor
private final class ProjectSessionDiscovery {
    var sessions: [LiveAgentSession] = []
    var problems: [String] = []
    var refreshing = false
    var updated: Date?
    private var generation = UUID()

    func refresh(hosts: [LiveHost]) async {
        let run = UUID()
        generation = run
        refreshing = true
        defer { if generation == run { refreshing = false } }
        var found: [LiveAgentSession] = []
        var failures: [String] = []
        await withTaskGroup(of: HostResult.self) { group in
            for host in hosts {
                group.addTask {
                    guard host.fingerprint != nil else {
                        return HostResult(sessions: [], problem: "\(host.name): finish verifying the computer in Agents.")
                    }
                    do {
                        let snapshot = try await LiveHostMonitor.fetch(host)
                        return HostResult(sessions: snapshot.sessions(on: host), problem: nil)
                    } catch {
                        let message = (error as? LiveConnectionError)?.localizedDescription
                            ?? (error as? PhrenKitError)?.localizedDescription ?? "Couldn't read sessions."
                        return HostResult(sessions: [], problem: "\(host.name): \(message)")
                    }
                }
            }
            for await result in group {
                found += result.sessions
                if let problem = result.problem { failures.append(problem) }
            }
        }
        guard !Task.isCancelled, generation == run else { return }
        sessions = found.sorted { ($0.host.name, $0.workspaceName, $0.tab.label, $0.tab.id) < ($1.host.name, $1.workspaceName, $1.tab.label, $1.tab.id) }
        problems = failures.sorted()
        updated = .now
    }

    private struct HostResult: Sendable {
        let sessions: [LiveAgentSession]
        let problem: String?
    }
}

/// Opened by an explicit request to resume a project's session. Resolve once
/// before opening the native chat or terminal on that exact computer.
struct ProjectSessionsView: View {
    let storeID: String
    let project: String
    var openChat = false
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var discovery = ProjectSessionDiscovery()
    @State private var visible = false
    @State private var refreshID = UUID()
    @State private var error: String?
    @State private var chatSession: LiveAgentSession?
    @State private var terminalSession: LiveAgentSession?

    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var target: SessionProject { SessionProject(storeID: storeID, name: project) }
    private var matches: [LiveAgentSession] {
        let preferences = preferences
        let projects = model.sessionProjects
        return discovery.sessions.filter {
            preferences?.projectMatch(hostID: $0.host.id, cwd: $0.tab.cwd, projects: projects)?.project == target
        }
    }

    var body: some View {
        NavigationStack {
            PhrenList {
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
                    Text("No Herdr sessions are running on the connected computers.").foregroundStyle(.secondary)
                }
            }
            .listSectionSpacing(12)
            .navigationTitle("Project sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("Refresh sessions", systemImage: "arrow.clockwise") { refreshID = UUID() }
                        .disabled(discovery.refreshing)
                }
            }
            .phrenScreen()
            .modifier(SessionLaunchAlert(error: $error))
            .sheet(item: $chatSession) { AgentChatSheet(session: $0) }
            .sheet(item: $terminalSession) { session in
                NavigationStack { HerdrTerminalView(host: session.host, session: session) }
            }
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .task(id: DiscoveryIdentity(hosts: preferences?.hosts ?? [], active: visible && scenePhase == .active, refresh: refreshID)) {
                guard visible, scenePhase == .active, let preferences, !preferences.hosts.isEmpty else { return }
                while !Task.isCancelled {
                    await discovery.refresh(hosts: preferences.hosts)
                    guard !Task.isCancelled else { return }
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                }
            }
        }
    }

    private func sessionRow(_ session: LiveAgentSession, assign: Bool) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let fresh = discovery.updated.map { context.date.timeIntervalSince($0) < 25 } == true
            HStack(spacing: 0) {
                Button { open(session, assign: assign) } label: {
                    SessionCardContent(session: session, fresh: fresh,
                                       subtitle: "\(session.host.name) · \(session.workspaceName) · \(session.tab.status)\(fresh ? "" : " · stale")",
                                       identifierPrefix: "discovered")
                }
                .buttonStyle(.plain)
                .accessibilityHint(openChat ? (assign ? "Use for \(project) and chat" : "Chat with agent")
                                   : (assign ? "Use for \(project) and open terminal" : "Open terminal"))
                .disabled(!fresh || (assign && session.tab.cwd == nil))
                .accessibilityIdentifier("discovered-session:\(session.host.id):\(session.workspaceID):\(session.tab.id)")
                SessionPinButton(session: session, pinned: preferences?.isPinned(session.id) == true,
                                 identifierPrefix: "discovered", data: $data)
            }
            .sessionCard()
        }
    }

    private func open(_ session: LiveAgentSession, assign: Bool) {
        do {
            guard scenePhase == .active, visible,
                  discovery.updated.map({ Date().timeIntervalSince($0) < 25 }) == true,
                  let current = discovery.sessions.first(where: { $0.id == session.id }),
                  current.host == session.host, current.tab.cwd == session.tab.cwd,
                  model.sessionProjects.contains(target) else {
                error = "This session changed or needs a refresh. Choose it again from the current list."
                return
            }
            if assign, let cwd = current.tab.cwd {
                data = try LiveSessionPreferences.assigning(hostID: session.host.id, directory: cwd,
                                                            storeID: storeID, project: project, in: data)
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
