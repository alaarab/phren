import AppIntents
import PhrenKit
import PhrenLive

/// A running agent session, as Siri names it: "phren on Mini".
struct AgentSessionEntity: AppEntity, Equatable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { TypeDisplayRepresentation(name: "Agent session") }
    static var defaultQuery = AgentSessionEntityQuery()

    let id: String
    let workspace: String
    let computer: String
    let title: String
    let agent: String?

    init(_ session: LiveAgentSession) {
        id = [session.host.id.uuidString, session.workspaceID, session.tab.id].joined(separator: "|")
        workspace = session.workspaceName.isEmpty ? session.tab.displayTitle : session.workspaceName
        computer = session.host.name
        title = session.tab.displayTitle
        agent = session.tab.agent
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(workspace) on \(computer)", subtitle: "\((agent ?? "agent").capitalized) · \(title)",
                              synonyms: ["\(workspace)", "\(workspace) workspace", "\(workspace) workspace on \(computer)", "\(workspace) session on \(computer)"])
    }
}

/// Live sessions from every saved computer, asked in parallel; a computer
/// that does not answer within a few seconds simply contributes nothing.
enum AgentSessions {
    static func current() async -> [LiveAgentSession] {
        let hosts = (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts ?? []
        return await withTaskGroup(of: [LiveAgentSession].self) { group in
            for host in hosts {
                group.addTask {
                    let fetch = Task { try await PhrenConnection.fetch(host: host, privateKey: DeviceSSHKey.load(host.id)) }
                    let timeout = Task { try await Task.sleep(for: .seconds(8)); fetch.cancel() }
                    defer { timeout.cancel() }
                    return ((try? await fetch.value)?.sessions(on: host) ?? []).filter { $0.tab.agent != nil }
                }
            }
            var all: [LiveAgentSession] = []
            for await sessions in group { all += sessions }
            return all.sorted { ($0.host.name, $0.workspaceName, $0.tab.displayTitle) < ($1.host.name, $1.workspaceName, $1.tab.displayTitle) }
        }
    }
}

/// Resolves what Siri heard — "phren", "phren workspace on mini", "the mini
/// phren session" — against the live sessions, best first. Several survivors
/// make Siri ask which one; one resolves outright.
struct AgentSessionEntityQuery: EntityStringQuery {
    func entities(for identifiers: [AgentSessionEntity.ID]) async throws -> [AgentSessionEntity] {
        let wanted = Set(identifiers)
        return await AgentSessions.current().map(AgentSessionEntity.init).filter { wanted.contains($0.id) }
    }
    func suggestedEntities() async throws -> [AgentSessionEntity] {
        await AgentSessions.current().map(AgentSessionEntity.init)
    }
    func entities(matching string: String) async throws -> [AgentSessionEntity] {
        let entities = await AgentSessions.current().map(AgentSessionEntity.init)
        return Self.rank(string, among: entities)
    }

    static func normalized(_ text: String) -> String {
        text.lowercased().replacingOccurrences(of: #"[^\p{L}\p{N}]+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }
    /// Pure, so it can be tested without a computer: strips the filler words
    /// ("workspace", "session", "on", "the") and scores workspace and computer.
    static func rank(_ spoken: String, among entities: [AgentSessionEntity]) -> [AgentSessionEntity] {
        let filler: Set<String> = ["workspace", "session", "the", "my", "on", "in", "agent", "to"]
        let words = normalized(spoken).split(separator: " ").map(String.init).filter { !filler.contains($0) }
        guard !words.isEmpty else { return entities }
        let scored = entities.compactMap { entity -> (Int, AgentSessionEntity)? in
            let workspace = normalized(entity.workspace), computer = normalized(entity.computer), title = normalized(entity.title)
            let needle = words.joined(separator: " ")
            var score = 0
            if needle == workspace + " " + computer || needle == workspace { score = 100 }
            else if words.contains(where: { workspace == $0 || workspace.hasPrefix($0) && $0.count >= 3 }) { score = 60 }
            else if words.contains(where: { workspace.contains($0) && $0.count >= 3 }) { score = 40 }
            else if words.contains(where: { title.contains($0) && $0.count >= 4 }) { score = 20 }
            // The workspace (or tab) has to match; the computer only narrows.
            guard score > 0 else { return nil }
            let computerHit = words.contains { computer == $0 || (computer.hasPrefix($0) && $0.count >= 3) }
            if computerHit { score += 30 }
            let mentionsAnotherComputer = !computerHit && entities.contains { other in
                other.computer != entity.computer && words.contains { normalized(other.computer) == $0 }
            }
            guard !mentionsAnotherComputer else { return nil }
            return (score, entity)
        }
        return scored.sorted { ($1.0, $0.1.workspace) < ($0.0, $1.1.workspace) }.map(\.1)
    }
}

/// "Hey Siri, message phren on mini in Phren" — then say the message. It goes
/// to the agent in that session exactly as a typed chat message would.
struct MessageAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Message an Agent"
    static var description = IntentDescription(
        "Sends a message to a coding agent running on one of your computers, as if typed into its chat.",
        categoryName: "Agents", searchKeywords: ["agent", "chat", "message", "codex", "claude", "session", "workspace"])
    static var openAppWhenRun = false
    /// Steering an agent on your computer is not a locked-phone action.
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session", requestValueDialog: "Which session?")
    var session: AgentSessionEntity

    @Parameter(title: "Message", requestValueDialog: "What should I tell it?")
    var message: String

    static var parameterSummary: some ParameterSummary { Summary("Message \(\.$session): \(\.$message)") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = SpeechSettings.apply(message.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !text.isEmpty else { throw $message.needsValueError("What should I tell it?") }
        let parts = session.id.split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count == 3, let hostID = UUID(uuidString: parts[0]) else { throw $session.needsValueError("Which session?") }
        let hosts = (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts ?? []
        guard let host = hosts.first(where: { $0.id == hostID }) else { throw $session.needsValueError("That computer is no longer saved. Which session?") }
        let key = try DeviceSSHKey.load(host.id)
        let panes = try await PhrenConnection.chatPanes(host: host, privateKey: key, workspaceID: parts[1], tabID: parts[2])
        guard let pane = panes.panes.first(where: { $0.agent != nil && $0.sessionId != nil }) ?? panes.panes.first(where: { $0.agent != nil }) else {
            return .result(dialog: "No agent is running in \(session.workspace) on \(session.computer) any more.")
        }
        let target = try pane.target(hostID: host.id, workspaceID: parts[1], tabID: parts[2], muxID: host.muxID)
        try await PhrenConnection.sendChat(host: host, privateKey: key, target: target, text: text)
        return .result(dialog: "Sent to \((pane.agent ?? "the agent").capitalized) in \(session.workspace) on \(session.computer).")
    }
}
