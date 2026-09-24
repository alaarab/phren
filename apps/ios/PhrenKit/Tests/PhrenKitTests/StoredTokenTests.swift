import XCTest
@testable import PhrenKit

final class StoredTokenTests: XCTestCase {
    func testPreviouslySavedTokenDecodesWithoutCachedIdentity() throws {
        let token = try JSONDecoder().decode(KeychainStore.StoredToken.self,
            from: Data(#"{"token":"fixture","kind":"pat"}"#.utf8))
        XCTAssertEqual(token.token, "fixture")
        XCTAssertEqual(token.kind, .pat)
        XCTAssertNil(token.user)
    }

    func testVerifiedIdentityStaysBoundToSavedCredential() throws {
        let token = KeychainStore.StoredToken(token: "fixture", kind: .oauth,
            user: GitHubUser(login: "sample", name: "Sample", avatarUrl: nil))
        let restored = try JSONDecoder().decode(KeychainStore.StoredToken.self, from: JSONEncoder().encode(token))
        XCTAssertEqual(restored, token)
        XCTAssertEqual(restored.user?.login, "sample")
    }
}
