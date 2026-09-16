import AppIntents
import PhrenKit

/// The phrases Siri answers to out of the box — no setup in the Shortcuts app.
/// iOS allows ten; Pin Session lost its phrase to Dictate (the intent is
/// still in the Shortcuts app, and pinning only orders the activity's rows).
///
/// Every phrase has to contain `\(.applicationName)`; Siri keys on the app
/// name to route the utterance, and a phrase without it is rejected at build
/// time. The app name it accepts is not only "Phren": `INAlternativeAppNames`
/// in Info.plist adds "Fren" and "Friend", because that is what dictation
/// hears roughly every other time.
///
/// The parameterized variants ("…to alpha lens in phren") resolve the project
/// through `ProjectEntityQuery.entities(matching:)`; the plain ones fall back
/// to the last project anything was captured into.
struct PhrenAppShortcuts: AppShortcutsProvider {
    @AppShortcutsBuilder
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddPhrenTaskIntent(),
            phrases: [
                "Add a task to \(.applicationName)",
                "Add a \(.applicationName) task",
                "New \(.applicationName) task",
                "Queue a task in \(.applicationName)",
                "Add a task to \(\.$project) in \(.applicationName)",
            ],
            shortTitle: "Add Task",
            systemImageName: "checklist"
        )
        AppShortcut(
            intent: AddPhrenNoteIntent(),
            phrases: [
                "Add a note to \(.applicationName)",
                "Add a \(.applicationName) note",
                "New \(.applicationName) note",
                "Capture a thought in \(.applicationName)",
                "Add a note to \(\.$project) in \(.applicationName)",
            ],
            shortTitle: "Add Note",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: MessageAgentIntent(),
            phrases: [
                "Message \(\.$session) in \(.applicationName)",
                "Tell \(\.$session) in \(.applicationName)",
                "Send a message to \(\.$session) in \(.applicationName)",
                "Message an agent in \(.applicationName)",
                "Message my agent in \(.applicationName)",
                "Talk to my agent in \(.applicationName)",
            ],
            shortTitle: "Message",
            systemImageName: "bubble.left.and.text.bubble.right",
            parameterPresentation: ParameterPresentation(for: \.$session, summary: Summary("Message \(\.$session)")) {
                OptionsCollection(AgentSessionEntityQuery(), title: "Sessions", systemImageName: "terminal")
            }
        )
        AppShortcut(
            intent: OpenSessionTerminalIntent(),
            phrases: [
                "Open terminal for \(\.$session) in \(.applicationName)",
                "Open terminal in \(.applicationName)",
            ],
            shortTitle: "Open terminal",
            systemImageName: "terminal",
            parameterPresentation: ParameterPresentation(for: \.$session, summary: Summary("Open terminal for \(\.$session)")) {
                OptionsCollection(AgentSessionEntityQuery(), title: "Sessions", systemImageName: "terminal")
            }
        )
        AppShortcut(
            intent: OpenProjectIntent(),
            phrases: [
                "Open \(\.$session) in \(.applicationName)",
                "Start \(\.$session) in \(.applicationName)",
                "Open a session in \(.applicationName)",
                "Start a session in \(.applicationName)",
            ],
            shortTitle: "Open Session",
            systemImageName: "play.circle"
        )
        AppShortcut(
            intent: StartSessionIntent(),
            phrases: [
                "Start an agent for \(\.$project) in \(.applicationName)",
                "Start an agent in \(.applicationName)",
            ],
            shortTitle: "Start Agent",
            systemImageName: "play.rectangle"
        )
        AppShortcut(
            intent: SessionStatusIntent(),
            phrases: [
                "What is \(.applicationName) doing",
                "What is happening in \(.applicationName)",
                "Is \(\.$session) done in \(.applicationName)",
                "What is \(\.$session) doing in \(.applicationName)",
            ],
            shortTitle: "Session Status",
            systemImageName: "waveform.path.ecg"
        )
        AppShortcut(
            intent: ListWaitingSessionsIntent(),
            phrases: [
                "Which sessions are waiting in \(.applicationName)",
                "What needs me in \(.applicationName)",
            ],
            shortTitle: "Waiting Sessions",
            systemImageName: "person.crop.circle.badge.questionmark"
        )
        AppShortcut(
            intent: DictateToSessionIntent(),
            phrases: [
                "Talk to \(.applicationName)",
                "Dictate to \(.applicationName)",
                "Dictate to \(\.$session) in \(.applicationName)",
            ],
            shortTitle: "Dictate to Session",
            systemImageName: "mic.circle"
        )
        AppShortcut(
            intent: AskAboutImageIntent(),
            phrases: [
                "Ask \(.applicationName) about this",
                "Ask \(.applicationName) about this image",
                "Ask \(.applicationName) about a screenshot",
                "Show this image to \(.applicationName)",
                "Ask \(\.$session) about an image in \(.applicationName)",
            ],
            shortTitle: "Ask About Image",
            systemImageName: "photo.badge.arrow.down"
        )
    }
}

extension PhrenAppShortcuts {
    /// The project list Siri last had donated to it, so the ~7s live poll
    /// doesn't re-donate an unchanged list every cycle.
    @MainActor private static var donatedProjects: [String]?
    @MainActor private static var donatedSessions: [String]?

    /// Makes the live sessions speakable ("message phren on mini in phren")
    /// whenever the Agents screen has a fresh set of them.
    @MainActor
    static func donateSessions(_ sessions: [LiveAgentSession]) {
        let ids = sessions.filter { $0.tab.agent != nil }.map { AgentSessionEntity($0).id }.sorted()
        guard ids != donatedSessions else { return }
        donatedSessions = ids
        updateAppShortcutParameters()
    }

    /// Re-donates project names when the set actually changes, so a project
    /// created on another machine becomes speakable ("…to alpha lens in
    /// phren") as soon as it syncs down. Called from `AppModel.refresh()`,
    /// alongside the widget snapshot, for the same reason: that is where each
    /// sync generation's parsed state settles.
    @MainActor
    static func donateProjects(from model: AppModel) {
        // Deliberately not `model.writableProjects`, which honours the UI's
        // store filter: what Siri can hear must not narrow because the user
        // filtered a list on screen.
        let projects = model.storeContexts
            .filter(\.descriptor.canPush)
            .flatMap { context in
                context.snapshot.projects
                    .filter { !LocalStore.isReadOnlyProject($0.name) }
                    .map { "\(context.id)|\($0.name)" }
            }
            .sorted()
        guard projects != donatedProjects else { return }
        donatedProjects = projects
        updateAppShortcutParameters()
    }

    @MainActor
    static func donateOpen(_ session: LiveAgentSession) {
        let entity = AgentSessionEntity(session)
        Task {
            guard await IntentDonationGate.shared.shouldDonate("open-chat|\(entity.id)") else { return }
            _ = try? await OpenAgentSessionIntent(target: entity).donate()
        }
    }

    static func donateMessage(to session: LiveAgentSession) {
        let entity = AgentSessionEntity(session)
        Task {
            guard await IntentDonationGate.shared.shouldDonate("message|\(entity.id)") else { return }
            _ = try? await MessageAgentIntent.suggestion(session: entity).donate()
        }
    }
}
