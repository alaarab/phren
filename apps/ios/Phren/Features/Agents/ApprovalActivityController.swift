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
            let record = try await store.save(.init(id: UUID().uuidString, actionID: approval.id, host: session.host,
                                                    target: target, expiresAt: min(expiration, Date().addingTimeInterval(55))))
            guard run == generation, !wasHandled(approval, target: target) else { await remove(target: target, actionID: approval.id); return }
            let content = ActivityContent(state: ApprovalActivityAttributes.ContentState(
                provider: target.providerName, project: String(session.workspaceName.prefix(80)), host: String(session.host.name.prefix(80)),
                explanation: String((approval.explanation ?? approval.title ?? "Allow this action?").prefix(500)), expiresAt: record.expiresAt),
                staleDate: record.expiresAt)
            if let existing = Activity<ApprovalActivityAttributes>.activities.first(where: { $0.attributes.requestID == record.id }) {
                await existing.update(content)
            } else {
                _ = try Activity.request(attributes: ApprovalActivityAttributes(requestID: record.id), content: content, pushType: nil)
            }
            observed[target] = (approval.id, record.expiresAt)
        } catch {
            // Live Activities are optional. The authenticated in-app controls
            // remain usable if the system disables them or reaches its limit.
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
                                                    target: record.target, actionID: record.actionID, approve: approve)
            message = approve ? "Approval sent." : "Denial sent."
        } catch {
            await end([requestID])
            message = "Answer wasn't confirmed. Open the conversation or terminal to check the current request. The answer has not been retried."
        }
    }

    func clear() async {
        generation = UUID(); observed.removeAll(); handled.removeAll()
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
