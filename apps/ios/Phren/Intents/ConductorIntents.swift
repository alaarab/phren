import AppIntents
import Foundation
import PhrenKit
import PhrenLive

/// A free-form line Siri dictates. App Shortcut phrases accept only AppEntity
/// parameters, so the message or question travels as an entity that wraps the
/// spoken string; the query echoes whatever was heard.
struct SpokenLine: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Message")
    static var defaultQuery = SpokenLineQuery()
    let id: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(id)") }
}

struct SpokenLineQuery: EntityStringQuery {
    func entities(for identifiers: [SpokenLine.ID]) async throws -> [SpokenLine] {
        identifiers.map { SpokenLine(id: $0) }
    }
    func suggestedEntities() async throws -> [SpokenLine] { [] }
    func entities(matching string: String) async throws -> [SpokenLine] {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? [] : [SpokenLine(id: trimmed)]
    }
}

/// The one conductor on the connected computers: the first tab the Hook marks
/// with `role: "conductor"`. Pure so fixtures cover the lookup without SSH.
enum ConductorSession {
    static func find(in sessions: [LiveAgentSession]) -> LiveAgentSession? {
        sessions.first { $0.tab.isConductor }
    }

    @MainActor
    static func current() async -> LiveAgentSession? {
        find(in: await AgentSessions.current())
    }
}

/// The conductor's next assistant line, bounded for speech. Sends sit on the
/// ordinary `/v1/prompt` path, so a reply is the next assistant row past the
/// line the phone saw before it asked.
enum ConductorReply {
    static let spokenLimit = 300

    static func next(in messages: [AgentChatMessage], after line: Int) -> String? {
        guard let message = messages.first(where: { $0.role == .assistant && $0.line > line }) else { return nil }
        let cleaned = message.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(spokenLimit))
    }
}

/// The overview counts ConductorStatusIntent speaks: how many sessions are
/// working, waiting and idle, plus the conductor's current step when there is
/// one. Pure for the same reason.
enum ConductorOverviewText {
    static func dialog(sessions: [LiveAgentSession]) -> String {
        guard !sessions.isEmpty else { return "No agent sessions are running." }
        func count(_ activity: LiveWorkspaces.Tab.Activity) -> Int {
            sessions.filter { $0.tab.activity == activity }.count
        }
        var sentence = "\(count(.working)) working, \(count(.waiting)) waiting, \(count(.idle)) idle."
        if let step = sessions.first(where: { $0.tab.isConductor })?.tab.currentStep,
           !step.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sentence += " Conductor: \(step)."
        }
        return sentence
    }
}

/// Resolves the conductor's chat pane and delivers a line through the same
/// `/v1/prompt` path the composer uses. `baseline` is the newest assistant
/// line before the send, so a caller can tell the next reply apart.
@MainActor
enum ConductorDelivery {
    static func conversation(for session: LiveAgentSession) async throws -> (target: AgentChatTarget, baseline: Int) {
        let conversation = try await SessionStatusService.conversation(for: session)
        let baseline = conversation.transcript.messages.filter { $0.role == .assistant }.map(\.line).max() ?? -1
        return (conversation.target, baseline)
    }

    static func send(_ text: String, to session: LiveAgentSession, target: AgentChatTarget) async throws {
        try await PhrenConnection.sendChat(host: session.host, privateKey: DeviceSSHKey.load(session.host.id),
                                           target: target, text: text)
    }
}

/// "Hey Siri, tell my conductor to run the checks": the Action button can run
/// the same shortcut. Finds the running conductor and sends one line to it.
struct TellConductorIntent: AppIntent {
    static var title: LocalizedStringResource = "Tell my conductor"
    static var description = IntentDescription(
        "Sends a message to your running conductor session, as if typed into its chat.",
        categoryName: "Agents", searchKeywords: ["conductor", "dispatch", "tell", "message", "siri"])
    static var openAppWhenRun = false
    /// Steering a conductor on your computer is not a locked-phone action.
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Message", requestValueDialog: "What should I tell the conductor?")
    var message: SpokenLine

    static var parameterSummary: some ParameterSummary { Summary("Tell my conductor \(\.$message)") }

    init() {}
    init(message: SpokenLine) { self.message = message }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = SpeechSettings.apply(message.id.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !text.isEmpty else { throw $message.needsValueError("What should I tell the conductor?") }
        guard let conductor = await ConductorSession.current() else {
            return .result(dialog: "No conductor is running; open Phren to start one")
        }
        let delivery = try await ConductorDelivery.conversation(for: conductor)
        try await ConductorDelivery.send(text, to: conductor, target: delivery.target)
        return .result(dialog: "Sent to the conductor on \(conductor.host.name)")
    }
}

/// "Hey Siri, ask my conductor whether the checks passed": sends the question
/// and waits up to 20 seconds for the conductor's next assistant line, then
/// speaks its first 300 characters.
struct AskConductorIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask my conductor"
    static var description = IntentDescription(
        "Asks your running conductor a question and speaks its next reply.",
        categoryName: "Agents", searchKeywords: ["conductor", "ask", "question", "siri"])
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Question", requestValueDialog: "What should I ask the conductor?")
    var question: SpokenLine

    static var parameterSummary: some ParameterSummary { Summary("Ask my conductor \(\.$question)") }

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = SpeechSettings.apply(question.id.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !text.isEmpty else { throw $question.needsValueError("What should I ask the conductor?") }
        guard let conductor = await ConductorSession.current() else {
            return .result(dialog: "No conductor is running; open Phren to start one")
        }
        let delivery = try await ConductorDelivery.conversation(for: conductor)
        try await ConductorDelivery.send(text, to: conductor, target: delivery.target)
        let reply = try? await AgentReplyWaiter.wait(timeout: .seconds(20)) {
            let transcript = try await SessionStatusService.transcript(session: conductor, target: delivery.target)
            return ConductorReply.next(in: transcript.messages, after: delivery.baseline)
        }
        guard let reply else {
            return .result(dialog: "The conductor is thinking; open Phren to read the answer")
        }
        return .result(dialog: "\(reply)")
    }
}

/// "Hey Siri, what is phren doing": the counts from the overview and the
/// conductor's current step, without opening the app.
struct ConductorStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "What is Phren doing"
    static var description = IntentDescription(
        "Speaks how many agent sessions are working, waiting or idle, and what your conductor is doing.",
        categoryName: "Agents", searchKeywords: ["conductor", "status", "overview", "working", "waiting"])
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let sessions = await AgentSessions.current()
        return .result(dialog: "\(ConductorOverviewText.dialog(sessions: sessions))")
    }
}