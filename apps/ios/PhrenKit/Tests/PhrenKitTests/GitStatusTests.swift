import Foundation
import XCTest
@testable import PhrenKit

final class GitStatusTests: XCTestCase {
    private let payload = #"""
    {"branch":"deepseek/compact-phone","upstream":"origin/deepseek/compact-phone",
     "ahead":1,"behind":0,"staged":1,"unstaged":2,"untracked":1,"additions":12,"deletions":3,
     "files":[
       {"path":"Sources/App.swift","status":"M","staged":false,"additions":4,"deletions":1},
       {"path":"Notes.md","status":"Q","staged":false,"additions":0,"deletions":0}
     ]}
    """#

    func testReadsCountsFilesAndToleratesAnUnknownStatus() throws {
        let status = try GitStatus.read(Data(payload.utf8))
        XCTAssertEqual(status.branch, "deepseek/compact-phone")
        XCTAssertEqual(status.upstream, "origin/deepseek/compact-phone")
        XCTAssertEqual(status.unstaged, 2)
        XCTAssertEqual(status.untracked, 1)
        XCTAssertEqual(status.additions, 12)
        XCTAssertEqual(status.deletions, 3)
        XCTAssertEqual(status.files.count, 2)
        XCTAssertEqual(status.files[0].path, "Sources/App.swift")
        XCTAssertEqual(GitStatus.kind(status.files[0].status), .modified)
        // A letter this build does not know must not fail the whole payload.
        XCTAssertEqual(GitStatus.kind(status.files[1].status), .unknown)
    }

    func testMissingCountsDecodeAsZero() throws {
        let minimal = #"{"branch":"main","files":[{"path":"a.md"}]}"#
        let status = try GitStatus.read(Data(minimal.utf8))
        XCTAssertEqual(status.ahead, 0)
        XCTAssertEqual(status.files.count, 1)
        XCTAssertFalse(status.files[0].staged)
    }

    func testRejectsOversizedPayload() {
        let data = Data(repeating: 0x20, count: 8_388_609)
        XCTAssertThrowsError(try GitStatus.read(data)) { error in
            XCTAssertEqual(error as? PhrenKitError, .validation("The repository status is too large."))
        }
    }
}