import AppIntents
import PhrenKit
import PhrenLive
import SwiftUI

struct SessionStatusReport: Equatable {
    enum State: String, Equatable {
        case working, waiting, idle, done, error, unknown

        init(_ activity: LiveWorkspaces.Tab.Activity) {
            switch activity {
            case .working: self = .working
            case .waiting: self = .waiting
            case .idle: self = .idle
            case .done: self = .done
            case .error: self = .error
            case .unknown: self = .unknown
            }
        }

        var displayName: String {
            switch self {
            case .working: "Working"
            case .waiting: "Waiting"
            case .idle: "Idle"
            case .done: "Done"
            case .error: "Needs attention"
            case .unknown: "Status unavailable"
            }
        }
    }

    let entity: AgentSessionEntity
    let state: State
    let lastAssistantLine: String?
    let approvalRequestID: String?
    let approvalTitle: String?
    /// Claude Code's AskUserQuestion: answered in the app, never approved
    /// blind from Siri or Spotlight.
    var approvalIsQuestion = false
    var awaySummary: AwaySummary? = nil

    var projectName: String { entity.project ?? entity.workspace }
    var harnessName: String { entity.harnessName ?? "Agent" }
    var branchLine: String { [projectName, entity.branch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }
}

enum SessionStatusText {
    static let spokenLineLimit = 180

    static func cleanedAssistantLine(_ value: String?) -> String? {
        guard let value else { return nil }
        let cleaned = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : String(cleaned.prefix(500))
    }

    static func dialog(for report: SessionStatusReport) -> String {
        let subject = "\(report.harnessName) on \(report.projectName) at \(report.entity.computer)"
        let status: String
        switch report.state {
        case .working: status = "is working"
        case .waiting: status = report.approvalRequestID == nil ? "is waiting for input" : report.approvalIsQuestion ? "has a question for you" : "is waiting for your approval"
        case .idle: status = "is idle"
        case .done: status = "is done"
        case .error: status = "needs attention"
        case .unknown: status = "has no current status"
        }
        let cachedSummary = cleanedAssistantLine(report.awaySummary?.conciseLine)
        let lastUpdate = cachedSummary.map { "Away summary: \($0)" } ?? cleanedAssistantLine(report.lastAssistantLine)
        guard let line = lastUpdate, line.count <= spokenLineLimit else {
            return "\(subject) \(status)."
        }
        return "\(subject) \(status). Last update: \(line)"
    }

    static func waiting(_ reports: [SessionStatusReport]) -> [SessionStatusReport] {
        reports.filter { $0.state == .waiting }
    }

    static func waitingDialog(_ reports: [SessionStatusReport]) -> String {
        let waiting = waiting(reports)
        guard !waiting.isEmpty else { return "No sessions are waiting for input or approval." }
        let names = waiting.prefix(5).map { "\($0.harnessName) on \($0.projectName) at \($0.entity.computer)" }
        let suffix = waiting.count > names.count ? ", and \(waiting.count - names.count) more" : ""
        return waiting.count == 1
            ? "One session is waiting: \(names[0])."
            : "\(waiting.count) sessions are waiting: \(names.joined(separator: ", "))\(suffix)."
    }
}

@MainActor
enum SessionStatusService {
    struct Detail {
        var lastAssistantLine: String?
        var approval: AgentApproval?
        var target: AgentChatTarget?
    }

    static func reports(for sessions: [LiveAgentSession], projects: [ProjectEntity],
                        preferences: LiveSessionPreferences?) -> [SessionStatusReport] {
        let choices = projects.map { SessionProject(storeID: $0.storeId, name: $0.project) }
        return sessions.filter { $0.tab.agent != nil }.map { session in
            var entity = AgentSessionEntity(session)
            if let match = preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd, projects: choices) {
                entity.project = match.project.name
                entity.projectStoreID = match.project.storeID
            }
            return SessionStatusReport(entity: entity, state: .init(session.tab.activity),
                                       lastAssistantLine: nil, approvalRequestID: nil, approvalTitle: nil)
        }
    }

    static func mostRelevant(_ reports: [SessionStatusReport]) -> SessionStatusReport? {
        let rank: [SessionStatusReport.State: Int] = [.waiting: 0, .working: 1, .error: 2, .done: 3, .idle: 4, .unknown: 5]
        return reports.sorted {
            let lhs = (rank[$0.state] ?? 6, $0.projectName.lowercased(), $0.entity.computer.lowercased())
            let rhs = (rank[$1.state] ?? 6, $1.projectName.lowercased(), $1.entity.computer.lowercased())
            return lhs < rhs
        }.first
    }

