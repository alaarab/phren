import Foundation
import PhrenKit

/// Finishing a session from the Changes screen: commit what is staged, push the
/// branch, open a pull request. Bound to the pane's repository, a child's
/// worktree or a listed worktree id exactly like the other `/v1/git/*` routes.
/// Git and gh refusals come back as `ok: false` with their output verbatim.
extension PhrenConnection {
    public static func gitCommit(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                                 worktree: String? = nil, message: String) async throws -> GitPublishResult {
        try await gitPublish(host: host, privateKey: privateKey, target: target,
                             request: gitCommitRequest(target: target, child: child, worktree: worktree, message: message))
    }

    /// `confirmDefault` is sent only after the person confirmed pushing the
    /// default branch; the Hook refuses it otherwise.
    public static func gitPush(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                               worktree: String? = nil, confirmDefault: Bool = false) async throws -> GitPublishResult {
        try await gitPublish(host: host, privateKey: privateKey, target: target,
                             request: gitPushRequest(target: target, child: child, worktree: worktree, confirmDefault: confirmDefault))
    }

    public static func gitPullRequest(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                                      worktree: String? = nil, draft: Bool = false) async throws -> GitPublishResult {
        try await gitPublish(host: host, privateKey: privateKey, target: target,
                             request: gitPullRequestRequest(target: target, child: child, worktree: worktree, draft: draft))
    }

    private static func gitPublish(host: LiveHost, privateKey: Data, target: AgentChatTarget, request: GatewayRequest) async throws -> GitPublishResult {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
        _ = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target)
        return try GitPublishResult.read(try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request))
    }

    static func gitCommitRequest(target: AgentChatTarget, child: String?, worktree: String?, message: String) throws -> GatewayRequest {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw PhrenKitError.validation("Write a commit message first.") }
        guard message.count <= 20_000, !message.contains("\0") else { throw PhrenKitError.validation("The commit message is too long.") }
        return try gitPublishRequest(target: target, route: "commit", child: child, worktree: worktree, fields: ["message": trimmed])
    }

    static func gitPushRequest(target: AgentChatTarget, child: String?, worktree: String?, confirmDefault: Bool) throws -> GatewayRequest {
        try gitPublishRequest(target: target, route: "push", child: child, worktree: worktree,
                              fields: confirmDefault ? ["confirmDefault": true] : [:])
    }

    static func gitPullRequestRequest(target: AgentChatTarget, child: String?, worktree: String?, draft: Bool) throws -> GatewayRequest {
        try gitPublishRequest(target: target, route: "pr", child: child, worktree: worktree, fields: draft ? ["draft": true] : [:])
    }

    private static func gitPublishRequest(target: AgentChatTarget, route: String, child: String?, worktree: String?,
                                          fields: [String: Any]) throws -> GatewayRequest {
        var fields = fields
        if let child {
            guard child.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
                throw PhrenKitError.validation("This child agent is invalid.")
            }
            fields["child"] = child
        }
        if let worktree { fields["worktree"] = try GatewayRequest.worktreeField(worktree) }
        var request = GatewayRequest(path: "/v1/git/\(route)", body: try GatewayRequest.targetBody(target, fields: fields),
                                     maximumResponseBytes: 262_144)
        // Hooks and pushes can take a while; the Hook's own limit is 110 seconds.
        request.timeoutSeconds = 120
        return request
    }
}
