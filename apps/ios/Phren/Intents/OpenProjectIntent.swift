import AppIntents
import PhrenKit
import PhrenLive

/// "Hey Siri, open mina in Phren" — the chat for that project's session,
/// started first when nothing is running there.
struct OpenProjectIntent: AppIntent {
    static var title: LocalizedStringResource = "Open a Session"
    static var description = IntentDescription(
        "Opens the chat for an agent session on one of your computers, starting the agent in the project first when none is running.",
        categoryName: "Agents", searchKeywords: ["open", "start", "session", "workspace", "agent", "project"])
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session", requestValueDialog: "Which project or session?")
    var session: AgentSessionEntity

    static var parameterSummary: some ParameterSummary { Summary("Open \(\.$session)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let resolved = try await AgentSessions.resolve(session)
        AgentLaunch.setPending(resolved.session)
        AppModel.current?.selectedTab = .agents
        AppModel.current?.pendingChatVersion += 1
        return .result(dialog: resolved.started
            ? "Started \(AgentLaunch.defaultHarness.title) in \(session.workspace) on \(session.computer)."
            : "Opening \(session.workspace) on \(session.computer).")
    }
}
