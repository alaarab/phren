import ActivityKit
import Foundation
import PhrenKit

/// One activity for the same unfiltered, per-computer snapshots the overview
/// polls. No activity owns a connection, and opening another chat cannot replace it.
@MainActor
final class SessionWorkingActivityController {
    static let shared = SessionWorkingActivityController()
    private static let routeKey = "session.working.activity.single.v2"
    private var sessionsByHost: [UUID: [SessionWorkingActivityBuilder.Session]] = [:]
    private var entities: [String: AgentSessionEntity] = [:]
    private var starts: [String: Date] = [:]
    private var tools: [String: String] = [:]
    private var chat: (session: SessionWorkingActivityBuilder.Session, at: Date)?
    private var pinnedID: String?
    private var updateTask: Task<Void, Never>?
    private var endTask: Task<Void, Never>?
    private var quietSince: Date?

    private init() {}

    func observe(session: LiveAgentSession, project: String?, provider: String?, branch: String?,
                 activity state: String?, toolName: String?, now: Date = .now) async {
        SessionOverviewMonitor.shared.ensureRunning(hosts: AgentSessions.hosts)
        var entity = AgentSessionEntity(session); entity.project = project
        let state = normalized(state)
        tools[entity.id] = state == "working" ? toolName : nil
        chat = (input(entity, state: state, provider: provider, now: now), now)
        scheduleUpdate()
    }

    func pin(_ entity: AgentSessionEntity, now: Date = .now) async -> Bool {
        guard entity.isLive, normalized(entity.state) == "working", ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
        pinnedID = entity.id
        scheduleUpdate()
        await updateTask?.value
        return !Activity<SessionWorkingActivityAttributes>.activities.isEmpty
    }

    func reconcile(_ sessions: [LiveAgentSession], on host: LiveHost, projects: [ProjectEntity],
                   preferences: LiveSessionPreferences?, now: Date = .now) async {
        let reports = SessionStatusService.reports(for: sessions, projects: projects, preferences: preferences)
        sessionsByHost[host.id] = reports.map { input($0.entity, state: $0.state.rawValue, now: now) }
        let retained = Set(sessionsByHost.values.flatMap { $0.map(\.entry.id) })
        starts = starts.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        entities = entities.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        tools = tools.filter { retained.contains($0.key) }
        scheduleUpdate()
    }

    func reconcileHosts(_ hosts: [LiveHost]) async {
        let saved = Set(hosts.map(\.id))
        sessionsByHost = sessionsByHost.filter { saved.contains($0.key) }
        entities = entities.filter { entity in hosts.contains { $0.id == entity.value.hostID && $0.muxID == entity.value.muxID } }
        if let chat, entities[chat.session.entry.id] == nil { self.chat = nil }
        scheduleUpdate()
    }

    func open(routeID: String) throws {
        AppModel.current?.selectedTab = .agents
        guard let data = AppRuntime.defaults.data(forKey: Self.routeKey),
              let route = try? JSONDecoder().decode(Route.self, from: data), route.id == routeID else { return }
        try AgentLaunch.openIndexedSession(route.entity, destination: .chat)
    }

    private struct Route: Codable { let id: String; let entity: AgentSessionEntity }
    private func normalized(_ state: String?) -> String {
        switch state?.lowercased() {
        case "working": "working"
        case "waiting", "blocked", "permission needed": "waiting"
        default: "idle"
        }
    }
    private func input(_ entity: AgentSessionEntity, state: String, provider: String? = nil, now: Date) -> SessionWorkingActivityBuilder.Session {
        entities[entity.id] = entity
        if state == "working" { starts[entity.id] = starts[entity.id] ?? min(entity.lastChangedAt ?? now, now) }
        else { starts[entity.id] = nil; tools[entity.id] = nil }
        return .init(entry: .init(id: entity.id, project: String((entity.project ?? entity.workspace).prefix(80)),
                                 provider: provider ?? entity.agent ?? "agent", tool: tools[entity.id].map { String($0.prefix(60)) },
                                 computer: String(entity.computer.prefix(60))),
                     state: state, startedAt: starts[entity.id] ?? now)
    }

    /// Coalesces fast hosts and chat ticks without postponing publication forever.
    private func scheduleUpdate() {
        if sessionsByHost.values.joined().contains(where: { $0.state == "working" })
            || (chat?.session.state == "working" && Date.now.timeIntervalSince(chat?.at ?? .distantPast) < 6) {
            quietSince = nil; endTask?.cancel(); endTask = nil
        }
        guard updateTask == nil else { return }
        updateTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(SessionWorkingActivityPolicy.updateInterval)) } catch { return }
            guard let self else { return }
            await publish()
            updateTask = nil
        }
    }
    private func publish(now: Date = .now) async {
        var inputs = sessionsByHost.values.flatMap { $0 }
        // The next overview owns state again if the chat has stopped reporting.
        if let chat, now.timeIntervalSince(chat.at) < 6 { inputs.append(chat.session) }
        var state = SessionWorkingActivityBuilder.build(inputs, pinnedID: pinnedID, now: now)
        let activities = Activity<SessionWorkingActivityAttributes>.activities
        let current = activities.first
        for extra in activities.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
        if state.working == 0 {
            guard let current else { return }
            // Preserve the last timer during the quiet period, so idle polls
            // don't keep changing content or restart the 30-second deadline.
            state = .init(working: 0, waiting: state.waiting, entries: state.entries, startedAt: current.content.state.startedAt)
            if quietSince == nil {
                quietSince = now
                endTask = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(SessionWorkingActivityPolicy.quietInterval)) } catch { return }
                    guard let self, SessionWorkingActivityPolicy.shouldEnd(working: 0, quietSince: quietSince, now: .now) else { return }
                    for activity in Activity<SessionWorkingActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
                    AppRuntime.defaults.removeObject(forKey: Self.routeKey)
                }
            }
        } else {
            quietSince = nil; endTask?.cancel(); endTask = nil
        }
        // Below a pending permission request (relevance 1), which must own
        // the island while it waits for an answer.
        let content = ActivityContent(state: state, staleDate: now.addingTimeInterval(90), relevanceScore: 0.5)
        let activity: Activity<SessionWorkingActivityAttributes>
        if let current {
            activity = current
            if current.content.state != state { await current.update(content) }
        } else {
            guard state.working > 0, ActivityAuthorizationInfo().areActivitiesEnabled,
                  let created = try? Activity.request(attributes: SessionWorkingActivityAttributes(routeID: UUID().uuidString), content: content, pushType: nil) else { return }
            activity = created
        }
        if state.working + state.waiting == 1, let id = state.entries.first?.id, let entity = entities[id] {
            AppRuntime.defaults.set(try? JSONEncoder().encode(Route(id: activity.attributes.routeID, entity: entity)), forKey: Self.routeKey)
        } else { AppRuntime.defaults.removeObject(forKey: Self.routeKey) }
    }
}
