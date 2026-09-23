import Foundation
import Observation
import PhrenKit
import PhrenLive

/// The Agents overview's derived state: the one configuration the shared
/// monitor polls with, the host-to-monitor index the rows resolve through,
/// and the search, Focus and refresh state the toolbar owns. The view draws;
/// the model decides what changes, so a second of freshness ticks never
/// rescans every computer for every row.
@Observable @MainActor
final class LiveSessionsModel {
    /// One computer's identity as the overview resolved it, so the pin write
    /// can compare without walking the computer list again.
    struct HookAssociation: Equatable, Hashable {
        let hostID: UUID
        let computerID: UUID
    }

    /// The monitor index: rebuilt only when the set of computers changes, so
    /// the per-row lookup is a dictionary hit, not a linear scan. The count
    /// is the test hook for the derived-list cache.
    struct MonitorIndex {
        private(set) var ids: [UUID] = []
        private(set) var byHost: [UUID: LiveHostMonitor] = [:]
        private(set) var computations = 0

        mutating func resolve(_ computers: [SessionOverviewMonitor.Computer]) -> [UUID: LiveHostMonitor] {
            let ids = computers.map(\.id).sorted { $0.uuidString < $1.uuidString }
            guard ids != self.ids else { return byHost }
            self.ids = ids
            byHost = Dictionary(computers.map { ($0.id, $0.monitor) }, uniquingKeysWith: { first, _ in first })
            computations += 1
            return byHost
        }
    }

    private(set) var focusFilter = AgentFocusFilterStore.load()
    private(set) var refreshID = UUID()
    var adding = false

    enum SetupAction: String, Identifiable, Hashable {
        case skills, instructions, connectMemory
        var id: String { rawValue }
        var title: String {
            switch self {
            case .skills: "Skills"
            case .instructions: "Agent instructions"
            case .connectMemory: "Connect memory for skills & instructions"
            }
        }
        var icon: String {
            switch self {
            case .skills: "wand.and.stars"
            case .instructions: "person.crop.rectangle.stack"
            case .connectMemory: "brain"
            }
        }
    }

    var setupActions: [SetupAction] {
        memoryConnected ? [.skills, .instructions] : [.connectMemory]
    }

    @ObservationIgnored let overview: SessionOverviewMonitor
    @ObservationIgnored private var index = MonitorIndex()
    @ObservationIgnored private var lastRefreshID = UUID()
    @ObservationIgnored private var preferences: LiveSessionPreferences?
    @ObservationIgnored private var projects: [SessionProject] = []
    @ObservationIgnored private var metadataReady = true
    private var memoryConnected = true
    @ObservationIgnored private var associations: [HookAssociation] = []

    init(overview: SessionOverviewMonitor = .shared) { self.overview = overview }

    var hosts: [LiveHost] { preferences?.hosts ?? [] }

    /// The conductor slot ignores search and Focus so its entry never moves
    /// between activity groups or disappears when another session is sought.
    func conductor(in storeID: String) -> LiveAgentSession? {
        for computer in overview.computers {
            for session in computer.monitor.snapshot?.sessions(on: computer.host) ?? [] where session.tab.isConductor {
                if preferences?.projectMatch(hostID: computer.id, cwd: session.tab.cwd,
                                               projects: projects)?.project.storeID == storeID {
                    return session
                }
            }
        }
        return nil
    }

    static func conductorProject(storeID: String, projects: [SessionProject], registry: MachineRegistry) -> String {
        let available = projects.filter { $0.storeID == storeID && $0.name != "global" }.map(\.name).sorted()
        if let saved = ConductorLaunchSettings.load(storeID: storeID)?.project, available.contains(saved) { return saved }
        return available.first(where: { registry.sourcePaths[$0] != nil }) ?? available.first ?? "global"
    }

    var configuration: SessionOverviewMonitor.Configuration {
        .init(preferences: preferences, projects: projects, focusFilter: focusFilter,
              metadataReady: metadataReady, memoryConnected: memoryConnected)
    }

    /// The overview's one published value for the whole screen.
    var screen: SessionOverviewMonitor.Screen { overview.screen }

    /// The monitor for a session's host, through the cached index.
    func monitor(for hostID: UUID) -> LiveHostMonitor? {
        index.resolve(overview.computers)[hostID]
    }

    var hookAssociations: [HookAssociation] {
        let next = overview.computers.compactMap { computer in
            computer.monitor.snapshot?.computer.map { HookAssociation(hostID: computer.host.id, computerID: $0.id) }
        }.sorted { $0.hostID.uuidString < $1.hostID.uuidString }
        if next != associations { associations = next }
        return next
    }

    /// The store's metadata the monitor needs; the shared monitor guards its
    /// own equality, so an unchanged input never reconfigures it.
    func update(preferences: LiveSessionPreferences?, projects: [SessionProject],
                metadataReady: Bool, memoryConnected: Bool) {
        self.preferences = preferences
        self.projects = projects
        self.metadataReady = metadataReady
        self.memoryConnected = memoryConnected
        overview.configure(configuration)
    }

    func setFocusFilter(_ value: AgentFocusFilter?) {
        guard value != focusFilter else { return }
        focusFilter = value
        overview.configure(configuration)
    }

    func refresh() {
        refreshID = UUID()
        // A manual refresh also asks again for each card's pull request.
        let sessions = overview.computers.flatMap { $0.monitor.snapshot?.sessions(on: $0.host) ?? [] }
        Task { await SessionPullRequestCache.shared.refresh(sessions) }
    }

    /// Start or keep polling from the task the monitor owns. A manual refresh
    /// restarts the run; otherwise the going run keeps going.
    func syncPolling(hosts: [LiveHost], active: Bool) {
        guard active else { overview.stopRunning(); return }
        overview.configure(configuration)
        let currentHosts = hosts
        Task {
            await Task.yield()
            SpotlightIndex.shared.reconcileHosts(currentHosts)
            await WidgetBridge.reconcileSessionHosts(currentHosts)
        }
        if refreshID != lastRefreshID { lastRefreshID = refreshID; overview.stopRunning() }
        overview.ensureRunning(hosts: currentHosts)
    }
}
