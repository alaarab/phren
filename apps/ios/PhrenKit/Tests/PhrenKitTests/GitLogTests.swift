import XCTest
@testable import PhrenKit

final class GitLogTests: XCTestCase {
    private let sample = Data(#"""
    {
      "commits": [
        {
          "sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          "short": "a1b2c3d",
          "subject": "Wire the checkout flow",
          "author": "sam",
          "date": "2026-09-10T12:00:00Z",
          "refs": [
            { "name": "main", "kind": "head" },
            { "name": "origin/main", "kind": "remote" },
            { "name": "release/1.0", "kind": "local" },
            { "name": "v1.0.0", "kind": "tag" },
            { "name": "from-a-newer-hook", "kind": "worktree" }
          ],
          "parents": ["9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e"]
        }
      ],
      "uncommitted": { "files": 3, "additions": 590, "deletions": 231 }
    }
    """#.utf8)

    func testReadsCommitsRefsAndUncommittedSummary() throws {
        let log = try GitLog.read(sample)
        XCTAssertEqual(log.commits.count, 1)
        XCTAssertEqual(log.commits.first?.short, "a1b2c3d")
        XCTAssertEqual(log.commits.first?.author, "sam")
        XCTAssertEqual(log.commits.first?.parents.count, 1)
        XCTAssertEqual(log.uncommitted, GitLog.Uncommitted(files: 3, additions: 590, deletions: 231))
    }

    func testUnknownRefKindIsKeptGracefully() throws {
        let refs = try XCTUnwrap(try GitLog.read(sample).commits.first).refs
        XCTAssertEqual(refs.map(\.kind), [.head, .remote, .local, .tag, .unknown])
        XCTAssertEqual(refs.last?.name, "from-a-newer-hook")
    }

    func testRejectsOversizedPayload() {
        XCTAssertThrowsError(try GitLog.read(Data(count: 8_388_609))) { error in
            XCTAssertEqual(error as? PhrenKitError, .validation("The commit history is too large."))
        }
    }

    func testRejectsMalformedPayload() {
        XCTAssertThrowsError(try GitLog.read(Data(#"{"commits":"nope"}"#.utf8)))
    }

    func testCommitRelativeTimeUsesSessionFormatting() throws {
        let commit = try XCTUnwrap(try GitLog.read(sample).commits.first)
        let date = try XCTUnwrap(ISO8601Dates.parse(commit.date))
        XCTAssertEqual(commit.relativeTime, SessionRelativeTime.text(since: date, at: .now))
    }
}
