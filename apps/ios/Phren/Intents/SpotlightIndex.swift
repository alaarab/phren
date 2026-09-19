import AppIntents
import CoreSpotlight
import OSLog
import PhrenKit

struct SpotlightCatalog: Equatable, Codable {
    var sessions: [AgentSessionEntity] = []
    var projects: [ProjectEntity] = []

    /// An offline host contributes no new evidence. Only a successful snapshot
    /// replaces its sessions; removing a saved host explicitly prunes them.
    mutating func refreshSessions(_ sessions: [LiveAgentSession], on host: LiveHost) {
        self.sessions.removeAll { $0.hostID == host.id }
        self.sessions += sessions.filter { $0.tab.agent != nil }.map(AgentSessionEntity.init)
        self.sessions.sort { $0.id < $1.id }
    }

    mutating func reconcileHosts(_ hosts: [LiveHost]) {
        sessions.removeAll { entity in !hosts.contains { $0.id == entity.hostID && $0.muxID == entity.muxID } }
    }

    mutating func matchProjects(preferences: LiveSessionPreferences?) {
        let choices = projects.map { SessionProject(storeID: $0.storeId, name: $0.project) }
        for index in sessions.indices {
            let match = preferences?.projectMatch(hostID: sessions[index].hostID, cwd: sessions[index].folder, projects: choices)
            sessions[index].project = match?.project.name
            sessions[index].projectStoreID = match?.project.storeID
        }
        for index in projects.indices {
            projects[index].sessions = sessions.filter {
                $0.project == projects[index].project && $0.projectStoreID == projects[index].storeId
            }
        }
    }
}

@MainActor
final class SpotlightIndex {
    static let shared = SpotlightIndex()
    private static let cacheKey = "spotlight.catalog.v1"
    private let index = CSSearchableIndex(name: "com.phren.ios.entities")
    private let logger = Logger(subsystem: "com.phren.ios", category: "Spotlight")
    private var catalog: SpotlightCatalog
    private var debounce = SpotlightDebounce<SpotlightCatalog>()
    private var worker: Task<Void, Never>?

    private init() {
        catalog = AppRuntime.defaults.data(forKey: Self.cacheKey)
            .flatMap { try? JSONDecoder().decode(SpotlightCatalog.self, from: $0) } ?? SpotlightCatalog()
    }

    func sessions(for identifiers: [String]) -> [AgentSessionEntity] {
        let hosts = AgentSessions.hosts
        return catalog.sessions.filter { entity in
            identifiers.contains(entity.id) && hosts.contains { $0.id == entity.hostID && $0.muxID == entity.muxID }
        }
    }

    func reconcileHosts(_ hosts: [LiveHost]) {
        catalog.reconcileHosts(hosts)
        schedule()
    }

    func refreshSessions(_ sessions: [LiveAgentSession], on host: LiveHost) {
        // A response from an old connection cannot repopulate a removed host.
        guard AgentSessions.hosts.contains(host) else { return }
        catalog.refreshSessions(sessions, on: host)
        schedule()
    }

    func refreshProjects(from model: AppModel) {
        catalog.projects = SpotlightProjects.entities(from: model)
        catalog.reconcileHosts(AgentSessions.hosts)
        schedule()
    }

    private func schedule() {
        guard #available(iOS 18.0, *) else { return }
        // UI and unit fixtures must never donate their synthetic data to the
        // device's search index. The debounce/catalog are tested independently.
        guard !AppRuntime.isUITesting, ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        catalog.matchProjects(preferences: preferences)
        debounce.update(catalog, at: Date())
        guard worker == nil, debounce.deadline != nil else { return }
        worker = Task { [self] in
            defer { worker = nil }
            while let deadline = debounce.deadline {
                do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) }
                catch { return }
                guard let value = debounce.ready(at: Date()) else { continue }
                do {
                    try await write(value, previous: debounce.committed)
                    AppRuntime.defaults.set(try JSONEncoder().encode(value), forKey: Self.cacheKey)
                    debounce.complete(value, succeeded: true, at: Date())
                } catch {
                    logger.error("Could not refresh Spotlight: \(error.localizedDescription, privacy: .public)")
                    debounce.complete(value, succeeded: false, at: Date())
                    // Retry on the next refresh, without a background retry loop.
                    return
                }
            }
        }
    }

    @available(iOS 18.0, *)
    private func write(_ value: SpotlightCatalog, previous: SpotlightCatalog?) async throws {
        if let previous {
            let sessions = Set(value.sessions.map(\.id)), projects = Set(value.projects.map(\.id))
            let removedSessions = previous.sessions.map(\.id).filter { !sessions.contains($0) }
            let removedProjects = previous.projects.map(\.id).filter { !projects.contains($0) }
            if !removedSessions.isEmpty { try await index.deleteAppEntities(identifiedBy: removedSessions, ofType: AgentSessionEntity.self) }
            if !removedProjects.isEmpty { try await index.deleteAppEntities(identifiedBy: removedProjects, ofType: ProjectEntity.self) }
        } else {
            // Once per process, reconcile persisted Spotlight state too. This
            // also recovers an interrupted write or an OS-cleared index.
            try await index.deleteAppEntities(ofType: AgentSessionEntity.self)
            try await index.deleteAppEntities(ofType: ProjectEntity.self)
        }
        let sessions = value.sessions.filter { !(previous?.sessions.contains($0) ?? false) }
        let projects = value.projects.filter { !(previous?.projects.contains($0) ?? false) }
        if !sessions.isEmpty { try await index.indexAppEntities(sessions) }
        if !projects.isEmpty { try await index.indexAppEntities(projects) }
        PhrenAppShortcuts.updateAppShortcutParameters()
    }
}
