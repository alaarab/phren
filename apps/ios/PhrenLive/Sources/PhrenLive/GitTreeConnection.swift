import Crypto
import Foundation
import PhrenKit

extension PhrenConnection {
    /// One level of the pane's repository. `path` is repository-relative; ""
    /// lists the root. The computer refuses anything outside the root.
    public static func gitTree(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil, worktree: String? = nil,
                               path: String = "", ignored: Bool = false) async throws -> GitWorkingTree {
        try gitTreeTarget(host, target)
        let request = try gitTreeRequest(target: target, path: path, child: child, worktree: worktree, ignored: ignored)
        _ = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try GitWorkingTree.read(data)
    }

    private static func gitTreeTarget(_ host: LiveHost, _ target: AgentChatTarget) throws {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
    }

    static func gitTreeRequest(target: AgentChatTarget, path: String, child: String?, worktree: String? = nil, ignored: Bool = false) throws -> GatewayRequest {
        var fields: [String: Any] = [:]
        if let child {
            guard child.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
                throw PhrenKitError.validation("This child agent is invalid.")
            }
            fields["child"] = child
        }
        if let worktree { fields["worktree"] = try GatewayRequest.worktreeField(worktree) }
        if ignored { fields["ignored"] = true }
        if !path.isEmpty {
            guard path.utf8.count <= 4_096, !path.contains("\0"), !path.split(separator: "/").contains("..") else {
                throw PhrenKitError.validation("That folder path is invalid.")
            }
            fields["path"] = path
        }
        return GatewayRequest(path: "/v1/git/tree", body: try GatewayRequest.targetBody(target, fields: fields),
                              maximumResponseBytes: 8_388_608)
    }
}