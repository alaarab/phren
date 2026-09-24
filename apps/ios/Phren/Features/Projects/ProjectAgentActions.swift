import PhrenKit
import SwiftUI

enum ProjectAgentChoice {
    case project(storeID: String, name: String)
    case computer(LiveHost)

    var title: String {
        switch self {
        case .project(_, let name): name
        case .computer(let host): host.name
        }
    }
}

/// The registry, saved directory matches and live sessions all describe checkouts.
/// Keep the store identity when two stores contain a project with the same name.
@MainActor
enum ProjectAgentCheckouts {
    static func hosts(model: AppModel, storeID: String, project: String, preferences: LiveSessionPreferences?) -> [LiveHost] {
        let computers = SessionOverviewMonitor.shared.computers
        let hosts = preferences?.hosts ?? computers.map(\.host)
        let registry = model.machineRegistry(storeId: storeID)
        return hosts.filter { host in
            let computer = computers.first { $0.id == host.id }
            let names = [computer?.monitor.snapshot?.computer?.name, host.name, host.address].compactMap { $0 }
            if names.contains(where: { registry.hosts($0, project: project) }) { return true }
            if preferences?.mappings.contains(where: { $0.hostID == host.id && $0.storeID == storeID && $0.project == project }) == true { return true }
            return (computer?.monitor.snapshot?.sessions(on: host) ?? []).contains { session in
                preferences?.projectMatch(hostID: host.id, cwd: session.tab.cwd, projects: model.sessionProjects)?.project
                    == SessionProject(storeID: storeID, name: project)
            }
        }
    }
}

/// Successful launches, scoped to both the store and project. Merely opening
/// or cancelling the launch editor must not change the preferred computer.
enum ProjectAgentRecents {
    static let key = "project.agent.recents.v1"
    struct Use: Codable, Equatable {
        let storeID: String
        let project: String
        let hostID: UUID
        let date: Date
    }

    static func read(_ data: Data) -> [Use] { (try? JSONDecoder().decode([Use].self, from: data)) ?? [] }

    static func recording(storeID: String, project: String, hostID: UUID, at date: Date, in data: Data) -> Data {
        var uses = read(data).filter { !($0.storeID == storeID && $0.project == project && $0.hostID == hostID) }
        uses.append(Use(storeID: storeID, project: project, hostID: hostID, date: date))
        return (try? JSONEncoder().encode(Array(uses.sorted { $0.date > $1.date }.prefix(500)))) ?? data
    }

    @MainActor static func record(storeID: String, project: String, hostID: UUID) {
        let defaults = AppRuntime.defaults
        defaults.set(recording(storeID: storeID, project: project, hostID: hostID, at: .now,
                               in: defaults.data(forKey: key) ?? Data()), forKey: key)
    }
}

struct ProjectAgentDestination: Identifiable {
    let storeID: String
    let project: String
    let host: LiveHost
    var reachable: Bool
    var state: String
    var sessionCount: Int
    var lastSeen: Date? = nil
    var lastUsed: Date? = nil
    var reason: String? = nil
    var id: String { "\(storeID):\(project):\(host.id)" }

    var caption: String {
        var parts = [state, "\(sessionCount) \(sessionCount == 1 ? "session" : "sessions")"]
        if !reachable, let lastSeen {
            parts.append("Last seen \(lastSeen.formatted(.relative(presentation: .named)))")
        }
        if let reason { parts.append(reason) }
        return parts.joined(separator: " · ")
    }

    static func ordered(_ targets: [Self]) -> [Self] {
        targets.sorted {
            if $0.reachable != $1.reachable { return $0.reachable }
            if $0.lastUsed != $1.lastUsed { return ($0.lastUsed ?? .distantPast) > ($1.lastUsed ?? .distantPast) }
            let name = $0.host.name.localizedStandardCompare($1.host.name)
            return name == .orderedSame ? $0.id < $1.id : name == .orderedAscending
        }
    }

    static func lastUsed(in targets: [Self]) -> Self? {
        targets.filter { $0.lastUsed != nil }.sorted {
            if $0.lastUsed != $1.lastUsed { return $0.lastUsed! > $1.lastUsed! }
            return $0.id < $1.id
        }.first
    }
}

private struct ProjectAgentSheet: ViewModifier {
    @Binding var choice: ProjectAgentChoice?
    @Environment(AppModel.self) private var model
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @AppStorage(ProjectAgentRecents.key) private var recentData = Data()
    @State private var launch: ProjectAgentDestination?
    @State private var launchWorktree: WorktreeLaunchRequest?

    private var preferences: LiveSessionPreferences? { preferencesStore.preferences }
    private var title: String {
        switch choice {
        case .project(let storeID, let project): "Open on computer · \(project) · \(model.storeName(for: storeID))"
        case .computer(let host): "Open project on \(host.name)"
        case nil: "Open agent"
        }
    }
    private var destinations: [ProjectAgentDestination] {
        let targets: [ProjectAgentDestination]
        switch choice {
        case .project(let storeID, let name):
            targets = ProjectAgentCheckouts.hosts(model: model, storeID: storeID, project: name, preferences: preferences)
                .map { destination(storeID: storeID, project: name, host: $0) }
        case .computer(let host):
            targets = model.sessionProjects.filter { project in
                ProjectAgentCheckouts.hosts(model: model, storeID: project.storeID, project: project.name, preferences: preferences)
                    .contains { $0.id == host.id }
            }.map { destination(storeID: $0.storeID, project: $0.name, host: host) }
        case nil: targets = []
        }
        return ProjectAgentDestination.ordered(targets)
    }

