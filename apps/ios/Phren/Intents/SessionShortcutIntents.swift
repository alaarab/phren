import AppIntents
import Foundation
import PhrenKit
import PhrenLive

struct SessionStatusEntity: AppEntity, Equatable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Session status")
    static var defaultQuery = SessionStatusEntityQuery()

    let id: String
    @Property(title: "State") var state: String
    @Property(title: "Project") var project: String
    @Property(title: "Computer") var computer: String
    @Property(title: "Harness") var harness: String
    @Property(title: "Last line") var lastLine: String?
    @Property(title: "Branch") var branch: String?

    init(report: SessionStatusReport) {
        id = report.entity.id
        state = report.state.rawValue
        project = report.projectName
        computer = report.entity.computer
        harness = report.harnessName
        lastLine = report.lastAssistantLine
        branch = report.entity.branch
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(harness) on \(project)", subtitle: "\(state.capitalized) · \(computer)")
    }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.state == rhs.state && lhs.project == rhs.project && lhs.computer == rhs.computer
            && lhs.harness == rhs.harness && lhs.lastLine == rhs.lastLine && lhs.branch == rhs.branch
    }
}

struct SessionStatusEntityQuery: EntityQuery {
    func entities(for identifiers: [SessionStatusEntity.ID]) async throws -> [SessionStatusEntity] {
        let wanted = Set(identifiers)
        let live = await AgentSessions.current()
        let projects = await SpotlightProjects.current()
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        return await SessionStatusService.reports(for: live, projects: projects, preferences: preferences)
            .filter { wanted.contains($0.entity.id) }.map(SessionStatusEntity.init(report:))
    }
    func suggestedEntities() async throws -> [SessionStatusEntity] { [] }
}

enum SessionTranscriptText {
    static let maximumLines = 200
    static func tail(_ messages: [AgentChatMessage], lines requested: Int) -> String {
        let count = min(max(1, requested), maximumLines)
        let rendered = messages.suffix(count).map { message -> String in
            let limit = message.role == .tool ? SessionSummaryPrompt.maximumToolCharacters : SessionSummaryPrompt.maximumMessageCharacters
            let clean = message.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            let body = clean.count > limit ? String(clean.prefix(limit)) + "…" : clean
            let label = message.title.map { "\(message.role.rawValue) (\($0))" } ?? message.role.rawValue
            return "\(label): \(body)"
        }.joined(separator: "\n")
        return rendered.count > SessionSummaryPrompt.maximumPromptCharacters
            ? String(rendered.suffix(SessionSummaryPrompt.maximumPromptCharacters)) : rendered
    }
}

struct SessionTranscriptIntent: AppIntent {
    static var title: LocalizedStringResource = "Get Session Transcript"
    static var description = IntentDescription("Returns a bounded tail of a live agent transcript as text for use in Shortcuts.", categoryName: "Agents")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session") var session: AgentSessionEntity
    @Parameter(title: "Lines", default: 40, inclusiveRange: (1, 200)) var lines: Int
    static var parameterSummary: some ParameterSummary { Summary("Get the last \(\.$lines) lines from \(\.$session)") }

    init() {}

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let live = try await AgentSessions.resolve(session).session
        let conversation = try await SessionStatusService.conversation(for: live)
        let value = SessionTranscriptText.tail(conversation.transcript.messages, lines: lines)
        guard !value.isEmpty else { throw PhrenKitError.validation("That session has no visible transcript yet.") }
        return .result(value: value, dialog: "Returned the last \(min(lines, conversation.transcript.messages.count)) transcript lines.")
    }
}

enum AgentReplyWaiter {
    static func wait(timeout: Duration, pollInterval: Duration = .seconds(2),
                     source: @escaping @Sendable () async throws -> String?) async throws -> String {
        let clock = ContinuousClock(), deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if let reply = try await source(), !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return reply }
            let remaining = clock.now.duration(to: deadline)
            if remaining <= .zero { break }
            try await Task.sleep(for: min(pollInterval, remaining))
        }
        throw PhrenKitError.validation("The agent did not reply before the wait timed out.")
    }
}

