import Foundation
import PhrenKit

/// The Changes screen's writes: stage, unstage and discard, bound to the pane's
/// trusted repository (or a child agent's worktree) exactly as `/v1/diff` is.
/// The Hook refuses any path outside the repository root, so the phone only
/// checks shape: a bounded, non-empty list of relative paths.
extension PhrenConnection {
    public static func gitStage(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                                  worktree: String? = nil, paths: [String]) async throws {
        try await gitWrite(host: host, privateKey: privateKey, target: target, route: "stage", child: child, worktree: worktree, paths: paths)
    }

    public static func gitUnstage(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                                  worktree: String? = nil, paths: [String]) async throws {
        try await gitWrite(host: host, privateKey: privateKey, target: target, route: "unstage", child: child, worktree: worktree, paths: paths)
    }

    public static func gitDiscard(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                                  worktree: String? = nil, paths: [String]) async throws {
        try await gitWrite(host: host, privateKey: privateKey, target: target, route: "discard", child: child, worktree: worktree, paths: paths)
    }

    private static func gitWrite(host: LiveHost, privateKey: Data, target: AgentChatTarget, route: String,
                                 child: String?, worktree: String?, paths: [String]) async throws {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
        let request = try gitWriteRequest(target: target, route: route, child: child, paths: paths, worktree: worktree)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        guard (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["ok"] as? Bool == true else {
            throw PhrenKitError.validation("The change was not confirmed. Refresh before trying again.")
        }
    }

    static func gitWriteRequest(target: AgentChatTarget, route: String, child: String?, paths: [String], worktree: String? = nil) throws -> GatewayRequest {
        guard ["stage", "unstage", "discard"].contains(route), !paths.isEmpty, paths.count <= 64,
              paths.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 4_096 && !$0.contains("\0") }) else {
            throw PhrenKitError.validation("Choose between 1 and 64 valid file paths.")
        }
        var fields: [String: Any] = ["paths": paths]
        if let child {
            guard child.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
                throw PhrenKitError.validation("This child agent is invalid.")
            }
            fields["child"] = child
        }
        if let worktree { fields["worktree"] = try GatewayRequest.worktreeField(worktree) }
        return GatewayRequest(path: "/v1/git/\(route)",
                                     body: try GatewayRequest.targetBody(target, fields: fields),
                                     maximumResponseBytes: 65_536)
    }
}
