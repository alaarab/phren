import Foundation
import PhrenKit

extension PhrenConnection {
    /// The pane repository's commit history, newest first, plus the working
    /// tree summary the graph draws above it. `ref` shows one branch's log.
    public static func gitLog(host: LiveHost, privateKey: Data, target: AgentChatTarget, child: String? = nil,
                              limit: Int = 60, ref: String? = nil) async throws -> GitLog {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
        let request = try gitLogRequest(target: target, child: child, limit: limit, ref: ref)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try GitLog.read(data)
    }

    static func gitLogRequest(target: AgentChatTarget, child: String?, limit: Int, ref: String?) throws -> GatewayRequest {
        var fields: [String: Any] = ["limit": min(200, max(1, limit))]
        if let child {
            guard child.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
                throw PhrenKitError.validation("This child agent is invalid.")
            }
            fields["child"] = child
        }
        if let ref, !ref.isEmpty {
            guard ref.utf8.count <= 512, !ref.hasPrefix("-"), ref.rangeOfCharacter(from: .controlCharacters) == nil else { throw PhrenKitError.validation("Enter a valid branch name.") }
            fields["ref"] = ref
        }
        return GatewayRequest(path: "/v1/git/log", body: try GatewayRequest.targetBody(target, fields: fields), maximumResponseBytes: 8_388_608)
    }
}
