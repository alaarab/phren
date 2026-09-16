import XCTest
@testable import PhrenKit

final class ExternalLinkPolicyTests: XCTestCase {
    func testOnlyWebLinksWithAnUnambiguousHostAreEligibleForConfirmation() throws {
        for value in ["shortcuts://x", "phren://session", "file:///private/data", "javascript:alert(1)", "mailto:x@example.com", "https://trusted.example@evil.example/path", "https:/missing-host"] {
            XCTAssertNil(ExternalLinkPolicy.host(for: try XCTUnwrap(URL(string: value))), value)
        }
        XCTAssertEqual(ExternalLinkPolicy.host(for: try XCTUnwrap(URL(string: "https://example.com/docs?q=1"))), "example.com")
        XCTAssertEqual(ExternalLinkPolicy.host(for: try XCTUnwrap(URL(string: "http://localhost:8080/"))), "localhost")
    }

    func testGitHubDefaultsUseNoPersistentCacheOrCookies() {
        let session = GitHubClient.privateSession()
        defer { session.invalidateAndCancel() }
        XCTAssertNil(session.configuration.urlCache)
        XCTAssertEqual(session.configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertTrue(session.configuration.urlCredentialStorage?.allCredentials.isEmpty ?? true, "No saved bearer credentials are copied into this session")
    }
}
