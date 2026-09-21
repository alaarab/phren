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
    private var states: [String: String] = [:]
    private var tools: [String: String] = [:]
    private var details: [String: String] = [:]
    /// What the Hook says each working agent is doing, from the overview,
    /// so the lock screen has a step even when no chat is open.
    private var overviewSteps: [String: String] = [:]
    /// The model the Hook names for each agent pane, from the same overview.
    private var overviewModels: [String: String] = [:]
    private var subagents: [String: Int] = [:]
    private var childProviders: [String: [String]] = [:]
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
        subagents[entity.id] = session.tab.runningChildren
        childProviders[entity.id] = session.tab.childProviders
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
            if let model = session.tab.model, !model.isEmpty { overviewModels[id] = model } else { overviewModels[id] = nil }
            subagents[id] = session.tab.runningChildren
            childProviders[id] = session.tab.childProviders
        }
        sessionsByHost[host.id] = reports.map { input($0.entity, state: lockState($0.state), now: now) }
        let retained = Set(sessionsByHost.values.flatMap { $0.map(\.entry.id) })
        starts = starts.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        states = states.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        entities = entities.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        tools = tools.filter { retained.contains($0.key) }
        details = details.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        overviewSteps = overviewSteps.filter { retained.contains($0.key) }
        overviewModels = overviewModels.filter { retained.contains($0.key) }
        subagents = subagents.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        childProviders = childProviders.filter { retained.contains($0.key) || chat?.session.entry.id == $0.key }
        scheduleUpdate()
    }

    func reconcileHosts(_ hosts: [LiveHost]) async {
        let saved = Set(hosts.map(\.id))
        sessionsByHost = sessionsByHost.filter { saved.contains($0.key) }
        entities = entities.filter { entity in hosts.contains { $0.id == entity.value.hostID && $0.muxID == entity.value.muxID } }
        if let chat, entities[chat.session.entry.id] == nil { self.chat = nil }
        details = details.filter { entities[$0.key] != nil || chat?.session.entry.id == $0.key }
        overviewSteps = overviewSteps.filter { entities[$0.key] != nil || chat?.session.entry.id == $0.key }
        overviewModels = overviewModels.filter { entities[$0.key] != nil || chat?.session.entry.id == $0.key }
        subagents = subagents.filter { entities[$0.key] != nil || chat?.session.entry.id == $0.key }
        childProviders = childProviders.filter { entities[$0.key] != nil || chat?.session.entry.id == $0.key }
        starts = starts.filter { entities[$0.key] != nil }
        states = states.filter { entities[$0.key] != nil }
        scheduleUpdate()
    }

    func routeURL(for session: LiveAgentSession) -> URL? {
        let entity = AgentSessionEntity(session)
        entities[entity.id] = entity
        var url = URLComponents()
        url.scheme = "phren"
        url.host = "session"
        url.queryItems = [URLQueryItem(name: "route", value: entity.id)]
        return url.url
    }

    func open(routeID: String) throws {
        AppModel.current?.selectedTab = .agents
        if let entity = entities[routeID] {
            try AgentLaunch.openIndexedSession(entity, destination: .chat)
            return
        }
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
    /// The overview's states as the lock screen reads them: a finish is an
    /// idle row it keeps for a minute, while an error or unknown pane is not
    /// a running agent and gets no row.
    private func lockState(_ state: SessionStatusReport.State) -> String {
        switch state {
        case .working: "working"
        case .waiting: "waiting"
        case .idle, .done: "idle"
        default: state.rawValue
        }
    }
    private func input(_ entity: AgentSessionEntity, state: String, provider: String? = nil, now: Date) -> SessionWorkingActivityBuilder.Session {
        entities[entity.id] = entity
        let reportedState = state
        let workers = subagents[entity.id] ?? 0
        if reportedState != "working" { tools[entity.id] = nil; details[entity.id] = nil }
        let tool = tools[entity.id]
        let ownStep = SessionActivityStep.format(tool: tool, detail: details[entity.id] ?? (tool == nil ? overviewSteps[entity.id] : nil), status: statusText(reportedState))
        let presentation = SessionWorkingActivityBuilder.presentation(state: reportedState, step: ownStep, runningChildren: workers)
        let state = presentation.state
        if states[entity.id] != state {
            // Title/tool updates must not restart a turn's timer. An idle pane
            // with no history is not evidence that an agent just finished.
            let fallback: Date = state == "idle" && states[entity.id] == nil ? .distantPast : now
            starts[entity.id] = reportedState == "idle" && workers > 0 ? now : min(entity.lastChangedAt ?? fallback, now)
            states[entity.id] = state
        }
        let began = starts[entity.id] ?? now
        return .init(entry: .init(id: entity.id, project: String((entity.project ?? entity.workspace).prefix(80)),
                                 provider: provider ?? entity.agent ?? "agent", tool: tool.map { String($0.prefix(60)) },
                                 computer: String(entity.computer.prefix(60)),
                                 model: overviewModels[entity.id].map { String($0.prefix(40)) },
                                 step: presentation.step, subagents: workers,
                                 childProviders: childProviders[entity.id] ?? [], state: state, startedAt: began),
                     state: state, startedAt: began)
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
        if sessionsByHost.values.joined().contains(where: { $0.state == "working" || $0.state == "waiting" })
            || (["working", "waiting"].contains(chat?.session.state ?? "") && Date.now.timeIntervalSince(chat?.at ?? .distantPast) < 6) {
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
        if state.working == 0 && state.waiting == 0 && state.entries.isEmpty {
            guard let current else { return }
            // Preserve the last timer during the quiet period, so idle polls
            // don't keep changing content or restart the 30-second deadline.
            state = .init(working: 0, waiting: state.waiting, entries: state.entries, startedAt: current.content.state.startedAt,
                          more: state.more, computers: state.computers)
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
            guard state.working + state.waiting > 0, ActivityAuthorizationInfo().areActivitiesEnabled,
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
