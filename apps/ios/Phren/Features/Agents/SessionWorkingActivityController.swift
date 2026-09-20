import ActivityKit
import WidgetKit
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
    private var details: [String: String] = [:]
    /// What the Hook says each working agent is doing, from the overview,
    /// so the lock screen has a step even when no chat is open.
    private var overviewSteps: [String: String] = [:]
    private var subagents: [String: Int] = [:]
    private var chat: (session: SessionWorkingActivityBuilder.Session, at: Date)?
    private var pinnedID: String?
    private var updateTask: Task<Void, Never>?
    private var endTask: Task<Void, Never>?
    private var quietSince: Date?

    private init() {}

    /// The Control Center switch (and Settings) — off ends the activity now
    /// and keeps it off until switched back on.
    private(set) var enabled = WorkingActivityPreference.load().enabled
    func setEnabled(_ value: Bool) async {
        enabled = value
        if #available(iOS 18.0, *) { ControlCenter.shared.reloadControls(ofKind: "com.phren.ios.widgets.working-activity") }
        if !value {
            updateTask?.cancel(); endTask?.cancel(); quietSince = nil
            for activity in Activity<SessionWorkingActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
            AppRuntime.defaults.removeObject(forKey: Self.routeKey)
        } else { scheduleUpdate() }
    }

    func observe(session: LiveAgentSession, project: String?, provider: String?, branch: String?,
                 activity state: String?, toolName: String?, toolDetail: String? = nil, now: Date = .now) async {
        SessionOverviewMonitor.shared.ensureRunning(hosts: AgentSessions.hosts)
        var entity = AgentSessionEntity(session); entity.project = project
        let state = normalized(state)
        tools[entity.id] = state == "working" ? toolName : nil
        details[entity.id] = state == "working" ? toolDetail : nil
        chat = (input(entity, state: state, provider: provider, now: now), now)
        scheduleUpdate()
    }

    /// Running subagents for a session. The Agents overview already polls this
    /// per card (and the open chat per transcript revision); the controller
    /// only stores the number and lets the existing throttle publish it.
    func observeSubagents(session: LiveAgentSession, count: Int) async {
        let id = AgentSessionEntity(session).id
        let value = max(0, count)
        guard subagents[id] != value else { return }
        subagents[id] = value
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
        for session in sessions {
            let id = AgentSessionEntity(session).id
            if let step = session.tab.currentStep, !step.isEmpty { overviewSteps[id] = step } else { overviewSteps[id] = nil }
        }
        sessionsByHost[host.id] = reports.map { input($0.entity, state: $0.state.rawValue, now: now) }
        let retained = Set(sessionsByHost.values.flatMap { $0.map(\.entry.id) })
        starts = starts.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        entities = entities.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        tools = tools.filter { retained.contains($0.key) }
        details = details.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        overviewSteps = overviewSteps.filter { retained.contains($0.key) }
        subagents = subagents.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        scheduleUpdate()
    }

    func reconcileHosts(_ hosts: [LiveHost]) async {
        let saved = Set(hosts.map(\.id))
        sessionsByHost = sessionsByHost.filter { saved.contains($0.key) }
        entities = entities.filter { entity in hosts.contains { $0.id == entity.value.hostID && $0.muxID == entity.value.muxID } }
        if let chat, entities[chat.session.entry.id] == nil { self.chat = nil }
        details = details.filter { entities[$0.key] != nil || chat?.session.entry.id == $0.key }
        subagents = subagents.filter { entities[$0.key] != nil || chat?.session.entry.id == $0.key }
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
        else { starts[entity.id] = nil; tools[entity.id] = nil; details[entity.id] = nil }
        let tool = tools[entity.id]
        return .init(entry: .init(id: entity.id, project: String((entity.project ?? entity.workspace).prefix(80)),
                                 provider: provider ?? entity.agent ?? "agent", tool: tool.map { String($0.prefix(60)) },
                                 computer: String(entity.computer.prefix(60)),
                                 step: SessionActivityStep.format(tool: tool, detail: details[entity.id] ?? (tool == nil ? overviewSteps[entity.id] : nil), status: statusText(state)),
                                 subagents: subagents[entity.id] ?? 0, state: state),
                     state: state, startedAt: starts[entity.id] ?? now)
    }

    /// The step's fallback when no tool is known: the session's own status.
    private func statusText(_ state: String) -> String? {
        switch state.lowercased() {
        case "working": "Working"
        case "waiting": "Needs an answer"
        case "idle": "Idle"
        case "done": "Done"
        case "error": "Needs attention"
        default: nil
        }
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
        guard enabled else { return }
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
        // The activity opens its leading session: the pinned one when there is
        // one, otherwise the oldest working session. An unknown route falls
        // back to the Agents tab in `open(routeID:)`.
        if let id = state.entries.first?.id, let entity = entities[id] {
            AppRuntime.defaults.set(try? JSONEncoder().encode(Route(id: activity.attributes.routeID, entity: entity)), forKey: Self.routeKey)
        } else { AppRuntime.defaults.removeObject(forKey: Self.routeKey) }
    }
}