struct MessageAndWaitIntent: AppIntent {
    static var title: LocalizedStringResource = "Message Agent and Wait"
    static var description = IntentDescription("Sends a message, waits up to five minutes, and returns the agent's next reply as text.", categoryName: "Agents")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session") var session: AgentSessionEntity
    @Parameter(title: "Message") var message: String
    @Parameter(title: "Timeout in seconds", default: 120, inclusiveRange: (1, 300)) var timeout: Int
    static var parameterSummary: some ParameterSummary { Summary("Message \(\.$session) and wait up to \(\.$timeout) seconds") }

    init() {}

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let text = SpeechSettings.apply(message.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !text.isEmpty else { throw $message.needsValueError("What should I tell it?") }
        guard (1...300).contains(timeout) else { throw PhrenKitError.validation("Choose a timeout from 1 second through 5 minutes.") }
        let delivery = try await AgentMessageService.prepare(session)
        let before = (try? await SessionStatusService.transcript(session: delivery.session, target: delivery.target))?.messages
            .filter { $0.role == .assistant }.map(\.line).max() ?? -1
        try await AgentMessageService.send(text, delivery: delivery)
        let reply = try await AgentReplyWaiter.wait(timeout: .seconds(timeout)) {
            let transcript = try await SessionStatusService.transcript(session: delivery.session, target: delivery.target)
            guard let text = transcript.messages.last(where: { $0.role == .assistant && $0.line > before })?.text else {
                return nil
            }
            return SessionStatusText.cleanedAssistantLine(text)
        }
        return .result(value: reply, dialog: "\(delivery.target.providerName) replied: \(reply)")
    }
}

enum SessionHarness: String, AppEnum {
    case codex, claude, copilot, opencode
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Agent harness")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .codex: "Codex", .claude: "Claude Code", .copilot: "GitHub Copilot", .opencode: "opencode",
    ]
    var launchKind: PhrenConnection.LaunchKind { .init(rawValue: rawValue)! }
}

struct SessionComputerEntity: AppEntity, Equatable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Computer")
    static var defaultQuery = SessionComputerQuery()
    let id: UUID
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", image: .init(systemName: "desktopcomputer")) }
}

struct SessionComputerQuery: EntityStringQuery {
    func entities(for identifiers: [UUID]) async throws -> [SessionComputerEntity] {
        let wanted = Set(identifiers); return await AgentSessions.hosts.filter { wanted.contains($0.id) }.map { .init(id: $0.id, name: $0.name) }
    }
    func suggestedEntities() async throws -> [SessionComputerEntity] { await AgentSessions.hosts.map { .init(id: $0.id, name: $0.name) } }
    func entities(matching string: String) async throws -> [SessionComputerEntity] {
        let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await suggestedEntities().filter { needle.isEmpty || $0.name.localizedCaseInsensitiveContains(needle) }
    }
}

struct StartSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Agent Session"
    static var description = IntentDescription("Starts a selected coding-agent harness for a project on a saved computer and returns the new session.", categoryName: "Agents")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Project") var project: ProjectEntity
    @Parameter(title: "Computer") var computer: SessionComputerEntity
    @Parameter(title: "Harness") var harness: SessionHarness
    static var parameterSummary: some ParameterSummary { Summary("Start \(\.$harness) for \(\.$project) on \(\.$computer)") }

    init() { harness = .codex }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<AgentSessionEntity> & ProvidesDialog {
        guard let host = AgentSessions.hosts.first(where: { $0.id == computer.id }) else {
            throw PhrenKitError.validation("That computer is no longer saved.")
        }
        guard let cwd = await AgentLaunch.folder(host: host, storeID: project.storeId, project: project.project) else {
            throw PhrenKitError.validation("Couldn't find where \(project.project) lives on \(host.name). Open it once from the project screen.")
        }
        let live = try await AgentLaunch.launch(host: host, cwd: cwd, label: project.project, kind: harness.launchKind)
        AgentLaunch.remember(host: host, cwd: cwd, storeID: project.storeId, project: project.project)
        var value = AgentSessionEntity(live); value.project = project.project; value.projectStoreID = project.storeId
        return .result(value: value, dialog: "Started \(harness.launchKind.title) in \(project.project) on \(host.name).")
    }
}

actor IntentDonationGate {
    static let shared = IntentDonationGate()
    private var donated: [String: Date] = [:]
    func shouldDonate(_ key: String, now: Date = .now) -> Bool {
        donated = donated.filter { now.timeIntervalSince($0.value) < 86_400 }
        guard donated[key] == nil else { return false }
        donated[key] = now; return true
    }
}
