import ActivityKit
import Observation
import PhrenKit
import PhrenLive
import UIKit

@MainActor @Observable
final class ApprovalActivityController {
    static let shared = ApprovalActivityController()
    var message: String?
    @ObservationIgnored private let store = ApprovalRequestStore()
    @ObservationIgnored private var observed: [AgentChatTarget: (actionID: String, expiresAt: Date)] = [:]
    @ObservationIgnored private var handled: [String: Date] = [:]
    @ObservationIgnored private var generation = UUID()
    /// Where an activity's Open lands: the session behind each request, so a
    /// question opens its own conversation rather than the Agents tab.
    @ObservationIgnored private var routes: [String: AgentSessionEntity] = [:]

    func wasHandled(_ approval: AgentApproval, target: AgentChatTarget) -> Bool {
        (handled[key(target, approval.id)] ?? .distantPast) > .now
    }

    func sync(_ approval: AgentApproval?, session: LiveAgentSession, target: AgentChatTarget) async {
        #if DEBUG && targetEnvironment(simulator)
        guard !AppRuntime.isUITesting || ProcessInfo.processInfo.arguments.contains("--approval-live-activity") else { return }
        #endif
        guard UIApplication.shared.applicationState == .active else { return }
        handled = handled.filter { $0.value > .now }
        observed = observed.filter { $0.value.expiresAt > .now }
        guard let approval else {
            if observed[target]?.actionID != "" {
                observed[target] = ("", Date().addingTimeInterval(60))
                await remove(target: target)
            }
            return
        }
        guard !wasHandled(approval, target: target), observed[target]?.actionID != approval.id,
              let expiration = approval.expiration, expiration > .now,
              ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let run = generation
        do {
            if let previous = observed[target] { await remove(target: target, actionID: previous.actionID) }
            let question = approval.questionPrompt
            let record = try await store.save(.init(id: UUID().uuidString, actionID: approval.id, host: session.host,
                                                    target: target, expiresAt: expiration, question: question != nil))
            guard run == generation, !wasHandled(approval, target: target) else { await remove(target: target, actionID: approval.id); return }
            let live = Set(Activity<ApprovalActivityAttributes>.activities.map { $0.attributes.requestID })
            routes = routes.filter { $0.key == record.id || live.contains($0.key) }
            routes[record.id] = AgentSessionEntity(session)
            let content = ActivityContent(state: ApprovalActivityAttributes.ContentState(
                provider: target.providerName, project: String(session.projectDisplayName(nil).prefix(80)), host: String(session.host.name.prefix(80)),
                explanation: String((question?.questions.first?.question ?? approval.explanation ?? approval.title ?? "Allow this action?").prefix(500)),
                expiresAt: record.expiresAt, question: question != nil),
                // A permission request outranks the working summary for the
                // island: the system shows the most relevant activity there.
                staleDate: record.expiresAt, relevanceScore: 1)
            if let existing = Activity<ApprovalActivityAttributes>.activities.first(where: { $0.attributes.requestID == record.id }) {
                await existing.update(content)
            } else if IntegrationSettings.enabled(IntegrationSettings.liveActivityKey) { // Settings → Notifications
                _ = try Activity.request(attributes: ApprovalActivityAttributes(requestID: record.id), content: content, pushType: nil)
            }
            observed[target] = (approval.id, record.expiresAt)
        } catch {
            // Live Activities are optional. The authenticated in-app controls
            // remain usable if the system disables them or reaches its limit.
        }
    }

    /// A staleDate changes presentation; it does not dismiss the activity.
    /// Sweep ActivityKit itself because a prior store save can prune expired
    /// records, and a cold launch has no in-memory observed targets.
    func retireExpired(now: Date = .now) async {
        let expired = Activity<ApprovalActivityAttributes>.activities.filter { $0.content.state.expiresAt <= now }
        await end(expired.map { $0.attributes.requestID })
        observed = observed.filter { $0.value.expiresAt > now }
    }

    func reconcile(host: LiveHost, sessions: [LiveAgentSession]) async {
        guard !Task.isCancelled, UIApplication.shared.applicationState == .active else { return }
        await retireExpired()
        for record in (try? await store.records()) ?? [] {
            guard !Task.isCancelled else { return }
            if ApprovalRequestStore.obsolete(record, host: host, sessions: sessions) {
                observed.removeValue(forKey: record.target)
                await remove(target: record.target, actionID: record.actionID)
            }
        }
    }

    func answered(target: AgentChatTarget, actionID: String) async {
        handled[key(target, actionID)] = Date().addingTimeInterval(60)
        observed.removeValue(forKey: target)
        await remove(target: target, actionID: actionID)
    }

    func answer(requestID: String, approve: Bool) async {
        guard UUID(uuidString: requestID) != nil else { message = "This permission request is invalid."; return }
        let run = generation
        do {
            let preferences = try LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
            let record = try await store.claim(requestID, preferences: preferences)
            guard run == generation else { return }
            if record.question == true, approve {
                // The claimed record is spent, but the question itself is still
                // pending on the computer: the conversation shows it to answer.
                observed.removeValue(forKey: record.target)
                await end([requestID]); open(requestID: record.id)
                message = "\(record.target.providerName) has a question. Choose the answer in the conversation."
                return
            }
            handled[key(record.target, record.actionID)] = Date().addingTimeInterval(60)
            observed.removeValue(forKey: record.target)
            await end([requestID])
            guard run == generation else { return }
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                AgentChatFixture.answered = true; AgentChatFixture.denied = !approve
                message = approve ? "Approval sent." : "Denial sent."
                return
            }
            #endif
            try await PhrenConnection.answerApproval(host: record.host, privateKey: DeviceSSHKey.load(record.host.id),
                                                    target: record.target, actionID: record.actionID, approve: approve,
                                                    decision: approve ? .approve : .deny)
            message = approve ? "Approval sent." : "Denial sent."
        } catch {
            await end([requestID])
            message = "Answer wasn't confirmed. Open the conversation or terminal to check the current request. The answer has not been retried."
        }
    }

    /// An activity's Open (`phren://approval?request=`): the conversation the
    /// request came from, or the Agents tab when it is no longer known.
    func open(requestID: String) {
        AppModel.current?.selectedTab = .agents
        guard let entity = routes[requestID] else { return }
        try? AgentLaunch.openIndexedSession(entity, destination: .chat)
    }
    func clear() async {
        generation = UUID(); observed.removeAll(); handled.removeAll(); routes.removeAll()
        _ = try? await store.remove()
        await end(Activity<ApprovalActivityAttributes>.activities.map { $0.attributes.requestID })
    }
    private func key(_ target: AgentChatTarget, _ actionID: String) -> String { target.id + "/" + actionID }
    private func remove(target: AgentChatTarget, actionID: String? = nil) async {
        if let ids = try? await store.remove(target: target, actionID: actionID) { await end(ids) }
    }
    private func end(_ ids: [String]) async {
        for activity in Activity<ApprovalActivityAttributes>.activities where ids.contains(activity.attributes.requestID) {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}
