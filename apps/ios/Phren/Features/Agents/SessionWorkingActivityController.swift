import ActivityKit
import Foundation
import PhrenKit

@MainActor
final class SessionWorkingActivityController {
    static let shared = SessionWorkingActivityController()
    private static let routesKey = "session.working.activity.routes.v1"

    private struct Route: Codable {
        let entity: AgentSessionEntity
    }

    private var timeoutTasks: [String: Task<Void, Never>] = [:]

    private init() {
        let activities = Activity<SessionWorkingActivityAttributes>.activities
        let activeRoutes = Set(activities.map { $0.attributes.routeID })
        save(routes().filter { activeRoutes.contains($0.key) })
        for activity in activities {
            scheduleTimeout(for: activity.attributes.routeID, at: activity.content.state.expiresAt)
        }
    }

    func observe(session: LiveAgentSession, project: String?, provider: String?, branch: String?,
                 activity state: String?, toolName: String?, optedIn: Bool = true, now: Date = .now) async {
        var entity = AgentSessionEntity(session)
        entity.project = project
        await observe(entity: entity, provider: provider, branch: branch,
                      activity: state ?? "unknown", toolName: toolName, optedIn: optedIn, now: now)
    }

    func pin(_ entity: AgentSessionEntity, now: Date = .now) async -> Bool {
        guard entity.isLive, entity.state?.lowercased() == "working" else { return false }
        await observe(entity: entity, provider: entity.agent, branch: entity.branch,
                      activity: "working", toolName: nil, optedIn: true, now: now)
        return Activity<SessionWorkingActivityAttributes>.activities.contains { $0.attributes.sessionID == entity.id }
    }

    func reconcile(_ sessions: [LiveAgentSession], on host: LiveHost, projects: [ProjectEntity],
                   preferences: LiveSessionPreferences?, now: Date = .now) async {
        guard let tracked = Activity<SessionWorkingActivityAttributes>.activities.first else { return }
        guard tracked.attributes.sessionID.hasPrefix(host.id.uuidString + "|") else { return }
        let reports = SessionStatusService.reports(for: sessions, projects: projects, preferences: preferences)
        guard let report = reports.first(where: { $0.entity.id == tracked.attributes.sessionID }),
              let session = sessions.first(where: { AgentSessionEntity($0).id == report.entity.id }) else {
            await end(tracked)
            return
        }
        await observe(session: session, project: report.entity.project, provider: report.entity.agent,
                      branch: report.entity.branch, activity: report.state.rawValue,
                      toolName: tracked.content.state.toolName, optedIn: false, now: now)
    }

    func reconcileHosts(_ hosts: [LiveHost]) async {
        guard let tracked = Activity<SessionWorkingActivityAttributes>.activities.first else { return }
        guard let entity = routes()[tracked.attributes.routeID]?.entity else {
            await end(tracked)
            return
        }
        guard !hosts.contains(where: { $0.id == entity.hostID && $0.muxID == entity.muxID }) else { return }
        await end(tracked)
    }

    func open(routeID: String) throws {
        guard let entity = routes()[routeID]?.entity else {
            throw PhrenKitError.validation("That tracked session is no longer available.")
        }
        try AgentLaunch.openIndexedSession(entity, destination: .chat)
    }

    private func observe(entity: AgentSessionEntity, provider: String?, branch: String?, activity: String,
                         toolName: String?, optedIn: Bool, now: Date) async {
        let normalized = activity.lowercased()
        let tracked = Activity<SessionWorkingActivityAttributes>.activities.first
        let action = SessionWorkingActivityPolicy.action(
            trackedSessionID: tracked?.attributes.sessionID, incomingSessionID: entity.id,
            activity: normalized, optedIn: optedIn, startedAt: tracked?.content.state.startedAt, now: now
        )
        switch action {
        case .none: return
        case .end:
            if let tracked { await end(tracked) }
        case .start:
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            for current in Activity<SessionWorkingActivityAttributes>.activities { await end(current) }
            let routeID = UUID().uuidString
            let expiresAt = now.addingTimeInterval(SessionWorkingActivityPolicy.maximumDuration)
            let content = content(entity: entity, provider: provider, branch: branch, toolName: toolName,
                                  startedAt: now, expiresAt: expiresAt)
            do {
                _ = try Activity.request(
                    attributes: SessionWorkingActivityAttributes(routeID: routeID, sessionID: entity.id),
                    content: ActivityContent(state: content, staleDate: expiresAt, relevanceScore: 0.8),
                    pushType: nil
                )
                var saved = routes(); saved[routeID] = Route(entity: entity); save(saved)
                scheduleTimeout(for: routeID, at: expiresAt)
            } catch { }
        case .update:
            guard let tracked else { return }
            let previous = tracked.content.state
            let content = content(entity: entity, provider: provider, branch: branch, toolName: toolName,
                                  startedAt: previous.startedAt, expiresAt: previous.expiresAt)
            await tracked.update(ActivityContent(state: content, staleDate: previous.expiresAt, relevanceScore: 0.8))
        }
    }

    private func content(entity: AgentSessionEntity, provider: String?, branch: String?, toolName: String?,
                         startedAt: Date, expiresAt: Date) -> SessionWorkingActivityAttributes.ContentState {
        SessionWorkingActivityAttributes.ContentState(
            provider: provider ?? entity.agent ?? "agent", project: entity.project ?? entity.workspace,
            branch: branch ?? entity.branch, toolName: toolName, state: "Working",
            startedAt: startedAt, expiresAt: expiresAt
        )
    }

    private func scheduleTimeout(for routeID: String, at deadline: Date) {
        timeoutTasks[routeID]?.cancel()
        timeoutTasks[routeID] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) }
            catch { return }
            guard let self,
                  let activity = Activity<SessionWorkingActivityAttributes>.activities.first(where: { $0.attributes.routeID == routeID }) else { return }
            await self.end(activity)
        }
    }

    private func end(_ activity: Activity<SessionWorkingActivityAttributes>) async {
        let routeID = activity.attributes.routeID
        timeoutTasks.removeValue(forKey: routeID)?.cancel()
        await activity.end(nil, dismissalPolicy: .immediate)
        var saved = routes(); saved.removeValue(forKey: routeID); save(saved)
    }

    private func routes() -> [String: Route] {
        AppRuntime.defaults.data(forKey: Self.routesKey)
            .flatMap { try? JSONDecoder().decode([String: Route].self, from: $0) } ?? [:]
    }

    private func save(_ routes: [String: Route]) {
        if routes.isEmpty { AppRuntime.defaults.removeObject(forKey: Self.routesKey) }
        else { AppRuntime.defaults.set(try? JSONEncoder().encode(routes), forKey: Self.routesKey) }
    }
}
