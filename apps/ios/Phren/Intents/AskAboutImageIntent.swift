import AppIntents
import PhrenKit
import PhrenLive
import UniformTypeIdentifiers

@MainActor
enum AskAboutImageRouting {
    static func resolve(_ requested: AgentSessionEntity?, sessions: [LiveAgentSession],
                        projects: [ProjectEntity], preferences: LiveSessionPreferences?) -> LiveAgentSession? {
        let reports = SessionStatusService.reports(for: sessions, projects: projects, preferences: preferences)
        guard let report = SessionStatusService.resolve(requested, among: reports) else { return nil }
        return sessions.first { AgentSessionEntity($0).id == report.entity.id }
    }
}

/// Receives an image from Shortcuts or a Screenshots image
/// action and opens it as an unsent chat draft in the chosen live session.
struct AskAboutImageIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask an Agent About an Image"
    static var description = IntentDescription(
        "Opens a terminal screenshot, error, or diff in a live agent chat for review before sending.",
        categoryName: "Agents", searchKeywords: ["image", "screenshot", "error", "diff", "agent"])
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    // The `supportedContentTypes:` / `inputConnectionBehavior:` initializer
    // is iOS 18+; the app deploys to 17, where the UTI-string form is the
    // one that exists. Shortcuts still hands the previous action's image to
    // the only file parameter, and the picker covers the rest.
    @Parameter(title: "Image", description: "A screenshot or photo to discuss",
               supportedTypeIdentifiers: ["public.image"], requestValueDialog: "Which image?")
    var image: IntentFile

    @Parameter(title: "Session", description: "The live agent to ask")
    var session: AgentSessionEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Ask “\(\.$session)” about \(\.$image)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let sessions = await AgentSessions.current()
        let projects = await SpotlightProjects.current()
        let preferences = try? LiveSessionPreferences.read(
            AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()
        )
        guard let target = AskAboutImageRouting.resolve(session, sessions: sessions,
                                                        projects: projects, preferences: preferences) else {
            return .result(dialog: "No live agent session is available. Start one in Phren first.")
        }
        let attachment = try await ChatAttachmentPreparation.preparedImage(image.data, name: image.filename)
        try AgentLaunch.setPending(
            target, draft: "What should I know about this image?", attachments: [attachment]
        )
        return .result(dialog: "Opening the image in \(target.projectDisplayName(nil)) on \(target.host.name) for review.")
    }
}
