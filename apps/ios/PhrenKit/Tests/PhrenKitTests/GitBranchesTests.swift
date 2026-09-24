import XCTest
@testable import PhrenKit

final class GitBranchesTests: XCTestCase {
    private let sample = Data(#"""
    {
      "current": "main",
      "local": [
        { "name": "main", "upstream": "origin/main", "ahead": 0, "behind": 0, "date": "2026-09-10T12:00:00Z" },
        { "name": "release/1.0", "upstream": "origin/release/1.0", "ahead": 2, "behind": 1, "date": "2026-09-09T12:00:00Z" },
        { "name": "spike/graph", "ahead": 0, "behind": 0, "date": "2026-09-08T12:00:00Z" }
      ],
      "remote": [
        { "name": "origin/main", "date": "2026-09-10T12:00:00Z" },
        { "name": "origin/release/1.0", "date": "2026-09-09T12:00:00Z" }
      ]
    }
    """#.utf8)

    func testReadsCurrentLocalAndRemoteBranches() throws {
        let branches = try GitBranches.read(sample)
        XCTAssertEqual(branches.current, "main")
        XCTAssertEqual(branches.local.map(\.name), ["main", "release/1.0", "spike/graph"])
        XCTAssertEqual(branches.remote.map(\.name), ["origin/main", "origin/release/1.0"])
        XCTAssertEqual(branches.local.first?.upstream, "origin/main")
        XCTAssertNil(branches.local.last?.upstream)
    }

    func testTrackingIsOnlyShownWhenTheBranchMoved() throws {
        let branches = try GitBranches.read(sample)
        XCTAssertNil(branches.local[0].tracking)
        XCTAssertEqual(branches.local[1].tracking, "↑2 ↓1")
        XCTAssertNil(branches.local[2].tracking)
    }

    func testReadsNullCurrentForDetachedHead() throws {
        let branches = try GitBranches.read(Data(#"{"current":null,"local":[],"remote":[]}"#.utf8))
        XCTAssertNil(branches.current)
    }

    func testRejectsOversizedPayload() {
        XCTAssertThrowsError(try GitBranches.read(Data(count: 8_388_609))) { error in
            XCTAssertEqual(error as? PhrenKitError, .validation("The branch list is too large."))
        }
    }

}