    private func destination(storeID: String, project: String, host: LiveHost) -> ProjectAgentDestination {
        let monitor = SessionOverviewMonitor.shared.computers.first { $0.id == host.id }?.monitor
        let sessions = (monitor?.snapshot?.sessions(on: host) ?? []).filter {
            preferences?.projectMatch(hostID: host.id, cwd: $0.tab.cwd, projects: model.sessionProjects)?.project
                == SessionProject(storeID: storeID, name: project)
        }
        let recent = ProjectAgentRecents.read(recentData).first {
            $0.storeID == storeID && $0.project == project && $0.hostID == host.id
        }?.date
        let lastActivity = sessions.compactMap { $0.tab.lastChangedAt }.max()
        let reachable = monitor?.isFresh(at: .now) == true && monitor?.message == nil && host.fingerprint != nil
        let reason: String?
        if host.fingerprint == nil { reason = "Verify this computer's SSH key first." }
        else if let message = monitor?.message { reason = message }
        else if !reachable { reason = monitor?.isConnecting == true ? "Connecting to computer…" : "Computer is not reachable." }
        else { reason = nil }
        let state = reachable ? (sessions.contains { $0.tab.activity == .working } ? "Working" : "Idle")
            : (monitor?.isConnecting == true && host.fingerprint != nil ? "Connecting" : "Offline")
        return ProjectAgentDestination(storeID: storeID, project: project, host: host, reachable: reachable,
            state: state,
            sessionCount: sessions.count, lastSeen: monitor?.lastUpdated,
            lastUsed: [recent, lastActivity].compactMap { $0 }.max(), reason: reason)
    }

    private var actions: [PhrenControlAction] {
        let targets = destinations
        guard !targets.isEmpty else {
            return [.init(id: "empty", title: "No known checkouts", caption: "Connect a computer and add this project there first.", isEnabled: false) {}]
        }
        var actions: [PhrenControlAction] = []
        if case .project = choice, let recent = ProjectAgentDestination.lastUsed(in: targets) {
            actions.append(action(recent, id: "recent", title: "Open on \(recent.host.name)", prefix: "Last used · "))
        }
        // A separate choice, so a worktree is found without opening the
        // launch screen first. The computer is chosen there.
        if case .project(let storeID, let name) = choice {
            let host = ProjectAgentDestination.lastUsed(in: targets) ?? targets.first { $0.reachable }
            actions.append(.init(id: "worktree", title: "New session in a worktree", icon: "arrow.branch",
                                 caption: "Starts on a new branch of its own") {
                launchWorktree = WorktreeLaunchRequest(storeID: storeID, project: name, hostID: host?.host.id)
            })
        }
        actions += targets.map { destination in
            let rowTitle: String
            let prefix: String
            if case .computer = choice {
                rowTitle = destination.project
                prefix = "\(model.storeName(for: destination.storeID)) · "
            } else { rowTitle = destination.host.name; prefix = "" }
            return action(destination, id: destination.id, title: rowTitle, prefix: prefix)
        }
        return actions
    }

    private func action(_ target: ProjectAgentDestination, id: String, title: String, prefix: String) -> PhrenControlAction {
        .init(id: id, title: title, icon: "circle.fill", iconColor: PhrenTheme.hostColor(target.host.color),
              caption: prefix + target.caption, isEnabled: target.reachable) { launch = target }
    }

    func body(content: Content) -> some View {
        content
            .phrenActionSheet(isPresented: Binding(get: { choice != nil }, set: { if !$0 { choice = nil } }),
                              title: title, actions: actions, identifier: "project-agent-sheet",
                              searchPlaceholder: destinations.count > 8 ? "Search" : nil)
            .sheet(item: $launch) { target in
                LaunchSessionView(storeID: target.storeID, project: target.project, preferredHostID: target.host.id)
            }
            .sheet(item: $launchWorktree) { LaunchSessionView(worktree: $0) }
            .onChange(of: choice != nil) { _, presented in
                if presented {
                    let overview = SessionOverviewMonitor.shared
                    overview.ensureRunning(hosts: preferences?.hosts ?? overview.computers.map(\.host))
                }
            }
    }
}

extension View {
    func projectAgentSheet(choice: Binding<ProjectAgentChoice?>) -> some View {
        modifier(ProjectAgentSheet(choice: choice))
    }

    func openAgentHold(_ action: @escaping () -> Void) -> some View {
        let open = {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }
        return self.highPriorityGesture(LongPressGesture(minimumDuration: 0.4).onEnded { _ in open() })
            .accessibilityAction(named: "Open agent", open)
            .accessibilityHint("Hold to open an agent")
    }
}

/// Short taps keep the project session route; holding chooses a project on the computer.
struct ProjectComputerRows: View {
    let storeID: String
    let project: String
    var showsWorkspaces = false
    @Binding var choice: ProjectAgentChoice?
    @Environment(AppModel.self) private var model
    @Environment(\.liveSessionPreferences) private var preferencesStore

    var body: some View {
        let hosts = ProjectAgentCheckouts.hosts(model: model, storeID: storeID, project: project,
                                               preferences: preferencesStore.preferences)
        if !hosts.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(hosts) { host in
                        NavigationLink {
                            if showsWorkspaces { HerdrWorkspacesView(hostID: host.id) }
                            else { ProjectSessionsView(storeID: storeID, project: project, openChat: true) }
                        } label: {
                            HStack(spacing: 6) {
                                Circle().fill(PhrenTheme.hostColor(host.color)).frame(width: 8, height: 8)
                                Text(host.name).font(PhrenTypography.subheadline)
                            }
                            .foregroundStyle(PhrenTheme.text).padding(.horizontal, 12).frame(minHeight: 44)
                            .background(PhrenTheme.surface, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("project-computer:\(host.id)")
                        .openAgentHold { choice = .computer(host) }
                    }
                }.padding(.horizontal, 16)
            }
        }
    }
}
