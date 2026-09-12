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

    public static func answerApproval(host: LiveHost, privateKey: Data, target: AgentChatTarget, actionID: String, approve: Bool) async throws {
        guard !actionID.isEmpty, actionID.utf8.count <= 512 else { throw PhrenKitError.validation("Refresh the approval.") }
        let body = try JSONSerialization.data(withJSONObject: ["source": target.source, "sessionId": target.sessionID,
                                                              "actionId": actionID, "decision": approve ? "approve" : "deny"])
        try await answer(host: host, privateKey: privateKey, target: target, path: "/v1/approvals/answer", body: body)
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

    public static func transcriptImage(host: LiveHost, privateKey: Data, target: AgentChatTarget, line: Int, block: Int) async throws -> Data {
        try checkHost(host, target)
        guard line >= 0, (0..<2_000).contains(block) else { throw PhrenKitError.validation("Invalid image reference.") }
        return try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(
            path: GatewayRequest.path("/v1/transcripts/blob", GatewayRequest.targetQuery(target).merging(["line": "\(line)", "block": "\(block)"]) { _, new in new }), maximumResponseBytes: 8_388_608))
    }

    public static func repositoryDiff(host: LiveHost, privateKey: Data, target: AgentChatTarget) async throws -> AgentRepositoryDiff {
        try checkHost(host, target)
        let pane = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target)
        guard let cwd = pane.cwd, cwd.hasPrefix("/"), cwd.utf8.count <= 4_096 else { throw PhrenKitError.validation("This pane has no repository folder.") }
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .init(
            path: "/v1/diff", body: GatewayRequest.targetBody(target), maximumResponseBytes: 8_388_608))
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
    private static func checkHost(_ host: LiveHost, _ target: AgentChatTarget) throws {
        guard target.hostID == host.id, target.muxID == host.muxID else { throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.") }
    }
    private static func requireOK(_ data: Data) throws {
        guard (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["ok"] as? Bool == true else {
            throw PhrenKitError.validation("The action was not confirmed. Refresh before trying again.")
        }
    }
}
