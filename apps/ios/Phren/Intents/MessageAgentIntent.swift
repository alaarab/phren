import AppIntents
import PhrenKit
import PhrenLive

/// Somewhere Siri can send a message: a running session ("phren on Mini"),
/// or a phren project on a computer that has it, where a session would be
/// started first.
struct AgentSessionEntity: AppEntity, Equatable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { TypeDisplayRepresentation(name: "Agent session") }
    static var defaultQuery = AgentSessionEntityQuery()

    enum Kind: Equatable { case live, launch(storeID: String) }
    let id: String
    let workspace: String
    let computer: String
    let title: String
    let agent: String?
    let kind: Kind
    var isLive: Bool { kind == .live }

    init(_ session: LiveAgentSession) {
        id = [session.host.id.uuidString, session.workspaceID, session.tab.id].joined(separator: "|")
        workspace = session.workspaceName.isEmpty ? session.tab.displayTitle : session.workspaceName
        computer = session.host.name
        title = session.tab.displayTitle
        agent = session.tab.agent
        kind = .live
    }
    init(host: LiveHost, storeID: String, project: String) {
        id = ["launch", host.id.uuidString, storeID, project].joined(separator: "|")
        workspace = project; computer = host.name; title = project; agent = nil
        kind = .launch(storeID: storeID)
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(workspace) on \(computer)",
                              subtitle: isLive ? "\((agent ?? "agent").capitalized) · \(title)" : "Start a session here",
                              synonyms: ["\(workspace)", "\(workspace) workspace", "\(workspace) project", "\(workspace) workspace on \(computer)", "\(workspace) session on \(computer)", "\(workspace) on the \(computer)"])
    }
}

/// Live sessions from every saved computer, asked in parallel; a computer
/// that does not answer within a few seconds simply contributes nothing.
@MainActor
enum AgentSessions {
    static var hosts: [LiveHost] {
        (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts ?? []
    }
    static func current() async -> [LiveAgentSession] {
        await withTaskGroup(of: [LiveAgentSession].self) { group in
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

    /// Everything Siri can name: the live sessions, then each project the
    /// store places on a saved computer (or that was opened there before)
    /// unless a session for it is already running on that computer.
    static func targets() async -> [AgentSessionEntity] {
        let live = await current()
        var entities = live.map(AgentSessionEntity.init)
        let mappings = (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.mappings ?? []
        for target in await PhrenCapture.targets() {
            for host in hosts where host.fingerprint != nil {
                let known = await AgentLaunch.knowsProject(host, computerName: nil, storeID: target.storeId, project: target.project)
                    || mappings.contains { $0.hostID == host.id && $0.project == target.project }
                guard known else { continue }
                let running = live.contains { session in
                    session.host.id == host.id && (session.workspaceName.lowercased() == target.project.lowercased()
                        || session.tab.cwd?.lowercased().hasSuffix("/" + target.project.lowercased()) == true)
                }
                if !running { entities.append(AgentSessionEntity(host: host, storeID: target.storeId, project: target.project)) }
            }
        }
        return entities
    }

    /// The session behind an entity — the running one, or a new one started
    /// in the project's folder with the default harness.
    static func resolve(_ entity: AgentSessionEntity, progress: @MainActor (String) -> Void = { _ in }) async throws -> (session: LiveAgentSession, started: Bool) {
        let parts = entity.id.split(separator: "|").map(String.init)
        if case .launch(let storeID) = entity.kind {
            guard parts.count == 4, let hostID = UUID(uuidString: parts[1]), let host = hosts.first(where: { $0.id == hostID }) else {
                throw PhrenKitError.validation("That computer is no longer saved.")
            }
            let project = parts[3]
            guard let cwd = await AgentLaunch.folder(host: host, storeID: storeID, project: project) else {
                throw PhrenKitError.validation("Couldn't find where \(project) lives on \(host.name). Open it once from the project screen.")
            }
            await progress("Starting \(AgentLaunch.defaultHarness.title) in \(project) on \(host.name)…")
            let session = try await AgentLaunch.launch(host: host, cwd: cwd, label: project, kind: AgentLaunch.defaultHarness, progress: progress)
            AgentLaunch.remember(host: host, cwd: cwd, storeID: storeID, project: project)
            return (session, true)
        }
        guard parts.count == 3, let hostID = UUID(uuidString: parts[0]), let host = hosts.first(where: { $0.id == hostID }) else {
            throw PhrenKitError.validation("That computer is no longer saved.")
        }
        if let session = (try? await PhrenConnection.fetch(host: host, privateKey: DeviceSSHKey.load(host.id)))?.sessions(on: host)
            .first(where: { $0.workspaceID == parts[1] && $0.tab.id == parts[2] }) { return (session, false) }
        throw PhrenKitError.validation("\(entity.workspace) on \(entity.computer) is no longer running.")
    }
}

/// Resolves what Siri heard — "phren", "phren workspace on mini", "the mini
/// phren session" — against the live sessions, best first. Several survivors
/// make Siri ask which one; one resolves outright.
struct AgentSessionEntityQuery: EntityStringQuery {
    func entities(for identifiers: [AgentSessionEntity.ID]) async throws -> [AgentSessionEntity] {
        let wanted = Set(identifiers)
        return await AgentSessions.targets().filter { wanted.contains($0.id) }
    }
    func suggestedEntities() async throws -> [AgentSessionEntity] {
        await AgentSessions.targets()
    }
    func entities(matching string: String) async throws -> [AgentSessionEntity] {
        Self.rank(string, among: await AgentSessions.targets())
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
            // A running session beats starting a new one for the same words.
            if entity.isLive { score += 10 }
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
        let resolved = try await AgentSessions.resolve(session)
        let live = resolved.session
        let key = try DeviceSSHKey.load(live.host.id)
        let panes = try await PhrenConnection.chatPanes(host: live.host, privateKey: key, workspaceID: live.workspaceID, tabID: live.tab.id)
        guard let pane = panes.panes.first(where: { $0.agent != nil && $0.sessionId != nil }) ?? panes.panes.first(where: { $0.agent != nil }) else {
            return .result(dialog: "No agent is running in \(session.workspace) on \(session.computer) any more.")
        }
        let target = try pane.target(hostID: live.host.id, workspaceID: live.workspaceID, tabID: live.tab.id, muxID: live.host.muxID)
        try await PhrenConnection.sendChat(host: live.host, privateKey: key, target: target, text: text)
        let agent = (pane.agent ?? "the agent").capitalized
        return .result(dialog: resolved.started
            ? "Started \(agent) in \(session.workspace) on \(session.computer) and sent your message."
            : "Sent to \(agent) in \(session.workspace) on \(session.computer).")
    }
}
