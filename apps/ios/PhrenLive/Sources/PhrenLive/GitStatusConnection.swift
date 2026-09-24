import Foundation
import PhrenKit

extension PhrenConnection {
    /// The pane's working tree: branch, ahead/behind, counts and files.
    /// A child status is scoped by the child's public id, like `/v1/diff`.
    public static func gitStatus(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                                 worktree: String? = nil) async throws -> GitStatus {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
        let request = try gitStatusRequest(target: target, child: child, worktree: worktree)
        _ = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try GitStatus.read(data)
    }

    static func gitStatusRequest(target: AgentChatTarget, child: String?, worktree: String? = nil) throws -> GatewayRequest {
        var fields: [String: Any]
        if let child {
            guard child.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
                throw PhrenKitError.validation("This child agent is invalid.")
            }
            fields = ["child": child]
        } else {
            fields = [:]
        }
        if let worktree { fields["worktree"] = try GatewayRequest.worktreeField(worktree) }
        return GatewayRequest(path: "/v1/git/status", body: try GatewayRequest.targetBody(target, fields: fields), maximumResponseBytes: 8_388_608)
    }
}