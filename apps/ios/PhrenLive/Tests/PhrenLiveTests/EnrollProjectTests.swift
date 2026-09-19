import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class EnrollProjectTests: XCTestCase {
    func testEnrollReplyDecodesProjectFolderAndStoreOutcome() throws {
        let pushed = try PhrenConnection.enrolledProject(from: Data(#"{"ok":true,"project":"alpha","directory":"/Users/me/Projects/alpha","cloned":true,"store":"pushed"}"#.utf8))
        XCTAssertEqual(pushed, .init(project: "alpha", directory: "/Users/me/Projects/alpha", cloned: true, store: "pushed", storeDetail: nil))
        XCTAssertTrue(pushed.pushed)
        let local = try PhrenConnection.enrolledProject(from: Data(#"{"ok":true,"project":"beta","directory":"/w/beta","store":"committed","storeDetail":"no remote configured"}"#.utf8))
        XCTAssertFalse(local.pushed); XCTAssertFalse(local.cloned); XCTAssertEqual(local.storeDetail, "no remote configured")
    }

    func testEnrollReplyRejectsBadNamesPathsAndErrors() {
        XCTAssertThrowsError(try PhrenConnection.enrolledProject(from: Data(#"{"ok":true,"project":"../etc","directory":"/w/x","store":"pushed"}"#.utf8)))
        XCTAssertThrowsError(try PhrenConnection.enrolledProject(from: Data(#"{"ok":true,"project":"alpha","directory":"relative","store":"pushed"}"#.utf8)))
        XCTAssertThrowsError(try PhrenConnection.enrolledProject(from: Data(#"{"error":"nope"}"#.utf8)))
    }

    func testEnrollRequestValidatesInputBeforeConnecting() async {
        let host = try! LiveHost(name: "mac", address: "127.0.0.1", port: 1, username: "u")
        let key = Data(repeating: 1, count: 32)
        await XCTAssertThrowsErrorAsync(try await PhrenConnection.enrollProject(host: host, privateKey: key, cloneURL: "ext::sh -c id"))
        await XCTAssertThrowsErrorAsync(try await PhrenConnection.enrollProject(host: host, privateKey: key, cloneURL: "/local/path"))
        await XCTAssertThrowsErrorAsync(try await PhrenConnection.enrollProject(host: host, privateKey: key, directory: "relative/path"))
        await XCTAssertThrowsErrorAsync(try await PhrenConnection.enrollProject(host: host, privateKey: key))
    }
}

private func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do { _ = try await expression(); XCTFail("Expected an error", file: file, line: line) } catch { }
}
