import Crypto
import Foundation
import PhrenKit

extension PhrenConnection {
    public static func webServers(host: LiveHost, privateKey: Data) async throws -> [WebServer] {
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                       request: GatewayRequest(path: "/v1/web-servers"))
        try Task.checkCancellation()
        return try WebServer.readSnapshot(data)
    }

    /// Only the servers this conversation's own session started or names,
    /// never the machine-wide list.
    public static func sessionWebServers(host: LiveHost, privateKey: Data, target: AgentChatTarget) async throws -> [WebServer] {
        guard target.hostID == host.id, target.muxID == host.muxID else {
            throw PhrenKitError.validation("This conversation belongs to another computer or Herdr server.")
        }
        let request = GatewayRequest(path: "/v1/web-servers/session", body: try GatewayRequest.targetBody(target, fields: [:]))
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        try Task.checkCancellation()
        return try WebServer.readSnapshot(data)
    }
}
