import Foundation
import PhrenKit

extension PhrenConnection {
    /// The pane repository's local and remote-tracking branches.
    public static func gitBranches(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                                   worktree: String? = nil) async throws -> GitBranches {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
        let request = try gitBranchesRequest(target: target, child: child, worktree: worktree)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try GitBranches.read(data)
    }

    static func gitBranchesRequest(target: AgentChatTarget, child: String?, worktree: String? = nil) throws -> GatewayRequest {
        var fields: [String: Any] = [:]
        if let child {
            guard child.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
                throw PhrenKitError.validation("This child agent is invalid.")
            }
            fields["child"] = child
        }
        if let worktree { fields["worktree"] = try GatewayRequest.worktreeField(worktree) }
        return GatewayRequest(path: "/v1/git/branches", body: try GatewayRequest.targetBody(target, fields: fields), maximumResponseBytes: 8_388_608)
    }
}
