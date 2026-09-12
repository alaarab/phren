import XCTest
@testable import PhrenKit

final class SecretScannerTests: XCTestCase {
    func testSlashJoinedPathsAndIdentifierChainsAreNotBase64Secrets() {
        // A skill mentioning its own folder was refused as "long base64 secret".
        XCTAssertNil(SecretScanner.scan("Run it from /Projects/AbletonExtensions/critic/mudpie before recording."))
        XCTAssertNil(SecretScanner.scan("addFooToBar/addFoosToBar/upsertBaz/addQuxToBaz/removeQux"))
        XCTAssertNil(SecretScanner.scan("Commit 3f2a9c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b landed."))
    }

    func testRealBase64BlobsStillTrip() {
        XCTAssertEqual(SecretScanner.scan("key: dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZSB3aXRoIGRpZ2l0cyAxMjM0NTY3ODkw+/=="), "long base64 secret")
        XCTAssertEqual(SecretScanner.scan("token ghp_" + String(repeating: "a", count: 36)), "GitHub personal access token")
    }
}
