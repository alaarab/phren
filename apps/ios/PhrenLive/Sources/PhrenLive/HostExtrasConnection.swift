import Crypto
import Foundation
import PhrenKit

extension PhrenConnection {
    /// Phren Hook's version on a computer, or nil when it is not reachable.
    public static func hookVersion(host: LiveHost, privateKey: Data) async throws -> String? {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: GatewayRequest(path: "/v1/health"))
        guard data.count <= 65_536, let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              response["product"] as? String == "phren-hook", let version = response["version"] as? String, version.utf8.count <= 64 else { return nil }
        return version
    }

    public static func simulators(host: LiveHost, privateKey: Data) async throws -> [HostSimulator] {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: GatewayRequest(path: "/v1/simulators"))
        try Task.checkCancellation()
        return try HostSimulator.readSnapshot(data)
    }

    public static func simulatorScreenshot(host: LiveHost, privateKey: Data, udid: String) async throws -> Data {
        try host.validate()
        guard udid.range(of: #"^[A-F0-9-]{36}$"#, options: [.regularExpression, .caseInsensitive]) != nil else { throw PhrenKitError.validation("Invalid simulator.") }
        return try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                   request: GatewayRequest(path: GatewayRequest.path("/v1/simulators/screenshot", ["udid": udid]), maximumResponseBytes: 8_388_608))
    }

    public static func simulatorApps(host: LiveHost, privateKey: Data, udid: String) async throws -> [SimulatorApp] {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: GatewayRequest(path: GatewayRequest.path("/v1/simulators/apps", ["udid": udid])))
        return try SimulatorApp.readSnapshot(data)
    }

    /// One action on a simulator: `boot`, `shutdown`, `home`, `lock`,
    /// `launch` (bundleId), `openurl` (url), `tap` (x, y as 0…1), `type` (text).
    public static func simulatorAct(host: LiveHost, privateKey: Data, udid: String, action: String, fields: [String: Any] = [:]) async throws {
        try host.validate()
        var body = fields; body["udid"] = udid; body["action"] = action
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: GatewayRequest(path: "/v1/simulators/action", body: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])))
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["ok"] as? Bool == true else {
            throw PhrenKitError.validation("The computer did not accept that.")
        }
    }

    public static func files(host: LiveHost, privateKey: Data) async throws -> [HostFile] {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: GatewayRequest(path: "/v1/files"))
        try Task.checkCancellation()
        return try HostFile.readSnapshot(data)
    }

    /// Puts a file on the computer, outside any session; returns its path there.
    public static func uploadFile(host: LiveHost, privateKey: Data, name: String, data bytes: Data) async throws -> String {
        try host.validate()
        guard !bytes.isEmpty, bytes.count <= AgentAttachment.maximumBytes else { throw PhrenKitError.validation("Choose a file smaller than 8 MB.") }
        let body = try JSONSerialization.data(withJSONObject: ["name": name, "data": bytes.base64EncodedString()], options: [.sortedKeys])
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: GatewayRequest(path: "/v1/files", body: body))
        return try HostFile.uploadedPath(data)
    }
}
