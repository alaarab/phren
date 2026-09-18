import Foundation
import PhrenKit

extension PhrenConnection {
    public static func accountUsage(host: LiveHost, privateKey: Data) async throws -> AccountUsageSnapshot {
        do {
            let bytes = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                           request: .init(path: "/v1/usage", maximumResponseBytes: 65_536))
            return try AccountUsageSnapshot.read(bytes)
        } catch let error as LiveConnectionError {
            switch error {
            case .response(404), .gatewayRejection(status: 404, reason: _):
                throw PhrenKitError.validation("Update Phren Hook on this computer and run phren bridge install to enable account usage.")
            default: throw error
            }
        }
    }

    public static func interactionUpdates(host: LiveHost, privateKey: Data, target: AgentChatTarget) -> AsyncThrowingStream<AgentInteractionStatus, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(8)) { continuation in
            let task = Task {
                do {
                    try checkHost(host, target)
                    _ = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                        request: .init(path: GatewayRequest.path("/v1/status", GatewayRequest.targetQuery(target)), webSocket: true, streaming: true)) { data in
                            if let status = try AgentInteractionStatus.read(data, target: target) { continuation.yield(status) }
                        }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// `updatedInput` answers Claude Code's AskUserQuestion: the request's own
    /// input plus `answers` (see `AgentQuestionPrompt.answeredInput`), sent
    /// only with an approval.
    public static func answerApproval(host: LiveHost, privateKey: Data, target: AgentChatTarget, actionID: String, approve: Bool,
                                      updatedInput: [String: Any]? = nil) async throws {
        guard !actionID.isEmpty, actionID.utf8.count <= 512 else { throw PhrenKitError.validation("Refresh the approval.") }
        var fields: [String: Any] = ["source": target.source, "sessionId": target.sessionID, "actionId": actionID, "decision": approve ? "approve" : "deny"]
        if let updatedInput {
            guard approve, updatedInput["answers"] is [String: Any] else { throw PhrenKitError.validation("Answer the question before sending.") }
            let bytes = try JSONSerialization.data(withJSONObject: updatedInput)
            guard bytes.count <= 32_768 else { throw PhrenKitError.validation("The answer is too long.") }
            fields["updatedInput"] = updatedInput
        }
        try await answer(host: host, privateKey: privateKey, target: target, path: "/v1/approvals/answer", body: JSONSerialization.data(withJSONObject: fields))
    }
    public static func answerQuestions(host: LiveHost, privateKey: Data, target: AgentChatTarget, prompt: AgentQuestionPrompt, selections: [[Int]]) async throws {
        try await answer(host: host, privateKey: privateKey, target: target, path: "/v1/questions/answer",
                         body: prompt.answerBody(target: target, selections: selections))
    }
    private static func answer(host: LiveHost, privateKey: Data, target: AgentChatTarget, path: String, body: Data) async throws {
        try checkHost(host, target)
        _ = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target)
        try Task.checkCancellation()
        // The helper compares the exact action/prompt against the live terminal.
        // Never retry an ambiguous response: these requests enter terminal input.
        try requireOK(await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(path: path, body: GatewayRequest.targetBody(target, fields: (try JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]))))
    }

    public static func transcriptImage(host: LiveHost, privateKey: Data, target: AgentChatTarget, line: Int, block: Int, inner: Int? = nil) async throws -> Data {
        try checkHost(host, target)
        guard line >= 0, (0..<2_000).contains(block), inner.map({ (0..<2_000).contains($0) }) ?? true else { throw PhrenKitError.validation("Invalid image reference.") }
        var query = ["line": "\(line)", "block": "\(block)"]
        if let inner { query["inner"] = "\(inner)" }
        return try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(
            path: GatewayRequest.path("/v1/transcripts/blob", GatewayRequest.targetQuery(target).merging(query) { _, new in new }), maximumResponseBytes: 8_388_608))
    }

    /// A picture the phone uploaded, by the absolute path a Claude transcript
    /// names it with (`[Image: source: …]`). The computer serves it only from
    /// Phren Hook's own uploads folder; the same size cap as transcript images.
    public static func uploadImage(host: LiveHost, privateKey: Data, path: String) async throws -> Data {
        guard path.hasPrefix("/"), path.utf8.count <= 4_096, !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw PhrenKitError.validation("Invalid image reference.")
        }
        return try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(
            path: uploadImageRoute(path), maximumResponseBytes: 8_388_608))
    }
    /// Strict escaping: the computer decodes `+` as a space, so only unreserved
    /// characters and `/` travel as they are.
    static func uploadImageRoute(_ path: String) -> String {
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~/")
        return "/v1/uploads/image?path=" + (path.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    /// `paths` are files a command named; the computer adds their repositories
    /// (and a commit a hook already made) to the pane's own working tree.
    public static func repositoryDiff(host: LiveHost, privateKey: Data, target: AgentChatTarget, paths: [String] = []) async throws -> AgentRepositoryDiff {
        try checkHost(host, target)
        let pane = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target)
        guard let cwd = pane.cwd, cwd.hasPrefix("/"), cwd.utf8.count <= 4_096 else { throw PhrenKitError.validation("This pane has no repository folder.") }
        let paths = Array(paths.filter { !$0.isEmpty && $0.utf8.count <= 4_096 && !$0.contains("\0") }.prefix(24))
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(
            path: "/v1/diff", body: GatewayRequest.targetBody(target, fields: paths.isEmpty ? [:] : ["paths": paths]), maximumResponseBytes: 8_388_608))
        return try AgentRepositoryDiff.read(data)
    }

    public struct HerdrServer: Decodable, Identifiable, Sendable {
        public let id: String
        public let kind: String
        public let session: String
        public let running: Bool
    }
    public static func herdrServers(host: LiveHost, privateKey: Data) async throws -> [HerdrServer] {
        struct Response: Decodable { let muxes: [HerdrServer] }
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(path: "/v1/muxes"))
        return try JSONDecoder().decode(Response.self, from: data).muxes.filter { $0.kind == "herdr" && $0.running && AgentChatTarget.validID($0.session) }
    }

    public enum HerdrOperation: String, Sendable { case focus, rename, create, close }
    public static func herdrAction(host: LiveHost, privateKey: Data, operation: HerdrOperation,
                                   workspaceID: String? = nil, tabID: String? = nil, paneID: String? = nil, label: String? = nil, cwd: String? = nil) async throws {
        guard [workspaceID, tabID, paneID].compactMap({ $0 }).allSatisfy(AgentChatTarget.validID),
              operation == .create || workspaceID != nil || tabID != nil || paneID != nil else {
            throw PhrenKitError.validation("Choose a Herdr destination.")
        }
        var body: [String: Any] = [:]
        body["workspaceId"] = workspaceID; body["tabId"] = tabID; body["paneId"] = paneID
        if let cwd {
            guard cwd.hasPrefix("/"), cwd.utf8.count <= 4_096, !cwd.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw PhrenKitError.validation("Enter the full folder path on this computer.") }
            body["cwd"] = cwd
        }
        if let label {
            guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, label.utf8.count <= 200,
                  !label.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw PhrenKitError.validation("Enter a short workspace name.") }
            body["label"] = label
        }
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(
            path: "/v1/workspaces/" + operation.rawValue, body: JSONSerialization.data(withJSONObject: body)))
        try requireOK(data)
    }
    /// The agents Phren can start in a fresh Herdr pane — Herdr's own kind
    /// names, which are also the chat `source` values.
    /// A folder the computer says the project lives in, and how it knows.
    public struct LocatedFolder: Sendable, Equatable, Identifiable {
        public let directory: String
        public let source: String
        public let lastSeen: String?
        public init(directory: String, source: String, lastSeen: String?) { self.directory = directory; self.source = source; self.lastSeen = lastSeen }
        public var id: String { directory }
        public var sourceLabel: String {
            switch source {
            case "activity": return "an agent worked here"
            case "herdr": return "a Herdr workspace"
            case "phren": return "registered with phren"
            default: return "found by name"
            }
        }
    }

    /// Asks the computer where `project` lives — its activity journal, Herdr's
    /// saved workspaces, phren's registration, then the usual project roots.
    public static func locateProject(host: LiveHost, privateKey: Data, project: String) async throws -> [LocatedFolder] {
        guard project.range(of: #"^[a-z0-9][a-z0-9-]{0,99}$"#, options: .regularExpression) != nil else {
            throw PhrenKitError.validation("Invalid project name.")
        }
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(path: "/v1/projects/locate?project=" + project))
        guard data.count <= 65_536, let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let candidates = response["candidates"] as? [[String: Any]] else {
            throw PhrenKitError.validation("The computer returned an unusable answer. Update Phren Hook.")
        }
        return candidates.prefix(8).compactMap { entry in
            guard let directory = entry["directory"] as? String, directory.hasPrefix("/"), directory.utf8.count <= 4_096,
                  !directory.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
            return LocatedFolder(directory: directory, source: entry["source"] as? String ?? "search", lastSeen: entry["lastSeen"] as? String)
        }
    }

    public enum LaunchKind: String, Sendable, CaseIterable, Identifiable {
        case codex, claude, copilot, opencode
        public var id: String { rawValue }
        public var title: String { self == .claude ? "Claude Code" : self == .copilot ? "Copilot" : self == .opencode ? "opencode" : "Codex" }
    }

    /// What `POST /v1/workspaces/launch` hands back: the new pane with the
    /// agent Herdr detected in it. `sessionID` is usually still nil here —
    /// the agent has not written a transcript yet — so the caller polls
    /// `chatPanes` for it the way the session list does.
    public struct LaunchedSession: Sendable, Equatable {
        public let workspaceID: String
        public let tabID: String
        public let paneID: String
        public let agent: String
        public let agentStatus: String?
        public let sessionID: String?
    }

    /// "Open on a computer": a new workspace (or a tab in `workspaceID`) in
    /// `cwd` on the computer, with `kind` started in its pane. Blocks until
    /// Herdr reports the agent ready — up to `timeoutMs` plus a margin.
    public static func launchSession(host: LiveHost, privateKey: Data, cwd: String, label: String, kind: LaunchKind,
                                     workspaceID: String? = nil, timeoutMs: Int = 45_000, model: String? = nil) async throws -> LaunchedSession {
        guard cwd.hasPrefix("/"), cwd.utf8.count <= 4_096, !cwd.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw PhrenKitError.validation("Enter the full folder path on this computer.")
        }
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf8.count <= 200, !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw PhrenKitError.validation("Enter a short workspace name.")
        }
        if let workspaceID { guard AgentChatTarget.validID(workspaceID) else { throw PhrenKitError.validation("Choose a Herdr workspace.") } }
        let timeout = min(120_000, max(3_000, timeoutMs))
        var body: [String: Any] = ["cwd": cwd, "label": name, "kind": kind.rawValue, "timeoutMs": timeout]
        body["workspaceId"] = workspaceID
        if let model {
            let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed.utf8.count <= 200, !trimmed.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
                throw PhrenKitError.validation("Enter a model name.")
            }
            body["model"] = trimmed
        }
        var request = GatewayRequest(path: "/v1/workspaces/launch", body: try JSONSerialization.data(withJSONObject: body))
        request.timeoutSeconds = timeout / 1_000 + 20
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try launchedSession(from: data, kind: kind)
    }

    /// Strict: every identifier must be a Herdr id and the agent must be the
    /// one asked for, so a stale or foreign reply never opens the wrong pane.
    static func launchedSession(from data: Data, kind: LaunchKind) throws -> LaunchedSession {
        guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any], response["ok"] as? Bool == true,
              let workspaceID = response["workspaceId"] as? String, let tabID = response["tabId"] as? String,
              let paneID = response["paneId"] as? String, [workspaceID, tabID, paneID].allSatisfy(AgentChatTarget.validID),
              response["agent"] as? String == kind.rawValue else {
            throw PhrenKitError.validation("The computer didn't confirm the new session. Check Herdr workspaces before trying again.")
        }
        let status = (response["agentStatus"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(40)) }
        let session = (response["sessionId"] as? String).flatMap { AgentChatTarget.validSessionID($0) ? $0 : nil }
        return LaunchedSession(workspaceID: workspaceID, tabID: tabID, paneID: paneID, agent: kind.rawValue, agentStatus: status, sessionID: session)
    }

    private static func checkHost(_ host: LiveHost, _ target: AgentChatTarget) throws {
        guard target.hostID == host.id, target.muxID == host.muxID else { throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.") }
    }
    private static func requireOK(_ data: Data) throws {
        guard (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["ok"] as? Bool == true else {
            throw PhrenKitError.validation("The action was not confirmed. Refresh before trying again.")
        }
    }
}