    static func resolve(_ requested: AgentSessionEntity?, among reports: [SessionStatusReport]) -> SessionStatusReport? {
        guard let requested else { return mostRelevant(reports) }
        if let exact = reports.first(where: { $0.entity.id == requested.id }) { return exact }
        return AgentSessionEntityQuery.rank("\(requested.project ?? requested.workspace) \(requested.computer)",
                                            among: reports.map(\.entity)).first
            .flatMap { match in reports.first { $0.entity.id == match.id } }
    }

    static func conversation(for session: LiveAgentSession) async throws -> (target: AgentChatTarget, transcript: AgentChatTranscript) {
        let panes = try await AgentChatModel.fetchPanes(session)
        guard let pane = panes.panes.first(where: { $0.agent == session.tab.agent && $0.sessionId != nil })
                ?? panes.panes.first(where: { $0.agent != nil && $0.sessionId != nil }),
              let target = try? pane.target(hostID: session.host.id, workspaceID: session.workspaceID,
                                            tabID: session.tab.id, muxID: session.host.muxID) else {
            throw PhrenKitError.validation("No agent transcript is available in that session.")
        }
        return (target, try await transcript(session: session, target: target))
    }

    static func detail(for session: LiveAgentSession) async -> Detail {
        do {
            let conversation = try await conversation(for: session)
            async let approvalResult = approval(session: session, target: conversation.target)
            let approval = try? await approvalResult
            let lastLine = conversation.transcript.messages.last(where: { $0.role == .assistant })?.text
            return Detail(lastAssistantLine: SessionStatusText.cleanedAssistantLine(lastLine),
                          approval: approval, target: conversation.target)
        } catch {
            return .init()
        }
    }

    static func summaryPrompt(for session: LiveAgentSession, project: String, state: String) async throws -> String {
        let transcript = try await conversation(for: session).transcript
        let messages = transcript.messages.map {
            SessionTranscriptLine(role: $0.role.rawValue, title: $0.title, text: $0.text)
        }
        guard !messages.isEmpty else { throw OnDeviceGenerationError.emptyTranscript }
        return SessionSummaryPrompt.make(project: project, computer: session.host.name,
                                         state: state, messages: messages)
    }

    static func report(_ base: SessionStatusReport, session: LiveAgentSession, detail: Detail) async -> SessionStatusReport {
        var requestID: String?
        let question = detail.approval?.questionPrompt
        if let approval = detail.approval, let target = detail.target,
           let expires = approval.expiration, expires > .now {
            let record = try? await SessionApprovalAction.sharedStore.save(.init(
                id: UUID().uuidString, actionID: approval.id, host: session.host,
                target: target, expiresAt: min(expires, Date().addingTimeInterval(55)), question: question != nil
            ))
            requestID = record?.id
        }
        return SessionStatusReport(entity: base.entity, state: detail.approval == nil ? base.state : .waiting,
                                   lastAssistantLine: detail.lastAssistantLine,
                                   approvalRequestID: requestID,
                                   approvalTitle: question?.questions.first?.question ?? detail.approval?.explanation ?? detail.approval?.title,
                                   approvalIsQuestion: question != nil)
    }

    static func transcript(session: LiveAgentSession, target: AgentChatTarget) async throws -> AgentChatTranscript {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { return try AgentChatFixture.transcript(target) }
        #endif
        return try await PhrenConnection.chatTranscript(host: session.host,
                                                        privateKey: DeviceSSHKey.load(session.host.id), target: target)
    }

