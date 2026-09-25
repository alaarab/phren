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
}
