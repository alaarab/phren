import AppIntents
import PhrenKit

/// Spotlight uses OpenIntent's target to associate a result with navigation.
/// The original OpenProjectIntent remains the Siri start-or-open workflow.
struct OpenAgentSessionIntent: OpenIntent {
    static var title: LocalizedStringResource = "Open Chat"
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session") var target: AgentSessionEntity

    init() {}
    init(target: AgentSessionEntity) { self.target = target }

    @MainActor
    func perform() async throws -> some IntentResult {
        try AgentLaunch.openIndexedSession(target, destination: .chat)
        return .result()
    }
}

struct OpenSessionTerminalIntent: AppIntent {
    static var title: LocalizedStringResource = "Open terminal"
    static var description = IntentDescription("Opens the terminal for an agent session on your computer.", categoryName: "Agents")
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session", requestValueDialog: "Which session?") var session: AgentSessionEntity
    static var parameterSummary: some ParameterSummary { Summary("Open terminal for \(\.$session)") }

    @MainActor
    func perform() async throws -> some IntentResult {
        if session.isLive { try AgentLaunch.openIndexedSession(session, destination: .terminal) }
        else { AgentLaunch.setPending(try await AgentSessions.resolve(session).session, destination: .terminal) }
        return .result()
    }
}

struct OpenPhrenProjectIntent: OpenIntent {
    static var title: LocalizedStringResource = "Open Project"
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Project") var target: ProjectEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        let projects = await SpotlightProjects.current()
        guard projects.contains(where: { $0.id == target.id }) else { throw PhrenCaptureError.unknownProject(target.project) }
        let live = await AgentSessions.current()
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        if let session = SpotlightProjects.runningSession(for: target, among: live, projects: projects, preferences: preferences) {
            AgentLaunch.setPending(session)
        } else {
            AgentLaunch.setPendingProject(storeID: target.storeId, project: target.project)
        }
        return .result()
    }
}
