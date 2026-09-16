import AppIntents
import Foundation
import PhrenKit

/// The Action button's job: open the session you were last talking to with
/// the microphone already listening. "Last" is the session that changed most
/// recently across your computers (a waiting one wins), the same order the
/// agent drawer uses; the app is reached through the pending-open handoff
/// Siri and Spotlight share, so nothing here touches a connection itself.
struct DictateToSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Dictate to Last Session"
    static var description = IntentDescription("Opens the session you used most recently and starts dictating a message.", categoryName: "Agents")
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session", requestValueDialog: "Which session?")
    var session: AgentSessionEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Dictate to \(\.$session)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let live = await AgentSessions.current()
        let chosen: LiveAgentSession?
        if let session {
            chosen = live.first { AgentSessionEntity($0).id == session.id }
        } else {
            chosen = Self.lastUsed(live)
        }
        guard let chosen else {
            return .result(dialog: session == nil ? "No agent session is running on your computers." : "That session is not running any more.")
        }
        AgentLaunch.setPending(chosen, destination: .dictate)
        return .result(dialog: "Listening for \(chosen.tab.displayTitle).")
    }

    /// A session waiting on you outranks recency; otherwise the most recently
    /// changed session, which is where the conversation is.
    static func lastUsed(_ sessions: [LiveAgentSession]) -> LiveAgentSession? {
        let ordered = SessionRecency.ordered(sessions)
        return ordered.first { ($0.tab.agentStatus ?? "").lowercased() == "blocked" || ($0.tab.agentStatus ?? "").lowercased() == "waiting" } ?? ordered.first
    }
}
