import XCTest
@testable import PhrenKit

final class DeviceFlowAuthTests: XCTestCase {
    override func setUp() { StubURLProtocol.reset() }

    func testBuildConfigurationRejectsUnexpandedAndPlaceholderIDs() {
        for value in [nil, "", "  ", "$(PHREN_GITHUB_CLIENT_ID)", "YOUR_PUBLIC_OAUTH_CLIENT_ID", "REPLACE_WITH_ID"] as [String?] {
            XCTAssertNil(DeviceFlowAuth.configuredClientID(value))
        }
        XCTAssertEqual(DeviceFlowAuth.configuredClientID("  public-client-123  "), "public-client-123")
    }

    func testMissingConfigurationNeverRequestsAnInvalidDeviceCode() async {
        let auth = DeviceFlowAuth(clientID: "", session: StubURLProtocol.session())
        do { _ = try await auth.requestCode(); XCTFail("Missing client ID must fail locally") }
        catch { XCTAssertTrue(StubURLProtocol.requests.isEmpty) }
    }

    func testConfiguredFlowRequestsCodeAndHandlesTerminalAndPendingStates() async throws {
        StubURLProtocol.stub("/login/device/code", status: 200,
                             body: #"{"device_code":"device","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#)
        let responses: [(String, DeviceFlowAuth.PollState)] = [
            (#"{"error":"authorization_pending"}"#, .pending),
            (#"{"error":"slow_down"}"#, .slowDown(extraSeconds: 5)),
            (#"{"error":"expired_token"}"#, .expired),
            (#"{"error":"access_denied"}"#, .denied),
            (#"{"access_token":"test-only-token"}"#, .authorized(token: "test-only-token"))
        ]
        for (body, _) in responses { StubURLProtocol.stub("/login/oauth/access_token", status: 200, body: body) }
        let auth = DeviceFlowAuth(clientID: "public-client-123", session: StubURLProtocol.session())
        let code = try await auth.requestCode()
        XCTAssertEqual(code.userCode, "ABCD-EFGH")
        for (_, expected) in responses {
            let state = try await auth.poll(deviceCode: code.deviceCode)
            XCTAssertEqual(state, expected)
        }
        XCTAssertTrue(StubURLProtocol.requests.allSatisfy { $0.method == "POST" && $0.url.hasPrefix("https://github.com/login/") })
    }
}
