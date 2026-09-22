import Foundation
import PhrenKit

extension PhrenConnection {
    /// Standing conductor grants the Hook stores in `conductor.yaml`.
    public static func conductorGrants(host: LiveHost, privateKey: Data) async throws -> [ConductorGrant] {
        struct Response: Decodable { let grants: [ConductorGrant] }
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                       request: conductorGrantsListRequest())
        return try JSONDecoder().decode(Response.self, from: data).grants
    }

    public static func addConductorGrant(host: LiveHost, privateKey: Data, grant: ConductorGrant) async throws -> ConductorGrant {
        struct Response: Decodable { let ok: Bool; let grant: ConductorGrant }
        let request = try conductorGrantAddRequest(grant: grant)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard response.ok else { throw PhrenKitError.validation("The computer did not confirm the grant.") }
        return response.grant
    }

    /// Removes the grant at `index` (the Hook's list order, 0...63).
    public static func removeConductorGrant(host: LiveHost, privateKey: Data, index: Int, expected: ConductorGrant? = nil) async throws {
        struct Response: Decodable { let ok: Bool }
        let request = try conductorGrantRemoveRequest(index: index, expected: expected)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard response.ok else { throw PhrenKitError.validation("The computer did not confirm the removal.") }
    }

    static func conductorGrantsListRequest() -> GatewayRequest {
        var request = GatewayRequest(path: "/v1/conductor/grants")
        request.method = "GET"
        return request
    }

    static func conductorGrantAddRequest(grant: ConductorGrant) throws -> GatewayRequest {
        var body: [String: Any] = ["scope": grant.scope, "actions": grant.actions.map(\.rawValue)]
        if let computers = grant.computers { body["computers"] = computers }
        if let until = grant.until { body["until"] = until }
        var request = GatewayRequest(path: "/v1/conductor/grants",
                                     body: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
        request.method = "POST"
        return request
    }

    static func conductorGrantRemoveRequest(index: Int, expected: ConductorGrant? = nil) throws -> GatewayRequest {
        guard (0...63).contains(index) else {
            throw PhrenKitError.validation("That grant is no longer on this computer.")
        }
        var fields: [String: Any] = ["index": index]
        if let expected {
            fields["expected"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(expected))
        }
        let body = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        var request = GatewayRequest(path: "/v1/conductor/grants", body: body)
        request.method = "DELETE"
        return request
    }
}
