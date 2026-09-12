import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// GitHub OAuth Device Flow (https://docs.github.com/apps/oauth-apps device flow).
/// No client secret is needed or embedded — the OAuth App must have
/// "Device Flow" enabled in its settings (see apps/ios/README.md).
public actor DeviceFlowAuth {
    /// Supplied by the host app's build configuration; the reusable package
    /// contains no app registration or secret. PAT sign-in works without it.
    public static var defaultClientID: String {
        configuredClientID(Bundle.main.object(forInfoDictionaryKey: "PhrenGitHubClientID") as? String) ?? ""
    }

    /// Whether the owner has registered a real OAuth App and swapped in its
    /// client ID. While false, device-flow sign-in would 404 at GitHub, so
    /// callers should hide/disable that path and steer to PAT sign-in.
    public static var isConfigured: Bool { !defaultClientID.isEmpty }

    public static func configuredClientID(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty, !value.hasPrefix("REPLACE_WITH_"), !value.hasPrefix("YOUR_"),
              value.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil else { return nil }
        return value
    }

    /// `repo` is a classic scope — required for private store repos. OAuth
    /// apps cannot request fine-grained permissions.
    public static let scope = "repo"

    private let clientID: String
    private let session: URLSession

    public init(clientID: String = DeviceFlowAuth.defaultClientID, session: URLSession = .shared) {
        self.clientID = clientID
        self.session = session
    }

    public enum PollState: Sendable, Equatable {
        case authorized(token: String)
        case pending
        case slowDown(extraSeconds: Int)
        case expired
        case denied
    }

    private func post(_ url: String, params: [String: String]) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: url)!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = params
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0.value)" }
            .joined(separator: "&")
            .data(using: .utf8)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GitHubError.invalidResponse
        }
        return json
    }

    /// Step 1: request a device + user code to display.
    public func requestCode() async throws -> DeviceCodeResponse {
        guard Self.configuredClientID(clientID) != nil else {
            throw PhrenKitError.validation("GitHub sign-in isn't configured for this build.")
        }
        let json = try await post("https://github.com/login/device/code", params: [
            "client_id": clientID,
            "scope": Self.scope,
        ])
        let data = try JSONSerialization.data(withJSONObject: json)
        return try JSONDecoder().decode(DeviceCodeResponse.self, from: data)
    }

    /// Step 2: one poll of the token endpoint. The caller loops on the
    /// server-provided interval, honoring `slowDown` (+5s per the spec).
    public func poll(deviceCode: String) async throws -> PollState {
        let json = try await post("https://github.com/login/oauth/access_token", params: [
            "client_id": clientID,
            "device_code": deviceCode,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        ])
        if let token = json["access_token"] as? String {
            return .authorized(token: token)
        }
        switch json["error"] as? String {
        case "authorization_pending": return .pending
        case "slow_down": return .slowDown(extraSeconds: 5)
        case "expired_token": return .expired
        case "access_denied": return .denied
        default: throw GitHubError.invalidResponse
        }
    }

    /// Convenience: run the full poll loop until a terminal state.
    public func waitForAuthorization(_ code: DeviceCodeResponse) async throws -> PollState {
        var interval = TimeInterval(code.interval)
        let deadline = Date().addingTimeInterval(TimeInterval(code.expiresIn))
        while Date() < deadline {
            try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            switch try await poll(deviceCode: code.deviceCode) {
            case .authorized(let token): return .authorized(token: token)
            case .pending: continue
            case .slowDown(let extra): interval += TimeInterval(extra)
            case .expired: return .expired
            case .denied: return .denied
            }
        }
        return .expired
    }
}