    private static func approval(session: LiveAgentSession, target: AgentChatTarget) async throws -> AgentApproval? {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { return try AgentChatFixture.approval(target) }
        #endif
        return try await withThrowingTaskGroup(of: AgentApproval?.self) { group in
            group.addTask {
                for try await status in PhrenConnection.interactionUpdates(
                    host: session.host, privateKey: try DeviceSSHKey.load(session.host.id), target: target
                ) { return status.approval }
                return nil
            }
            group.addTask { try await Task.sleep(for: .seconds(2)); return nil }
            let first = try await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

enum SessionApprovalAction {
    static let sharedStore = ApprovalRequestStore()

    static func answer(requestID: String, approve: Bool, store: ApprovalRequestStore = sharedStore,
                       preferences: LiveSessionPreferences,
                       send: @escaping @Sendable (ApprovalRequestStore.Record, Bool) async throws -> Void) async throws {
        let record = try await store.claim(requestID, preferences: preferences)
        try await send(record, approve)
    }
}

struct SessionApprovalIntent: AppIntent {
    static var title: LocalizedStringResource = "Answer agent approval"
    static var isDiscoverable = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Request") var requestID: String
    @Parameter(title: "Approve") var approve: Bool

    init() {}
    init(requestID: String, approve: Bool) { self.requestID = requestID; self.approve = approve }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let preferences = try LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        try await SessionApprovalAction.answer(requestID: requestID, approve: approve, preferences: preferences) { record, decision in
            // A question's answer is chosen in the app; only a skip goes through here.
            guard record.question != true || !decision else {
                throw PhrenKitError.validation("\(record.target.providerName) has a question. Open Phren to choose the answer.")
            }
            await ApprovalActivityController.shared.answered(target: record.target, actionID: record.actionID)
            #if DEBUG && targetEnvironment(simulator)
            if await MainActor.run(body: { AgentChatFixture.enabled }) {
                await MainActor.run { AgentChatFixture.answered = true; AgentChatFixture.denied = !decision }
                return
            }
            #endif
            try await PhrenConnection.answerApproval(host: record.host, privateKey: DeviceSSHKey.load(record.host.id),
                                                     target: record.target, actionID: record.actionID, approve: decision)
        }
        return .result(dialog: approve ? "Approved." : "Rejected.")
    }
}

struct SessionStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Session Status"
    static var description = IntentDescription("Answers what a live agent session is doing without opening phren.", categoryName: "Agents")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session", requestValueDialog: "Which session?") var session: AgentSessionEntity?
    static var parameterSummary: some ParameterSummary { Summary("Status of \(\.$session)") }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<SessionStatusEntity> & ProvidesDialog & ShowsSnippetView {
        let live = await AgentSessions.current()
        let projects = await SpotlightProjects.current()
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        let reports = SessionStatusService.reports(for: live, projects: projects, preferences: preferences)
        guard let base = SessionStatusService.resolve(session, among: reports),
              let liveSession = live.first(where: { AgentSessionEntity($0).id == base.entity.id }) else {
            throw PhrenKitError.validation("No live agent sessions are available.")
        }
        let report = await SessionStatusService.report(base, session: liveSession,
                                                       detail: await SessionStatusService.detail(for: liveSession))
        var enriched = report
        enriched.awaySummary = await AwaySummaryCache.shared.cached(for: report.entity.id)
        return .result(value: SessionStatusEntity(report: enriched), dialog: "\(SessionStatusText.dialog(for: enriched))",
                       view: SessionStatusSnippetContainer(report: enriched))
    }
}

struct ListWaitingSessionsIntent: AppIntent {
    static var title: LocalizedStringResource = "List Waiting Sessions"
    static var description = IntentDescription("Lists live agent sessions waiting for input or approval.", categoryName: "Agents")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let live = await AgentSessions.current()
        let projects = await SpotlightProjects.current()
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        let reports = SessionStatusService.reports(for: live, projects: projects, preferences: preferences)
        return .result(dialog: "\(SessionStatusText.waitingDialog(reports))")
    }
}

private struct SessionStatusSnippetContainer: View {
    let report: SessionStatusReport?

    @ViewBuilder var body: some View {
        if #available(iOS 18.0, *), let report { SessionStatusSnippet(report: report) }
        else { EmptyView() }
    }
}

@available(iOS 18.0, *)
private struct SessionStatusSnippet: View {
    let report: SessionStatusReport
    private var stateColor: Color {
        switch report.state {
        case .working: PhrenTheme.cyan
        case .waiting: PhrenTheme.warning
        case .idle, .unknown: PhrenTheme.textMuted
        case .done: PhrenTheme.success
        case .error: PhrenTheme.danger
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                AgentProviderGlyph(source: report.entity.agent, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(report.branchLine).font(.headline).lineLimit(1)
                    HStack(spacing: 4) {
                        Circle().fill(stateColor).frame(width: 6, height: 6)
                        Text(report.state.displayName).foregroundStyle(stateColor)
                        Text("· \(report.entity.computer)").foregroundStyle(.secondary)
                    }
                    .font(.subheadline)
                }
                Spacer()
            }
            if let summary = report.awaySummary {
                Text(summary.conciseLine).font(.callout).lineLimit(4)
            } else if let line = report.lastAssistantLine {
                Text(line).font(.callout).lineLimit(3)
            }
            if let title = report.approvalTitle { Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            HStack {
                Button("Open", intent: OpenAgentSessionIntent(target: report.entity))
                    .buttonStyle(.borderedProminent).tint(PhrenTheme.cyan)
                    .accessibilityIdentifier("session-status-open")
                // A question has no blind Approve: Open shows the choices.
                if let requestID = report.approvalRequestID, !report.approvalIsQuestion {
                    Button("Approve", intent: SessionApprovalIntent(requestID: requestID, approve: true))
                        .buttonStyle(.borderedProminent).accessibilityIdentifier("session-status-approve")
                    Button("Reject", role: .destructive,
                           intent: SessionApprovalIntent(requestID: requestID, approve: false))
                        .buttonStyle(.bordered).accessibilityIdentifier("session-status-reject")
                }
            }
        }
        .padding(14)
        .accessibilityIdentifier("session-status-card")
    }
}
