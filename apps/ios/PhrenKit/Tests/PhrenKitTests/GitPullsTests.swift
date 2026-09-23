import Foundation
import XCTest
@testable import PhrenKit

final class GitPullsTests: XCTestCase {
    func testReadsPullsAndTheirStates() throws {
        let data = Data(#"{"available":true,"pulls":[{"number":42,"title":"Changes: pulls","head":"changes/pulls","base":"main","author":"sam","url":"https://github.com/sam/phren/pull/42","draft":false,"state":"OPEN","updated":"2026-09-20T10:00:00Z"},{"number":7,"title":"Merged work","head":"feature","base":"main","author":"sam","url":"https://github.com/sam/phren/pull/7","draft":false,"state":"MERGED","updated":"2026-09-01T10:00:00Z"},{"number":9,"title":"Closed work","head":"old","base":"main","author":"sam","url":"https://github.com/sam/phren/pull/9","draft":false,"state":"CLOSED","updated":"2026-08-01T10:00:00Z"}]}"#.utf8)
        let pulls = try GitPulls.read(data)
        XCTAssertTrue(pulls.available)
        XCTAssertEqual(pulls.pulls.map(\.number), [42, 7, 9])
        XCTAssertEqual(pulls.pulls.map(\.state), [.open, .merged, .closed])
        XCTAssertEqual(pulls.pulls[0].head, "changes/pulls")
        XCTAssertEqual(pulls.pulls[0].base, "main")
        XCTAssertNotNil(pulls.pulls[0].updatedDate)
    }

    func testUnknownStateIsTolerated() throws {
        let data = Data(#"{"available":true,"pulls":[{"number":1,"title":"Future","head":"a","base":"main","author":"sam","url":"https://example.com/1","draft":false,"state":"queued","updated":"2026-09-20T10:00:00Z"}]}"#.utf8)
        XCTAssertEqual(try GitPulls.read(data).pulls[0].state, .unknown)
    }

    func testUnavailableIsAnEmptyList() throws {
        let pulls = try GitPulls.read(Data(#"{"available":false,"pulls":[]}"#.utf8))
        XCTAssertFalse(pulls.available)
        XCTAssertTrue(pulls.pulls.isEmpty)
    }

    func testCurrentBranchPullCarriesStateAndChecks() throws {
        let data = Data(#"{"available":true,"pulls":[],"branch":"feature/pr","current":{"number":51,"title":"Finish","url":"https://github.com/sam/phren/pull/51","head":"feature/pr","base":"main","draft":true,"state":"OPEN","checks":"failing"}}"#.utf8)
        let pulls = try GitPulls.read(data)
        XCTAssertEqual(pulls.branch, "feature/pr")
        let current = try XCTUnwrap(pulls.current)
        XCTAssertEqual(current.number, 51)
        XCTAssertEqual(current.state, .open)
        XCTAssertEqual(current.checks, .failing)
        XCTAssertEqual(current.stateLabel, "draft")
        // The card's cache round-trips it.
        let copy = try JSONDecoder().decode(GitPulls.Current.self, from: JSONEncoder().encode(current))
        XCTAssertEqual(copy, current)
    }

    func testOlderHookAndUnknownChecksAreTolerated() throws {
        let older = try GitPulls.read(Data(#"{"available":true,"pulls":[]}"#.utf8))
        XCTAssertNil(older.branch)
        XCTAssertNil(older.current)
        let merged = try GitPulls.read(Data(#"{"available":true,"pulls":[],"branch":"x","current":{"number":3,"url":"https://github.com/sam/phren/pull/3","head":"x","state":"MERGED","checks":"queued"}}"#.utf8))
        XCTAssertEqual(merged.current?.stateLabel, "merged")
        XCTAssertNil(merged.current?.checks)
    }

    func testPublishResultReadsSuccessAndVerbatimFailure() throws {
        let commit = try GitPublishResult.read(Data(#"{"ok":true,"sha":"abc","short":"abc","subject":"Lands","branch":"main"}"#.utf8))
        XCTAssertTrue(commit.ok)
        XCTAssertEqual(commit.subject, "Lands")
        let refused = try GitPublishResult.read(Data(#"{"ok":false,"output":"lint: 2 problems\n  src/a.ts:1  missing semicolon"}"#.utf8))
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.failureText, "lint: 2 problems\n  src/a.ts:1  missing semicolon")
        let pr = try GitPublishResult.read(Data(#"{"ok":true,"url":"https://github.com/sam/phren/pull/51","existing":true}"#.utf8))
        XCTAssertEqual(pr.pullURL?.absoluteString, "https://github.com/sam/phren/pull/51")
        XCTAssertNil(try GitPublishResult.read(Data(#"{"ok":true,"url":"javascript:alert(1)"}"#.utf8)).pullURL)
        let missing = try GitPublishResult.read(Data(#"{"ok":false,"reason":"missing","message":"The GitHub CLI (gh) is not installed on this computer."}"#.utf8))
        XCTAssertEqual(missing.failureText, "The GitHub CLI (gh) is not installed on this computer.")
    }

    func testOversizedPayloadIsRejected() {
        XCTAssertThrowsError(try GitPulls.read(Data(repeating: 32, count: 8_388_609)))
    }
}