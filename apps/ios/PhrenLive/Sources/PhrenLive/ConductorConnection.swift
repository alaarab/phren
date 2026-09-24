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

/// The conductor's latest dispatch or return, as one line for its card.
public struct ConductorActivity: Equatable, Sendable {
    public let line: String
    public let at: Date
    public init(line: String, at: Date) { self.line = line; self.at = at }
}

extension PhrenConnection {
    /// The newest dispatch receipt on this computer's Hook, or its return
    /// when the worker came back after it was placed.
    public static func conductorActivity(host: LiveHost, privateKey: Data) async throws -> ConductorActivity? {
        var request = GatewayRequest(path: "/v1/dispatch")
        request.method = "GET"
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return conductorActivity(from: data)
    }

    static func conductorActivity(from data: Data) -> ConductorActivity? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let receipts = object["dispatches"] as? [[String: Any]] else { return nil }
        func date(_ value: Any?) -> Date? { (value as? String).flatMap(ISO8601Dates.parse) }
        var best: ConductorActivity?
        for receipt in receipts {
            let label = (receipt["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (receipt["project"] as? String) ?? "a worker"
            let candidate: ConductorActivity?
            if let returned = receipt["returned"] as? [String: Any], let at = date(returned["at"]) {
                let line: String
                switch returned["state"] as? String {
                case "done": line = "Returned: \(label) finished"
                case "needs-you": line = "Needs you: \(label)" + ((returned["question"] as? String).map { ", \($0)" } ?? "")
                case "blocked": line = "Blocked: \(label)"
                default: line = "Gone: \(label) closed"
                }
                candidate = .init(line: line, at: at)
            } else if let at = date(receipt["updatedAt"]) ?? date(receipt["createdAt"]) {
                let computer = (receipt["computer"] as? String).map { " to \($0)" } ?? ""
                switch receipt["state"] as? String {
                case "failed": candidate = .init(line: "Dispatch failed: \(label)", at: at)
                case "uncertain": candidate = .init(line: "Dispatch unconfirmed: \(label)", at: at)
                default: candidate = .init(line: "Dispatched \(label)\(computer)", at: at)
                }
            } else { candidate = nil }
            if let candidate, candidate.at > (best?.at ?? .distantPast) { best = candidate }
        }
        return best
    }
}
