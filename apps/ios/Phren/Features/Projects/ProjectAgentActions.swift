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

private struct ProjectAgentSheet: ViewModifier {
    @Binding var choice: ProjectAgentChoice?
    @Environment(AppModel.self) private var model
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var launch: Destination?

    private struct Destination: Identifiable {
        let storeID: String
        let project: String
        let host: LiveHost
        var id: String { "\(storeID):\(project):\(host.id)" }
    }
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var destinations: [Destination] {
        switch choice {
        case .project(let storeID, let name):
            return ProjectAgentCheckouts.hosts(model: model, storeID: storeID, project: name, preferences: preferences)
                .map { Destination(storeID: storeID, project: name, host: $0) }
        case .computer(let host):
            return model.sessionProjects.filter { project in
                ProjectAgentCheckouts.hosts(model: model, storeID: project.storeID, project: project.name, preferences: preferences)
                    .contains { $0.id == host.id }
            }.map { Destination(storeID: $0.storeID, project: $0.name, host: host) }
        case nil: return []
        }
    }
    private var actions: [PhrenControlAction] {
        let targets = destinations
        guard !targets.isEmpty else {
            return [.init(id: "empty", title: "No known checkouts", caption: "Connect a computer and add this project there first.", isEnabled: false) {}]
        }
        return targets.map { destination in
            .init(id: destination.id, title: "Open agent on \(destination.host.name)", icon: "circle.fill",
                  iconColor: PhrenTheme.hostColor(destination.host.color),
                  caption: "\(destination.project) · \(model.storeName(for: destination.storeID))") {
                launch = destination
            }
        }
    }
    func body(content: Content) -> some View {
        content
            .phrenActionSheet(isPresented: Binding(get: { choice != nil }, set: { if !$0 { choice = nil } }),
                              title: choice?.title ?? "Open agent", actions: actions, identifier: "project-agent-sheet")
            .sheet(item: $launch) { target in
                LaunchSessionView(storeID: target.storeID, project: target.project, preferredHostID: target.host.id)
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
    @AppStorage("sessions.live.preferences.v1") private var data = Data()

    var body: some View {
        let hosts = ProjectAgentCheckouts.hosts(model: model, storeID: storeID, project: project,
                                               preferences: try? LiveSessionPreferences.read(data))
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
