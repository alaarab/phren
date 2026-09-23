import Crypto
import Foundation
import PhrenKit

extension PhrenConnection {
    public static func fileRange(host: LiveHost, privateKey: Data, file: RemoteFile, offset: Int64 = 0,
                                 length: Int = 1_048_576, version: String? = nil) async throws -> FileChunk {
        try host.validate()
        guard offset >= 0, (0...FileChunk.maximumLength).contains(length) else {
            throw PhrenKitError.validation("Invalid file range.")
        }
        var query = file.target.map(GatewayRequest.targetQuery) ?? [:]
        query["path"] = file.path; query["offset"] = String(offset); query["length"] = String(length)
        query["project"] = file.project; query["directory"] = file.directory
        query["child"] = file.child; query["worktree"] = file.worktree; query["version"] = version
        if file.uploads { query["scope"] = "uploads" }
        let bytes = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
            request: GatewayRequest(path: GatewayRequest.path("/v1/files/range", query), maximumResponseBytes: length == 0 ? 32_768 : 6_000_000))
        try Task.checkCancellation()
        let chunk = try JSONDecoder().decode(FileChunk.self, from: bytes)
        _ = try chunk.bytes()
        guard chunk.offset == offset, chunk.length <= length, version == nil || chunk.version == version else {
            throw PhrenKitError.validation("The computer returned a different file range.")
        }
        return chunk
    }

    public struct RepositoryFile: Decodable, Identifiable, Sendable {
        public let name: String
        public let path: String
        public let kind: String
        public var id: String { path }
    }

    public struct RepositoryFileResponse: Decodable, Sendable {
        public let path: String
        public let kind: String
        public let entries: [RepositoryFile]?
        public let truncated: Bool?
        public let data: String?
    }

    public static func repositoryFiles(host: LiveHost, privateKey: Data, project: String, directory: String, path: String = "") async throws -> RepositoryFileResponse {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                      request: GatewayRequest(path: GatewayRequest.path("/v1/projects/files", ["project": project, "directory": directory, "path": path]), maximumResponseBytes: 3_000_000))
        try Task.checkCancellation()
        return try JSONDecoder().decode(RepositoryFileResponse.self, from: data)
    }

    public static func uploadedImage(host: LiveHost, privateKey: Data, path: String) async throws -> Data {
        try host.validate()
        return try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                   request: GatewayRequest(path: GatewayRequest.path("/v1/uploads/image", ["path": path]), maximumResponseBytes: 8_388_608))
    }

    /// Phren Hook's version on a computer, or nil when it is not reachable.
    public static func hookVersion(host: LiveHost, privateKey: Data) async throws -> String? {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: GatewayRequest(path: "/v1/health"))
        guard data.count <= 65_536, let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              response["product"] as? String == "phren-hook", let version = response["version"] as? String, version.utf8.count <= 64 else { return nil }
        return version
    }

    /// The computer's health: versions, store sync, last scheduled run, peers,
    /// approval push and the last canary. Peer probes stop at 5 seconds each.
    public static func hookHealth(host: LiveHost, privateKey: Data) async throws -> HookHealth {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                       request: GatewayRequest(path: "/v1/health/details", timeoutSeconds: 30))
        try Task.checkCancellation()
        return try HookHealth.decode(data)
    }

    /// Whether the computer's Hook can push approvals: `configured` is false
    /// until it has loaded an APNs key, even with this phone registered.
    public static func pushStatus(host: LiveHost, privateKey: Data) async throws -> HookHealth.Push {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                       request: GatewayRequest(path: "/v1/push/status", maximumResponseBytes: 4_096))
        return try JSONDecoder().decode(HookHealth.Push.self, from: data)
    }

    /// Runs the canary on the computer now; it launches and closes its own
    /// conductor and never types into an existing session.
    public static func runCanary(host: LiveHost, privateKey: Data) async throws -> HookHealth.Canary {
        try host.validate()
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                       request: GatewayRequest(path: "/v1/canary", body: Data("{}".utf8), timeoutSeconds: 240))
        try Task.checkCancellation()
        return try JSONDecoder().decode(HookHealth.Canary.self, from: data)
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
