import Crypto
import Foundation
import PhrenKit

extension PhrenConnection {
    /// The pane's repository pull requests, as the computer's GitHub CLI
    /// reports them. `available` is false, not an error, when `gh` is missing
    /// or not signed in.
    public static func gitPulls(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                                worktree: String? = nil) async throws -> GitPulls {
        try gitPullsTarget(host, target)
        let request = try gitPullsRequest(target: target, child: child, worktree: worktree)
        _ = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try GitPulls.read(data)
    }

    private static func gitPullsTarget(_ host: LiveHost, _ target: AgentChatTarget) throws {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
    }

    private static func gitPullsRequest(target: AgentChatTarget, child: String?, worktree: String?) throws -> GatewayRequest {
        var fields: [String: Any] = [:]
        if let child {
            guard child.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
                throw PhrenKitError.validation("This child agent is invalid.")
            }
            fields["child"] = child
        }
        if let worktree { fields["worktree"] = try GatewayRequest.worktreeField(worktree) }
        return GatewayRequest(path: "/v1/git/pulls", body: try GatewayRequest.targetBody(target, fields: fields),
                              maximumResponseBytes: 8_388_608)
    }
}