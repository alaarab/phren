import Foundation
import PhrenKit

extension PhrenConnection {
    /// The pane repository's other worktrees, where workers (sub-agents and
    /// fan-out jobs) keep their edits. Each id scopes the other git routes,
    /// the diff and the file viewer to that worktree.
    public static func gitWorktrees(host: LiveHost, privateKey: Data, target: AgentChatTarget) async throws -> GitWorktrees {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
        let request = try gitWorktreesRequest(target: target)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try GitWorktrees.read(data)
    }

    static func gitWorktreesRequest(target: AgentChatTarget) throws -> GatewayRequest {
        GatewayRequest(path: "/v1/git/worktrees", body: try GatewayRequest.targetBody(target, fields: [:]), maximumResponseBytes: 1_048_576)
    }
}

extension GatewayRequest {
    /// A worktree id from `/v1/git/worktrees`. The computer resolves it only
    /// against its own listing; the phone checks its shape.
    static func worktreeField(_ worktree: String) throws -> String {
        guard GitWorktrees.validID(worktree) else { throw PhrenKitError.validation("This worktree is invalid.") }
        return worktree
    }
}
