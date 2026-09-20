import Foundation
import XCTest
@testable import PhrenKit

final class GitTreeTests: XCTestCase {
    func testReadsOneLevel() throws {
        let data = Data(#"{"path":"","entries":[{"name":"Sources","path":"Sources","kind":"dir","status":"changed"},{"name":"README.md","path":"README.md","kind":"file","status":"M"},{"name":"Notes.md","path":"Notes.md","kind":"file","status":"?"}]}"#.utf8)
        let tree = try GitWorkingTree.read(data)
        XCTAssertEqual(tree.path, "")
        XCTAssertEqual(tree.entries.map(\.kind), [.dir, .file, .file])
        XCTAssertEqual(tree.entries[0].status, .changed)
        XCTAssertEqual(tree.entries[1].status, .modified)
        XCTAssertEqual(tree.entries[2].status, .untracked)
        XCTAssertTrue(tree.entries[0].isDirectory)
    }

    func testMissingStatusIsNil() throws {
        let tree = try GitWorkingTree.read(Data(#"{"path":"Sources","entries":[{"name":"App.swift","path":"Sources/App.swift","kind":"file"}]}"#.utf8))
        XCTAssertNil(tree.entries[0].status)
    }

    func testUnknownKindAndStatusAreTolerated() throws {
        let data = Data(#"{"path":"","entries":[{"name":"link","path":"link","kind":"symlink","status":"Z"}]}"#.utf8)
        let tree = try GitWorkingTree.read(data)
        XCTAssertEqual(tree.entries[0].kind, .unknown)
        XCTAssertEqual(tree.entries[0].status, .unknown)
    }

    func testOversizedPayloadIsRejected() {
        XCTAssertThrowsError(try GitWorkingTree.read(Data(repeating: 32, count: 8_388_609)))
    }
}